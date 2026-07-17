import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { RELEASE_PACKAGE_FILES, assertReleaseMetadata } from "./amo-client.js";

const CANONICAL_VERSION_RE = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_UPDATE_MANIFEST_BYTES = 64 * 1024;
const MAX_RELEASE_METADATA_BYTES = 512 * 1024;
const MAX_SOURCE_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_SIGNED_XPI_BYTES = 64 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const desired = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(desired)) {
    throw new Error(`${label} has invalid schema keys: ${actual.join(", ")}`);
  }
}

function canonicalHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be one canonical HTTPS URL without credentials, query, or hash`);
  }
  return url;
}

function parseUtf8Json(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function requestFailure(error, label) {
  const cause = error?.cause;
  const code = typeof cause?.code === "string" && cause.code ? ` [${cause.code}]` : "";
  const detail = String(cause?.message ?? error?.message ?? error)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return new Error(`${label} request failed${code}: ${detail || "unknown network error"}`);
}

export function productionUpdateIdentity(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Production manifest must be an object");
  }
  const gecko = manifest.browser_specific_settings?.gecko;
  const addOnId = gecko?.id;
  const minimumVersion = gecko?.strict_min_version;
  if (typeof addOnId !== "string" || !addOnId) throw new Error("Production add-on ID is missing");
  if (typeof minimumVersion !== "string" || !minimumVersion) {
    throw new Error("Production minimum Firefox version is missing");
  }
  const manifestUrl = canonicalHttpsUrl(gecko?.update_url, "Production update manifest URL");
  if (manifestUrl.pathname !== "/updates.json") {
    throw new Error("Production update manifest URL must end at /updates.json");
  }
  return Object.freeze({ addOnId, manifestUrl, minimumVersion });
}

export function validateLiveUpdateDocument(document, identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("Live update identity must be an object");
  }
  assertExactKeys(document, ["addons"], "Live update manifest root");
  assertExactKeys(document.addons, [identity.addOnId], "Live update manifest add-ons");
  const addon = document.addons[identity.addOnId];
  assertExactKeys(addon, ["updates"], "Live update manifest add-on");
  if (!Array.isArray(addon.updates) || addon.updates.length !== 1) {
    throw new Error("Live update manifest must contain exactly one update entry");
  }

  const update = addon.updates[0];
  assertExactKeys(
    update,
    ["applications", "update_hash", "update_link", "version"],
    "Live update manifest entry",
  );
  assertExactKeys(update.applications, ["gecko"], "Live update manifest applications");
  assertExactKeys(
    update.applications.gecko,
    ["strict_min_version"],
    "Live update manifest Gecko application",
  );
  if (!CANONICAL_VERSION_RE.test(String(update.version ?? ""))) {
    throw new Error("Live update version is not canonical Semantic Versioning");
  }
  if (update.applications.gecko.strict_min_version !== identity.minimumVersion) {
    throw new Error("Live update minimum Firefox version does not match the production manifest");
  }

  const hashMatch = /^sha256:([a-f0-9]{64})$/.exec(String(update.update_hash ?? ""));
  if (!hashMatch || !SHA256_RE.test(hashMatch[1])) {
    throw new Error("Live update signed-XPI hash is invalid");
  }
  const updateUrl = canonicalHttpsUrl(update.update_link, "Live signed-XPI URL");
  if (updateUrl.origin !== identity.manifestUrl.origin) {
    throw new Error("Live signed-XPI URL must use the production update origin");
  }
  const expectedPath = `/releases/${update.version}/chzzk-${update.version}-signed.xpi`;
  if (updateUrl.pathname !== expectedPath) {
    throw new Error("Live signed-XPI URL is not canonical for the advertised version");
  }

  return Object.freeze({
    expectedSha256: hashMatch[1],
    signedXpiUrl: updateUrl,
    version: update.version,
  });
}

function releaseAssetIdentity(identity, version) {
  const releaseRoot = new URL(`/releases/${version}/`, identity.manifestUrl.origin);
  return Object.freeze({
    metadataUrl: new URL(`chzzk-${version}-release-metadata.json`, releaseRoot),
    sourceArchiveUrl: new URL(`chzzk-${version}.zip`, releaseRoot),
  });
}

function validateReleaseMetadata(metadata, identity, update, sourceArchiveUrl) {
  assertReleaseMetadata(metadata);
  if (
    metadata.version !== update.version ||
    metadata.addOnId !== identity.addOnId ||
    metadata.strictMinVersion !== identity.minimumVersion ||
    metadata.updateManifestUrl !== identity.manifestUrl.toString()
  ) {
    throw new Error("Live release metadata identity does not match updates.json and manifest.json");
  }
  if (metadata.sourceArchive.name !== sourceArchiveUrl.pathname.split("/").at(-1)) {
    throw new Error("Live release metadata source archive name is not canonical");
  }
  const recordedPaths = metadata.files.map((file) => file.path).sort();
  const expectedPaths = [...RELEASE_PACKAGE_FILES].sort();
  if (JSON.stringify(recordedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Live release metadata runtime file list is not canonical");
  }
  return metadata;
}

export async function readBoundedResponse(
  response,
  { expectedMediaType = null, expectedMediaTypes = null, label, maxBytes },
) {
  if (!response?.ok) {
    throw new Error(`${label} returned HTTP ${response?.status ?? "unknown"}`);
  }
  const mediaType = String(response.headers?.get?.("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const acceptedMediaTypes = expectedMediaTypes ?? [expectedMediaType];
  if (
    !Array.isArray(acceptedMediaTypes) ||
    acceptedMediaTypes.length === 0 ||
    !acceptedMediaTypes.includes(mediaType)
  ) {
    throw new Error(`${label} returned unexpected Content-Type ${mediaType || "(missing)"}`);
  }
  const rawLength = response.headers?.get?.("content-length");
  if (rawLength !== null && rawLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) {
      await response.body?.cancel?.();
      throw new Error(`${label} returned an invalid Content-Length`);
    }
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxBytes) {
      await response.body?.cancel?.();
      throw new Error(`${label} exceeded its size limit`);
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error(`${label} did not provide a readable body`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await reader.read();
      if (done) {
        streamComplete = true;
        continue;
      }
      if (!(value instanceof Uint8Array)) throw new Error(`${label} returned an invalid body chunk`);
      totalBytes += value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeded its size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes <= 0) throw new Error(`${label} returned an empty body`);
  return Buffer.concat(chunks, totalBytes);
}

async function fetchBounded(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      headers: { "user-agent": "CHZZK-live-update-health/2" },
      redirect: "error",
    });
  } catch (error) {
    throw requestFailure(error, options.label);
  }
  return readBoundedResponse(response, options);
}

export async function checkLiveUpdate({ fetchImpl = fetch, productionManifest }) {
  const identity = productionUpdateIdentity(productionManifest);
  const manifestBytes = await fetchBounded(fetchImpl, identity.manifestUrl, {
    expectedMediaType: "application/json",
    label: "Live update manifest",
    maxBytes: MAX_UPDATE_MANIFEST_BYTES,
  });
  const document = parseUtf8Json(manifestBytes, "Live update manifest");
  const update = validateLiveUpdateDocument(document, identity);
  const releaseAssets = releaseAssetIdentity(identity, update.version);

  const metadataBytes = await fetchBounded(fetchImpl, releaseAssets.metadataUrl, {
    expectedMediaType: "application/json",
    label: "Live release metadata",
    maxBytes: MAX_RELEASE_METADATA_BYTES,
  });
  const metadata = validateReleaseMetadata(
    parseUtf8Json(metadataBytes, "Live release metadata"),
    identity,
    update,
    releaseAssets.sourceArchiveUrl,
  );

  const sourceArchiveBytes = await fetchBounded(fetchImpl, releaseAssets.sourceArchiveUrl, {
    expectedMediaTypes: ["application/octet-stream", "application/zip"],
    label: "Live source archive",
    maxBytes: MAX_SOURCE_ARCHIVE_BYTES,
  });
  if (
    sourceArchiveBytes.length !== metadata.sourceArchive.size ||
    sha256(sourceArchiveBytes) !== metadata.sourceArchive.sha256
  ) {
    throw new Error("Live source archive does not match release metadata");
  }

  const signedXpiBytes = await fetchBounded(fetchImpl, update.signedXpiUrl, {
    expectedMediaType: "application/x-xpinstall",
    label: "Live signed XPI",
    maxBytes: MAX_SIGNED_XPI_BYTES,
  });
  const actualSignedSha256 = sha256(signedXpiBytes);
  if (actualSignedSha256 !== update.expectedSha256) {
    throw new Error("Live signed XPI does not match updates.json SHA-256");
  }

  return Object.freeze({
    assets: Object.freeze({
      metadata,
      metadataBytes,
      signedXpiBytes,
      sourceArchiveBytes,
    }),
    manifestBytes: manifestBytes.length,
    metadataBytes: metadataBytes.length,
    signedXpiBytes: signedXpiBytes.length,
    signedXpiSha256: actualSignedSha256,
    signedXpiUrl: update.signedXpiUrl.toString(),
    sourceArchiveBytes: sourceArchiveBytes.length,
    sourceArchiveSha256: metadata.sourceArchive.sha256,
    sourceArchiveUrl: releaseAssets.sourceArchiveUrl.toString(),
    version: update.version,
  });
}
