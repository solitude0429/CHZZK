import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";

import { assertCanonicalReleaseVersion } from "./release-version.js";

const AMO_API_ROOT = "https://addons.mozilla.org/api/v5/";
const AMO_DOWNLOAD_DOMAIN = "addons.mozilla.org";
export const MAX_SIGNED_XPI_BYTES = 16 * 1024 * 1024;
const MAX_SIGNED_XPI_DOWNLOAD_ATTEMPTS = 60;
const MAX_SIGNED_XPI_REDIRECT_HOPS = 5;
const MAX_WAIT_MS = 10 * 60 * 1000;
export const MAX_AMO_JSON_BYTES = 1024 * 1024;
export const MAX_AMO_JSON_DEPTH = 64;
export const MAX_AMO_POLL_INTERVAL_MS = 60 * 1000;
export const MIN_AMO_POLL_INTERVAL_MS = 100;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_DIGEST_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const STRICT_MIN_VERSION_RE = /^\d+(?:\.\d+){1,3}$/;

export const RELEASE_ADD_ON_ID = "chzzk@solitude0429.local";
export const RELEASE_SOURCE_REPOSITORY = "solitude0429/CHZZK";
export const RELEASE_UPDATE_MANIFEST_URL = "https://chzzk-updates.alpha-apple.dedyn.io/updates.json";
export const RELEASE_PACKAGE_FILES = Object.freeze([
  "background.js",
  "diagnostics.html",
  "diagnostics.js",
  "icon-32.png",
  "icon-48.png",
  "icon-96.png",
  "icon.png",
  "manifest.json",
  "site-observer.js",
]);

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const canonicalKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(canonicalKeys)) {
    throw new Error(`${label} has invalid schema keys: ${actualKeys.join(", ")}`);
  }
}

function assertSafePositiveSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function assertReleaseMetadata(metadata) {
  assertExactKeys(
    metadata,
    [
      "addOnId",
      "files",
      "schemaVersion",
      "sourceArchive",
      "sourceDigest",
      "sourceRepository",
      "strictMinVersion",
      "updateManifestUrl",
      "version",
    ],
    "Release metadata",
  );
  if (metadata.schemaVersion !== 1) throw new Error("Unsupported release metadata schema");
  assertCanonicalReleaseVersion(metadata.version, "Release metadata version");
  if (metadata.addOnId !== RELEASE_ADD_ON_ID) throw new Error("Release add-on ID is not canonical");
  if (metadata.sourceRepository !== RELEASE_SOURCE_REPOSITORY) {
    throw new Error("Release source repository is not canonical");
  }
  if (metadata.updateManifestUrl !== RELEASE_UPDATE_MANIFEST_URL) {
    throw new Error("Release update manifest URL is not canonical");
  }
  if (!STRICT_MIN_VERSION_RE.test(metadata.strictMinVersion)) {
    throw new Error("Invalid release strict minimum Firefox version");
  }
  if (!SOURCE_DIGEST_RE.test(metadata.sourceDigest)) {
    throw new Error("Invalid release source digest");
  }

  assertExactKeys(metadata.sourceArchive, ["name", "sha256", "size"], "Release source archive");
  if (metadata.sourceArchive.name !== `chzzk-${metadata.version}.zip`) {
    throw new Error("Release source archive name is not canonical");
  }
  if (!SHA256_RE.test(metadata.sourceArchive.sha256)) {
    throw new Error("Invalid release source archive digest");
  }
  assertSafePositiveSize(metadata.sourceArchive.size, "Release source archive size");

  if (!Array.isArray(metadata.files) || metadata.files.length !== RELEASE_PACKAGE_FILES.length) {
    throw new Error("Release metadata file list does not match the runtime allowlist");
  }
  const filesByPath = new Map();
  for (const [index, file] of metadata.files.entries()) {
    assertExactKeys(file, ["path", "sha256", "size"], `Release metadata file ${index}`);
    if (typeof file.path !== "string" || filesByPath.has(file.path)) {
      throw new Error("Release metadata contains a duplicate or invalid file path");
    }
    if (!SHA256_RE.test(file.sha256)) throw new Error(`Invalid release file digest: ${file.path}`);
    assertSafePositiveSize(file.size, `Release file size: ${file.path}`);
    filesByPath.set(file.path, file);
  }
  const actualPaths = [...filesByPath.keys()].sort();
  const expectedPaths = [...RELEASE_PACKAGE_FILES].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Release metadata file list does not match the runtime allowlist");
  }
  return metadata;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function makeJwt(apiKey, apiSecret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encodedHeader = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64Url(
    JSON.stringify({ exp: issuedAt + 60, iat: issuedAt, iss: apiKey, jti: randomUUID() }),
  );
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", apiSecret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function validateCredential(name, value) {
  if (typeof value !== "string" || value.length < 8 || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} is missing or malformed`);
  }
}

function assertRegularPrivateInput(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Signing input must be a regular file: ${path}`);
  if (stat.size <= 0 || stat.size > MAX_SIGNED_XPI_BYTES)
    throw new Error(`Signing input size is invalid: ${path}`);
  return stat;
}

function isAllowedAmoApiUrl(value) {
  try {
    const url = new URL(value);
    const apiRoot = new URL(AMO_API_ROOT);
    return (
      url.protocol === "https:" &&
      url.origin === apiRoot.origin &&
      url.pathname.startsWith(apiRoot.pathname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isAllowedAmoDownloadUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (hostname === AMO_DOWNLOAD_DOMAIN || hostname.endsWith(`.${AMO_DOWNLOAD_DOMAIN}`))
    );
  } catch {
    return false;
  }
}

function isAllowedAuthenticatedAmoDownloadUrl(value) {
  try {
    const url = new URL(value);
    return (
      isAllowedAmoDownloadUrl(url) &&
      url.hostname.toLowerCase() === AMO_DOWNLOAD_DOMAIN &&
      (url.pathname.startsWith("/firefox/downloads/file/") || url.pathname.startsWith("/downloads/file/"))
    );
  } catch {
    return false;
  }
}

function sleep(delayMs) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function timeoutError(operation) {
  const error = new Error(`AMO ${operation} timed out`);
  error.code = "AMO_TIMEOUT";
  return error;
}

async function withDeadline(operationPromise, deadline, operation, onTimeout = () => {}) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw timeoutError(operation);
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(operationPromise),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(timeoutError(operation));
          try {
            onTimeout();
          } catch {
            // The deadline error remains authoritative.
          }
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithDeadline(fetchImpl, url, options, deadline, operation) {
  const controller = new AbortController();
  return withDeadline(
    Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal })),
    deadline,
    operation,
    () => controller.abort(),
  );
}

function cancelResponseBody(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation && typeof cancellation.catch === "function") cancellation.catch(() => {});
  } catch {
    // The deadline error remains authoritative.
  }
}

function cancelReader(reader) {
  try {
    const cancellation = reader?.cancel?.();
    if (cancellation && typeof cancellation.catch === "function") cancellation.catch(() => {});
  } catch {
    // Best-effort cancellation only; the bounded-read error remains authoritative.
  }
}

function responseContentLength(response, operation, maxBytes) {
  const rawValue = response?.headers?.get?.("content-length");
  if (rawValue == null) return null;
  const value = String(rawValue).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    cancelResponseBody(response);
    throw new Error(`AMO ${operation} response has an invalid Content-Length`);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    cancelResponseBody(response);
    throw new Error(`AMO ${operation} response size limit exceeded`);
  }
  return length;
}

async function readBoundedResponseBytes(response, { deadline, maxBytes, operation }) {
  responseContentLength(response, operation, maxBytes);
  if (!response?.body || typeof response.body.getReader !== "function") {
    cancelResponseBody(response);
    throw new Error(`AMO ${operation} response body is not a readable stream`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let cancelled = false;
  let totalBytes = 0;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    cancelReader(reader);
  };
  try {
    let streamComplete = false;
    while (!streamComplete) {
      const result = await withDeadline(reader.read(), deadline, `${operation} response`, () => cancel());
      if (!result || typeof result.done !== "boolean") {
        throw new Error(`AMO ${operation} response stream is invalid`);
      }
      if (result.done) {
        streamComplete = true;
        continue;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new Error(`AMO ${operation} response stream returned an invalid chunk`);
      }
      totalBytes += result.value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
        throw new Error(`AMO ${operation} response size limit exceeded`);
      }
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // A cancelled or failed stream may already have released its lock.
    }
  }
  return Buffer.concat(chunks, totalBytes);
}

function assertJsonNesting(value, operation) {
  const pending = [{ depth: 0, value }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > MAX_AMO_JSON_DEPTH) {
      throw new Error(`AMO ${operation} JSON response exceeds the nesting limit`);
    }
    if (!current.value || typeof current.value !== "object") continue;
    for (const child of Array.isArray(current.value) ? current.value : Object.values(current.value)) {
      pending.push({ depth: current.depth + 1, value: child });
    }
  }
}

async function fetchSignedXpi(fetchImpl, initialUrl, deadline, authorization) {
  const approvedUrl = String(initialUrl);
  let currentUrl = approvedUrl;
  for (let hop = 0; hop <= MAX_SIGNED_XPI_REDIRECT_HOPS; hop += 1) {
    if (!isAllowedAmoDownloadUrl(currentUrl)) {
      throw new Error("AMO signed download left the trusted download domain");
    }
    const headers = new Headers({ Accept: "application/octet-stream" });
    if (hop === 0) {
      if (!isAllowedAuthenticatedAmoDownloadUrl(currentUrl)) {
        throw new Error("AMO signed download URL cannot receive developer authorization");
      }
      headers.set("Authorization", authorization);
    }
    const response = await fetchWithDeadline(
      fetchImpl,
      currentUrl,
      {
        headers,
        method: "GET",
        redirect: "manual",
      },
      deadline,
      "signed download",
    );
    const status = Number(response?.status ?? 0);
    if (status >= 300 && status < 400) {
      if (hop >= MAX_SIGNED_XPI_REDIRECT_HOPS) {
        throw new Error("AMO signed download exceeded the redirect limit");
      }
      const location = response?.headers?.get?.("location");
      if (!location) throw new Error("AMO signed download redirect omitted its location");
      cancelResponseBody(response);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response?.ok) {
      if (hop === 0 && currentUrl === approvedUrl && status === 404) {
        cancelResponseBody(response);
        const error = new Error("AMO approved signed download is not available yet");
        error.code = "AMO_SIGNED_DOWNLOAD_NOT_READY";
        throw error;
      }
      cancelResponseBody(response);
      throw new Error(`AMO signed download failed with HTTP ${response?.status ?? "unknown"}`);
    }
    const finalUrl = typeof response.url === "string" && response.url ? response.url : currentUrl;
    if (!isAllowedAmoDownloadUrl(finalUrl)) {
      throw new Error("AMO signed download left the trusted download domain");
    }
    return response;
  }
  throw new Error("AMO signed download exceeded the redirect limit");
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(path, bytes) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

async function readJsonResponse(response, operation, deadline) {
  if (!response?.ok) {
    cancelResponseBody(response);
    throw new Error(`AMO ${operation} failed with HTTP ${response?.status ?? "unknown"}`);
  }
  const bytes = await readBoundedResponseBytes(response, {
    deadline,
    maxBytes: MAX_AMO_JSON_BYTES,
    operation: `${operation} JSON`,
  });
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error(`AMO ${operation} returned invalid JSON`);
  }
  assertJsonNesting(value, operation);
  return value;
}

function validateMetadata(metadata, sourceArchivePath) {
  assertReleaseMetadata(metadata);
  const expectedSourceArchiveName = `chzzk-${metadata.version}.zip`;
  if (
    metadata.sourceArchive.name !== expectedSourceArchiveName ||
    basename(sourceArchivePath) !== expectedSourceArchiveName
  ) {
    throw new Error("Prepared archive name is not canonical for the release version");
  }
}

function versionListUrl(metadata) {
  const url = new URL(`${AMO_API_ROOT}addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/`);
  url.searchParams.set("filter", "all_with_unlisted");
  return url;
}

function assertReusableUnlistedVersion(version, metadata) {
  if (!version || typeof version !== "object") throw new Error("AMO returned an invalid existing version");
  if (version.version !== metadata.version)
    throw new Error("AMO existing version does not match release metadata");
  if (version.channel !== "unlisted") throw new Error("AMO existing version is not unlisted");
  if (!/^\d+$/.test(String(version.id ?? ""))) throw new Error("AMO existing version is missing a valid ID");
  return version;
}

function versionIdentity(version) {
  const nested = version?.version && typeof version.version === "object" ? version.version : null;
  return {
    channel: version?.channel ?? nested?.channel,
    file: version?.file ?? nested?.file,
    id: version?.id ?? nested?.id,
    version: typeof version?.version === "string" ? version.version : nested?.version,
  };
}

function assertSubmittedVersion(version, metadata) {
  if (!version || typeof version !== "object") throw new Error("AMO returned an invalid submitted version");
  const identity = versionIdentity(version);
  if (identity.version !== metadata.version) {
    throw new Error("AMO submitted version does not match release metadata");
  }
  if (identity.channel != null && identity.channel !== "unlisted") {
    throw new Error("AMO submitted version is not unlisted");
  }
  if (!/^\d+$/.test(String(identity.id ?? ""))) {
    throw new Error("AMO version response omitted a valid version ID");
  }
  return identity;
}

function assertApprovedUnlistedVersion(version, metadata, expectedVersionId) {
  if (!version || typeof version !== "object") throw new Error("AMO returned an invalid approved version");
  const identity = versionIdentity(version);
  if (identity.version !== metadata.version) {
    throw new Error("AMO approved version does not match release metadata");
  }
  if (identity.channel !== "unlisted") throw new Error("AMO approved version is not unlisted");
  if (String(identity.id ?? "") !== String(expectedVersionId)) {
    throw new Error("AMO approved version ID changed during polling");
  }
  return identity;
}

async function findExistingUnlistedVersion({ authorizedFetch, deadline, metadata }) {
  let nextUrl = versionListUrl(metadata);
  const visited = new Set();
  let targetVersion = null;
  for (let page = 0; page < 100 && nextUrl; page += 1) {
    const pageUrl = new URL(nextUrl);
    if (visited.has(pageUrl.href)) throw new Error("AMO version-list pagination loop detected");
    visited.add(pageUrl.href);

    const response = await readJsonResponse(
      await authorizedFetch(pageUrl, { method: "GET" }, "version-list lookup"),
      "version-list lookup",
      deadline,
    );
    if (!Array.isArray(response?.results)) {
      throw new Error("AMO version-list lookup returned an invalid result set");
    }
    const matches = response.results.filter((version) => version?.version === metadata.version);
    if (matches.length > 1) throw new Error("AMO returned duplicate target versions");
    if (matches.length === 1) {
      if (targetVersion) throw new Error("AMO returned duplicate target versions");
      targetVersion = assertReusableUnlistedVersion(matches[0], metadata);
    }

    if (response.next == null) return targetVersion;
    if (typeof response.next !== "string" || !response.next) {
      throw new Error("AMO version-list lookup returned an invalid next page");
    }
    nextUrl = new URL(response.next, pageUrl);
  }
  throw new Error("AMO version-list lookup exceeded the pagination limit");
}

export async function signPreparedAddon({
  apiKey,
  apiSecret,
  fetchImpl = globalThis.fetch,
  maxWaitMs = MAX_WAIT_MS,
  metadata,
  outputDir,
  pollIntervalMs = 5000,
  sourceArchivePath,
}) {
  validateCredential("AMO API key", apiKey);
  validateCredential("AMO API secret", apiSecret);
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is unavailable");
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > MAX_WAIT_MS) {
    throw new Error("AMO signing timeout is invalid");
  }
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < MIN_AMO_POLL_INTERVAL_MS ||
    pollIntervalMs > MAX_AMO_POLL_INTERVAL_MS
  ) {
    throw new Error("AMO poll interval is invalid");
  }
  if (!outputDir || !sourceArchivePath) throw new Error("outputDir and sourceArchivePath are required");
  validateMetadata(metadata, sourceArchivePath);
  assertRegularPrivateInput(sourceArchivePath);
  const sourceBytes = readFileSync(sourceArchivePath);
  if (
    sha256(sourceBytes) !== metadata.sourceArchive.sha256 ||
    sourceBytes.length !== metadata.sourceArchive.size
  ) {
    throw new Error("Prepared archive bytes do not match release metadata");
  }
  mkdirSync(outputDir, { mode: 0o700, recursive: true });
  const deadline = Date.now() + maxWaitMs;

  const authorizedFetch = (url, options = {}, operation = "API request") => {
    if (!isAllowedAmoApiUrl(url)) throw new Error("Refusing to send AMO authorization outside the API root");
    const headers = new Headers(options.headers ?? {});
    headers.set("Authorization", `JWT ${makeJwt(apiKey, apiSecret)}`);
    headers.set("Accept", "application/json");
    return fetchWithDeadline(fetchImpl, url, { ...options, headers, redirect: "error" }, deadline, operation);
  };

  const existingVersion = await findExistingUnlistedVersion({ authorizedFetch, deadline, metadata });
  let version = existingVersion;
  if (!version) {
    const uploadBody = new FormData();
    uploadBody.set("channel", "unlisted");
    uploadBody.set(
      "upload",
      new File([sourceBytes], metadata.sourceArchive.name, { type: "application/zip" }),
    );
    const upload = await readJsonResponse(
      await authorizedFetch(
        new URL("addons/upload/", AMO_API_ROOT),
        {
          method: "POST",
          body: uploadBody,
        },
        "upload",
      ),
      "upload",
      deadline,
    );
    if (typeof upload.uuid !== "string" || !upload.uuid) {
      throw new Error("AMO upload response omitted its UUID");
    }

    let validation;
    do {
      validation = await readJsonResponse(
        await authorizedFetch(
          new URL(`addons/upload/${encodeURIComponent(upload.uuid)}/`, AMO_API_ROOT),
          {},
          "validation",
        ),
        "validation",
        deadline,
      );
      if (!validation.processed) {
        await withDeadline(sleep(pollIntervalMs), deadline, "validation");
      }
    } while (!validation.processed);
    if (!validation.valid) throw new Error("AMO rejected the prepared extension archive");

    version = await readJsonResponse(
      await authorizedFetch(
        new URL(`addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/`, AMO_API_ROOT),
        {
          body: JSON.stringify({ upload: upload.uuid }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
        "submission",
      ),
      "submission",
      deadline,
    );
  }

  const initialIdentity = existingVersion
    ? versionIdentity(assertReusableUnlistedVersion(existingVersion, metadata))
    : assertSubmittedVersion(version, metadata);
  const versionId = initialIdentity.id;
  let downloadUrl =
    existingVersion &&
    initialIdentity.file?.status === "public" &&
    typeof initialIdentity.file.url === "string"
      ? initialIdentity.file.url
      : undefined;
  while (!downloadUrl) {
    const approvedVersion = await readJsonResponse(
      await authorizedFetch(
        new URL(
          `addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/${encodeURIComponent(versionId)}/`,
          AMO_API_ROOT,
        ),
        {},
        "approval polling",
      ),
      "approval polling",
      deadline,
    );
    const approvedIdentity = assertApprovedUnlistedVersion(approvedVersion, metadata, versionId);
    if (approvedIdentity.file?.status === "public" && typeof approvedIdentity.file.url === "string") {
      downloadUrl = approvedIdentity.file.url;
      break;
    }
    await withDeadline(sleep(pollIntervalMs), deadline, "signing approval");
  }
  if (!isAllowedAmoDownloadUrl(downloadUrl)) throw new Error("AMO returned an untrusted signed download URL");

  let signedResponse;
  for (let attempt = 1; attempt <= MAX_SIGNED_XPI_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      signedResponse = await fetchSignedXpi(
        fetchImpl,
        downloadUrl,
        deadline,
        `JWT ${makeJwt(apiKey, apiSecret)}`,
      );
      break;
    } catch (error) {
      if (error.code !== "AMO_SIGNED_DOWNLOAD_NOT_READY") throw error;
      if (attempt === MAX_SIGNED_XPI_DOWNLOAD_ATTEMPTS) {
        throw new Error("AMO signed download exceeded the bounded 404 retry limit");
      }
      await withDeadline(sleep(pollIntervalMs), deadline, "signed download availability");
    }
  }
  if (!signedResponse) throw new Error("AMO signed download did not return a response");
  const signedBytes = await readBoundedResponseBytes(signedResponse, {
    deadline,
    maxBytes: MAX_SIGNED_XPI_BYTES,
    operation: "signed download",
  });
  if (signedBytes.length <= 0 || signedBytes.length > MAX_SIGNED_XPI_BYTES) {
    throw new Error("AMO signed XPI size is invalid");
  }
  const signedXpiPath = join(outputDir, `chzzk-${metadata.version}-signed.xpi`);
  atomicWrite(signedXpiPath, signedBytes);
  return { signedXpiPath, signedXpiSha256: sha256(signedBytes) };
}
