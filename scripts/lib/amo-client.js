import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const AMO_API_ROOT = "https://addons.mozilla.org/api/v5/";
const AMO_DOWNLOAD_DOMAIN = "addons.mozilla.org";
const MAX_SIGNED_XPI_BYTES = 100 * 1024 * 1024;
const MAX_SIGNED_XPI_REDIRECT_HOPS = 5;
const MAX_WAIT_MS = 10 * 60 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/;

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

async function fetchSignedXpi(fetchImpl, initialUrl, deadline) {
  let currentUrl = String(initialUrl);
  for (let hop = 0; hop <= MAX_SIGNED_XPI_REDIRECT_HOPS; hop += 1) {
    if (!isAllowedAmoDownloadUrl(currentUrl)) {
      throw new Error("AMO signed download left the trusted download domain");
    }
    const response = await fetchWithDeadline(
      fetchImpl,
      currentUrl,
      {
        headers: new Headers({ Accept: "application/octet-stream" }),
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
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response?.ok) {
      if (status === 404) {
        cancelResponseBody(response);
        const error = new Error("AMO signed download is not available yet");
        error.code = "AMO_SIGNED_DOWNLOAD_NOT_READY";
        throw error;
      }
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

function atomicWrite(path, bytes) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

async function readJsonResponse(response, operation, deadline) {
  if (!response?.ok) throw new Error(`AMO ${operation} failed with HTTP ${response?.status ?? "unknown"}`);
  try {
    return await withDeadline(response.json(), deadline, `${operation} response`, () =>
      cancelResponseBody(response),
    );
  } catch (error) {
    if (error.code === "AMO_TIMEOUT") throw error;
    throw new Error(`AMO ${operation} returned invalid JSON`);
  }
}

function validateMetadata(metadata, sourceArchivePath) {
  if (!metadata || metadata.schemaVersion !== 1) throw new Error("Unsupported release metadata schema");
  if (!/^\d+\.\d+\.\d+$/.test(String(metadata.version ?? ""))) throw new Error("Invalid release version");
  if (typeof metadata.addOnId !== "string" || !metadata.addOnId) throw new Error("Invalid Firefox add-on ID");
  if (!SHA256_RE.test(String(metadata.sourceArchive?.sha256 ?? ""))) {
    throw new Error("Invalid prepared archive digest");
  }
  if (metadata.sourceArchive.name !== basename(sourceArchivePath)) {
    throw new Error("Prepared archive name does not match release metadata");
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
  if (!outputDir || !sourceArchivePath) throw new Error("outputDir and sourceArchivePath are required");
  validateMetadata(metadata, sourceArchivePath);
  assertRegularPrivateInput(sourceArchivePath);
  const sourceBytes = readFileSync(sourceArchivePath);
  if (sha256(sourceBytes) !== metadata.sourceArchive.sha256) {
    throw new Error("Prepared archive digest does not match release metadata");
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
  while (!signedResponse) {
    try {
      signedResponse = await fetchSignedXpi(fetchImpl, downloadUrl, deadline);
    } catch (error) {
      if (error.code !== "AMO_SIGNED_DOWNLOAD_NOT_READY") throw error;
      await withDeadline(sleep(pollIntervalMs), deadline, "signed download availability");
    }
  }
  const signedBytes = Buffer.from(
    await withDeadline(signedResponse.arrayBuffer(), deadline, "signed download response", () =>
      cancelResponseBody(signedResponse),
    ),
  );
  if (signedBytes.length <= 0 || signedBytes.length > MAX_SIGNED_XPI_BYTES) {
    throw new Error("AMO signed XPI size is invalid");
  }
  const signedXpiPath = join(outputDir, `chzzk-${metadata.version}-signed.xpi`);
  atomicWrite(signedXpiPath, signedBytes);
  return { signedXpiPath, signedXpiSha256: sha256(signedBytes) };
}
