import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const AMO_API_ROOT = "https://addons.mozilla.org/api/v5/";
const AMO_DOWNLOAD_DOMAIN = "addons.mozilla.org";
const MAX_SIGNED_XPI_BYTES = 100 * 1024 * 1024;
const MAX_SIGNED_XPI_REDIRECT_HOPS = 5;
const MAX_WAIT_MS = 20 * 60 * 1000;
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

async function fetchSignedXpi(fetchImpl, initialUrl) {
  let currentUrl = String(initialUrl);
  for (let hop = 0; hop <= MAX_SIGNED_XPI_REDIRECT_HOPS; hop += 1) {
    if (!isAllowedAmoDownloadUrl(currentUrl)) {
      throw new Error("AMO signed download left the trusted download domain");
    }
    const response = await fetchImpl(currentUrl, {
      headers: new Headers({ Accept: "application/octet-stream" }),
      method: "GET",
      redirect: "manual",
    });
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

async function readJsonResponse(response, operation) {
  if (!response?.ok) throw new Error(`AMO ${operation} failed with HTTP ${response?.status ?? "unknown"}`);
  try {
    return await response.json();
  } catch {
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

export async function signPreparedAddon({
  apiKey,
  apiSecret,
  fetchImpl = globalThis.fetch,
  metadata,
  outputDir,
  pollIntervalMs = 5000,
  sourceArchivePath,
}) {
  validateCredential("AMO API key", apiKey);
  validateCredential("AMO API secret", apiSecret);
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is unavailable");
  if (!outputDir || !sourceArchivePath) throw new Error("outputDir and sourceArchivePath are required");
  validateMetadata(metadata, sourceArchivePath);
  assertRegularPrivateInput(sourceArchivePath);
  const sourceBytes = readFileSync(sourceArchivePath);
  if (sha256(sourceBytes) !== metadata.sourceArchive.sha256) {
    throw new Error("Prepared archive digest does not match release metadata");
  }
  mkdirSync(outputDir, { mode: 0o700, recursive: true });

  const authorizedFetch = (url, options = {}) => {
    if (!isAllowedAmoApiUrl(url)) throw new Error("Refusing to send AMO authorization outside the API root");
    const headers = new Headers(options.headers ?? {});
    headers.set("Authorization", `JWT ${makeJwt(apiKey, apiSecret)}`);
    headers.set("Accept", "application/json");
    return fetchImpl(url, { ...options, headers, redirect: "error" });
  };

  const uploadBody = new FormData();
  uploadBody.set("channel", "unlisted");
  uploadBody.set("upload", new File([sourceBytes], metadata.sourceArchive.name, { type: "application/zip" }));
  const upload = await readJsonResponse(
    await authorizedFetch(new URL("addons/upload/", AMO_API_ROOT), { method: "POST", body: uploadBody }),
    "upload",
  );
  if (typeof upload.uuid !== "string" || !upload.uuid)
    throw new Error("AMO upload response omitted its UUID");

  const validationDeadline = Date.now() + MAX_WAIT_MS;
  let validation;
  do {
    if (Date.now() > validationDeadline) throw new Error("AMO validation timed out");
    validation = await readJsonResponse(
      await authorizedFetch(new URL(`addons/upload/${encodeURIComponent(upload.uuid)}/`, AMO_API_ROOT)),
      "validation",
    );
    if (!validation.processed) await sleep(pollIntervalMs);
  } while (!validation.processed);
  if (!validation.valid) throw new Error("AMO rejected the prepared extension archive");

  const submission = await readJsonResponse(
    await authorizedFetch(new URL(`addons/addon/${encodeURIComponent(metadata.addOnId)}/`, AMO_API_ROOT), {
      body: JSON.stringify({ version: { upload: upload.uuid } }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    }),
    "submission",
  );
  const versionId = submission?.version?.id;
  if (!Number.isSafeInteger(versionId) && typeof versionId !== "string") {
    throw new Error("AMO submission response omitted its version ID");
  }

  const approvalDeadline = Date.now() + MAX_WAIT_MS;
  let downloadUrl;
  do {
    if (Date.now() > approvalDeadline) throw new Error("AMO signing approval timed out");
    const version = await readJsonResponse(
      await authorizedFetch(
        new URL(
          `addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/${encodeURIComponent(versionId)}/`,
          AMO_API_ROOT,
        ),
      ),
      "approval polling",
    );
    if (version?.file?.status === "public" && typeof version.file.url === "string") {
      downloadUrl = version.file.url;
      break;
    }
    await sleep(pollIntervalMs);
  } while (!downloadUrl);
  if (!isAllowedAmoDownloadUrl(downloadUrl)) throw new Error("AMO returned an untrusted signed download URL");

  const signedResponse = await fetchSignedXpi(fetchImpl, downloadUrl);
  const signedBytes = Buffer.from(await signedResponse.arrayBuffer());
  if (signedBytes.length <= 0 || signedBytes.length > MAX_SIGNED_XPI_BYTES) {
    throw new Error("AMO signed XPI size is invalid");
  }
  const signedXpiPath = join(outputDir, `chzzk-${metadata.version}-signed.xpi`);
  atomicWrite(signedXpiPath, signedBytes);
  return { signedXpiPath, signedXpiSha256: sha256(signedBytes) };
}
