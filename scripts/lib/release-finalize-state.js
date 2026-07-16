import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";

import { assertCanonicalReleaseVersion } from "./release-version.js";

const JSON_NUMBER_TOKEN = Symbol("lossless-json-number");
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_DIGEST_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const STRICT_MIN_VERSION_RE = /^\d+(?:\.\d+){1,3}$/;
const MAX_JSON_DEPTH = 128;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_RELEASE_METADATA_BYTES = 512 * 1024;
const MAX_SIGNATURE_METADATA_BYTES = 512 * 1024;
const MAX_SOURCE_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_SIGNED_XPI_BYTES = 16 * 1024 * 1024;
export const RELEASE_VERSION = "0.1.6";
export const RELEASE_ADD_ON_ID = "chzzk@solitude0429.local";
const RELEASE_SOURCE_REPOSITORY = "solitude0429/CHZZK";
export const RELEASE_UPDATE_MANIFEST_URL = "https://chzzk-updates.alpha-apple.dedyn.io/updates.json";
const TRUSTED_ASSET_UPLOADER = Object.freeze({ login: "github-actions[bot]", type: "Bot" });

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

const RELEASE_ZIP_LIMITS = Object.freeze({
  maxAggregateUncompressedBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntryCompressedBytes: 2 * 1024 * 1024,
  maxEntryUncompressedBytes: 4 * 1024 * 1024,
  maxSignedCompressedBytes: MAX_SIGNED_XPI_BYTES,
  maxSourceCompressedBytes: MAX_SOURCE_ARCHIVE_BYTES,
});

const MOZILLA_SIGNATURE_METADATA = Object.freeze({
  "META-INF/cose.manifest": Object.freeze({ maxBytes: 256 * 1024, minBytes: 256 }),
  "META-INF/cose.sig": Object.freeze({ maxBytes: 64 * 1024, minBytes: 512 }),
  "META-INF/manifest.mf": Object.freeze({ maxBytes: 256 * 1024, minBytes: 256 }),
  "META-INF/mozilla.rsa": Object.freeze({ maxBytes: 64 * 1024, minBytes: 512 }),
  "META-INF/mozilla.sf": Object.freeze({ maxBytes: 16 * 1024, minBytes: 64 }),
});

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

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

export function assertFinalizationReleaseVersion(value, label = "Release version") {
  const version = assertCanonicalReleaseVersion(value, label);
  if (version !== RELEASE_VERSION) {
    throw new Error(`${label} must be the canonical ${RELEASE_VERSION} release`);
  }
  return version;
}

function assertReleaseMetadata(metadata) {
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
  assertFinalizationReleaseVersion(metadata.version, "Release metadata version");
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
  if (!SOURCE_DIGEST_RE.test(metadata.sourceDigest)) throw new Error("Invalid release source digest");

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

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700, recursive: true });
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
  ensurePrivateDirectory(dirname(path));
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-regular release verification output: ${path}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
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

function readStableRegularFile(path, { onDescriptorOpened = () => {} } = {}) {
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error(
      `Release input must be a readable regular file, not a symbolic link: ${path}: ${error.message}`,
    );
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`Release input must be a regular file: ${path}`);
    onDescriptorOpened(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size
    ) {
      throw new Error(`Release input changed while it was being read: ${path}`);
    }
    return { bytes, stat: after };
  } finally {
    closeSync(descriptor);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function validateReleaseIdentity({ manifestBytes, packageBytes, sourceDigest, sourceRepository }) {
  if (!SOURCE_DIGEST_RE.test(sourceDigest)) {
    throw new Error("sourceDigest must be a full hexadecimal Git digest");
  }
  if (sourceRepository !== RELEASE_SOURCE_REPOSITORY) {
    throw new Error("sourceRepository must be the canonical release repository");
  }

  const manifest = parseJsonBytes(manifestBytes, "manifest.json");
  const packageJson = parseJsonBytes(packageBytes, "package.json");
  const version = String(manifest.version ?? "");
  const gecko = manifest.browser_specific_settings?.gecko;
  assertFinalizationReleaseVersion(version, "manifest.json version");
  if (packageJson.version !== version) {
    throw new Error("manifest.json and package.json must carry the same SemVer version");
  }
  if (gecko?.id !== RELEASE_ADD_ON_ID) throw new Error("Firefox add-on ID is not canonical");
  if (typeof gecko.strict_min_version !== "string" || !gecko.strict_min_version) {
    throw new Error("Firefox strict_min_version is missing");
  }
  if (gecko.update_url !== RELEASE_UPDATE_MANIFEST_URL) {
    throw new Error("Firefox update_url is not canonical");
  }
  return {
    addOnId: gecko.id,
    strictMinVersion: gecko.strict_min_version,
    updateManifestUrl: gecko.update_url,
    version,
  };
}

export function canonicalReleaseAssetNames(version) {
  assertFinalizationReleaseVersion(version);
  return Object.freeze({
    metadata: `chzzk-${version}-release-metadata.json`,
    signed: `chzzk-${version}-signed.xpi`,
    source: `chzzk-${version}.zip`,
  });
}

export function prepareFinalizationInputs({ outputDir, rootDir, sourceDigest, sourceRepository }) {
  if (!rootDir || !outputDir) throw new Error("rootDir and outputDir are required");
  ensurePrivateDirectory(outputDir);
  const expectedFiles = [];
  let manifestBytes;
  for (const relativePath of RELEASE_PACKAGE_FILES) {
    const { bytes } = readStableRegularFile(join(rootDir, relativePath));
    if (relativePath === "manifest.json") manifestBytes = bytes;
    expectedFiles.push({ path: relativePath, sha256: sha256(bytes), size: bytes.length });
  }
  if (!manifestBytes) throw new Error("Release runtime allowlist is missing manifest.json");
  const packageBytes = readStableRegularFile(join(rootDir, "package.json")).bytes;
  const identity = validateReleaseIdentity({
    manifestBytes,
    packageBytes,
    sourceDigest,
    sourceRepository,
  });
  const names = canonicalReleaseAssetNames(identity.version);
  return {
    expectedFiles,
    metadata: {
      addOnId: identity.addOnId,
      files: expectedFiles,
      sourceDigest,
      sourceRepository,
      strictMinVersion: identity.strictMinVersion,
      updateManifestUrl: identity.updateManifestUrl,
      version: identity.version,
    },
    metadataPath: join(outputDir, names.metadata),
    sourceArchivePath: join(outputDir, names.source),
  };
}

function flattenPages(value, label) {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} did not return paginated arrays`);
  }
  return value.flat();
}

function listMatchingReleases(runGh, repository, tag) {
  const pages = parseJson(
    runGh(["api", "--method", "GET", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`], {
      repository,
    }),
    "Release listing",
  );
  const matches = flattenPages(pages, "Release listing").filter((release) => release?.tag_name === tag);
  if (matches.length > 1) throw new Error(`Multiple releases claim the expected tag: ${tag}`);
  return matches[0] ?? null;
}

function resolveTagCommit(runGh, repository, tag) {
  const pages = parseJson(
    runGh(
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        `repos/${repository}/git/matching-refs/tags/${tag}`,
      ],
      { repository },
    ),
    "Tag listing",
  );
  const exactRef = `refs/tags/${tag}`;
  const matches = flattenPages(pages, "Tag listing").filter((entry) => entry?.ref === exactRef);
  if (matches.length > 1) throw new Error(`Multiple exact Git tag refs exist: ${tag}`);
  if (matches.length === 0) return null;

  let object = matches[0].object;
  const visited = new Set();
  for (let depth = 0; depth < 5; depth += 1) {
    const digest = String(object?.sha ?? "").toLowerCase();
    if (!FULL_GIT_SHA_RE.test(digest) || visited.has(digest)) {
      throw new Error(`Release tag ${tag} has an invalid or cyclic Git object`);
    }
    visited.add(digest);
    if (object.type === "commit") return digest;
    if (object.type !== "tag") throw new Error(`Release tag ${tag} does not resolve to a commit`);
    const annotated = parseJson(
      runGh(["api", "--method", "GET", `repos/${repository}/git/tags/${digest}`], { repository }),
      "Annotated tag lookup",
    );
    object = annotated.object;
  }
  throw new Error(`Release tag ${tag} exceeded the annotated-tag depth limit`);
}

function releaseAssetRecords(release, expectedNames) {
  if (!Array.isArray(release.assets)) throw new Error("GitHub release asset list is missing");
  const byName = new Map();
  const ids = new Set();
  for (const asset of release.assets) {
    if (!asset || typeof asset !== "object" || typeof asset.name !== "string") {
      throw new Error("GitHub release contains a malformed asset record");
    }
    if (byName.has(asset.name)) throw new Error(`GitHub release contains a duplicate asset: ${asset.name}`);
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || ids.has(asset.id)) {
      throw new Error(`GitHub release asset id is malformed or duplicate: ${asset.name}`);
    }
    ids.add(asset.id);
    byName.set(asset.name, asset);
  }
  const actualNames = [...byName.keys()].sort();
  const canonicalNames = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(canonicalNames)) {
    for (const name of actualNames) {
      if (!expectedNames.includes(name)) throw new Error(`Refusing unexpected release asset: ${name}`);
    }
    throw new Error("Release finalization requires exactly the three canonical assets");
  }
  return expectedNames.map((name) => byName.get(name));
}

function parseAssetDigest(value, name) {
  if (typeof value !== "string") throw new Error(`Release asset digest is missing: ${name}`);
  const match = /^sha256:([a-f0-9]{64})$/.exec(value);
  if (!match) throw new Error(`Release asset SHA-256 digest is malformed: ${name}`);
  return match[1];
}

function normalizeContentType(value, name) {
  if (typeof value !== "string") throw new Error(`Release asset content type is missing: ${name}`);
  const contentType = value.toLowerCase().split(";")[0].trim();
  if (!contentType) throw new Error(`Release asset content type is malformed: ${name}`);
  return contentType;
}

function expectedAssetPolicy(names, name) {
  if (name === names.source) {
    return {
      contentTypes: new Set(["application/octet-stream", "application/x-zip-compressed", "application/zip"]),
      maxBytes: MAX_SOURCE_ARCHIVE_BYTES,
    };
  }
  if (name === names.metadata) {
    return {
      contentTypes: new Set(["application/json", "application/octet-stream", "text/json", "text/plain"]),
      maxBytes: MAX_RELEASE_METADATA_BYTES,
    };
  }
  if (name === names.signed) {
    return {
      contentTypes: new Set([
        "application/octet-stream",
        "application/x-xpinstall",
        "application/x-zip-compressed",
        "application/zip",
      ]),
      maxBytes: MAX_SIGNED_XPI_BYTES,
    };
  }
  throw new Error(`Unexpected release asset policy lookup: ${name}`);
}

function validateAssetMetadata(asset, names) {
  const policy = expectedAssetPolicy(names, asset.name);
  assertSafePositiveSize(asset.size, `Release asset size: ${asset.name}`);
  if (asset.size > policy.maxBytes) throw new Error(`Release asset exceeds the size limit: ${asset.name}`);
  const digest = parseAssetDigest(asset.digest, asset.name);
  const contentType = normalizeContentType(asset.content_type, asset.name);
  if (!policy.contentTypes.has(contentType)) {
    throw new Error(`Release asset content type is not allowed for ${asset.name}: ${contentType}`);
  }
  if (asset.state !== "uploaded") throw new Error(`Release asset is not fully uploaded: ${asset.name}`);
  if (
    asset.uploader?.login !== TRUSTED_ASSET_UPLOADER.login ||
    asset.uploader?.type !== TRUSTED_ASSET_UPLOADER.type
  ) {
    throw new Error(`Release asset uploader is not the trusted staging workflow identity: ${asset.name}`);
  }
  return {
    contentType,
    digest,
    id: asset.id,
    name: asset.name,
    size: asset.size,
  };
}

function downloadAsset(runGh, { directory, metadata, repository, tag }) {
  runGh(["release", "download", tag, "--repo", repository, "--dir", directory, "--pattern", metadata.name], {
    repository,
  });
  const entries = readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== metadata.name) {
    throw new Error(`Release asset download did not produce exactly the requested file: ${metadata.name}`);
  }
  const path = join(directory, metadata.name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Downloaded release asset is not a regular file: ${metadata.name}`);
  }
  if (stat.size !== metadata.size) {
    throw new Error(`Downloaded release asset size differs from GitHub metadata: ${metadata.name}`);
  }
  const bytes = readStableRegularFile(path).bytes;
  const digest = sha256(bytes);
  if (digest !== metadata.digest) {
    throw new Error(`Downloaded release asset digest differs from GitHub metadata: ${metadata.name}`);
  }
  return { bytes, path, sha256: digest, size: bytes.length };
}

function decodeSafeZipName(nameBytes, label) {
  if ([...nameBytes].some((byte) => byte > 0x7f)) {
    throw new Error(`${label} ZIP entry names must use ASCII`);
  }
  const name = nameBytes.toString("ascii");
  const parts = name.split("/");
  if (parts.at(-1) === "") parts.pop();
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} ZIP contains an unsafe raw entry path`);
  }
  return name;
}

function findZipEndRecord(bytes, label) {
  const minimumOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      return offset;
    }
  }
  throw new Error(`${label} ZIP end record is missing or ambiguous`);
}

function assertZipExtraFields(extraBytes, label) {
  let cursor = 0;
  while (cursor < extraBytes.length) {
    if (cursor + 4 > extraBytes.length) throw new Error(`${label} ZIP extra field is malformed`);
    const fieldId = extraBytes.readUInt16LE(cursor);
    const fieldSize = extraBytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + fieldSize > extraBytes.length) throw new Error(`${label} ZIP extra field is malformed`);
    if (fieldId === 0x0001) throw new Error(`${label} ZIP uses an unsupported ZIP64 layout`);
    cursor += fieldSize;
  }
}

function dataDescriptorEnd(
  bytes,
  dataEnd,
  centralOffset,
  { compressedSize, crc32: expectedCrc32, uncompressedSize },
  label,
) {
  const candidates = [];
  if (dataEnd + 12 <= centralOffset) {
    candidates.push({
      compressedSize: bytes.readUInt32LE(dataEnd + 4),
      crc32: bytes.readUInt32LE(dataEnd),
      end: dataEnd + 12,
      uncompressedSize: bytes.readUInt32LE(dataEnd + 8),
    });
  }
  if (dataEnd + 16 <= centralOffset && bytes.readUInt32LE(dataEnd) === 0x08074b50) {
    candidates.push({
      compressedSize: bytes.readUInt32LE(dataEnd + 8),
      crc32: bytes.readUInt32LE(dataEnd + 4),
      end: dataEnd + 16,
      uncompressedSize: bytes.readUInt32LE(dataEnd + 12),
    });
  }
  const matching = candidates.filter(
    (candidate) =>
      candidate.crc32 === expectedCrc32 &&
      candidate.compressedSize === compressedSize &&
      candidate.uncompressedSize === uncompressedSize,
  );
  if (matching.length !== 1) throw new Error(`${label} ZIP data descriptor is missing or malformed`);
  return matching[0].end;
}

function inspectZipCentralDirectory(bytes, label, expectedNames) {
  if (bytes.length < 22) throw new Error(`${label} ZIP is truncated`);
  const endOffset = findZipEndRecord(bytes, label);
  if (bytes.readUInt16LE(endOffset + 20) !== 0) {
    throw new Error(`${label} ZIP archive comments are forbidden`);
  }
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new Error(`${label} ZIP uses an unsupported multi-disk or ZIP64 layout`);
  }

  const entries = [];
  const seenNames = new Set();
  const seenLocalOffsets = new Set();
  let aggregateUncompressedBytes = 0;
  let signatureMetadataBytes = 0;
  let cursor = centralOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`${label} ZIP central directory is malformed`);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const compressionMethod = bytes.readUInt16LE(cursor + 10);
    const entryCrc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    if (commentLength !== 0) throw new Error(`${label} ZIP entry comments are forbidden`);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      (flags & 1) !== 0 ||
      (flags & ~0x080e) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      nextCursor > endOffset ||
      localOffset + 30 > centralOffset ||
      seenLocalOffsets.has(localOffset)
    ) {
      throw new Error(`${label} ZIP entry metadata is unsafe`);
    }
    const centralNameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const centralExtraStart = cursor + 46 + nameLength;
    assertZipExtraFields(bytes.subarray(centralExtraStart, centralExtraStart + extraLength), label);
    const name = decodeSafeZipName(centralNameBytes, label);
    if (seenNames.has(name)) throw new Error(`${label} ZIP contains a duplicate raw entry name`);
    seenNames.add(name);
    seenLocalOffsets.add(localOffset);

    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${label} ZIP local entry header is malformed`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localCompressionMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc32 = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd + localExtraLength > centralOffset) {
      throw new Error(`${label} ZIP local entry metadata is truncated`);
    }
    if (localFlags !== flags || localCompressionMethod !== compressionMethod) {
      throw new Error(`${label} ZIP local and central entry metadata differ`);
    }
    const localNameBytes = bytes.subarray(localNameStart, localNameEnd);
    if (!localNameBytes.equals(centralNameBytes)) {
      throw new Error(`${label} ZIP local and central entry names differ`);
    }
    const localExtraEnd = localNameEnd + localExtraLength;
    assertZipExtraFields(bytes.subarray(localNameEnd, localExtraEnd), label);
    if (
      (flags & 0x0008) === 0 &&
      (localCrc32 !== entryCrc32 ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize)
    ) {
      throw new Error(`${label} ZIP local and central entry sizes or CRC differ`);
    }
    let dataEnd = localExtraEnd + compressedSize;
    if (dataEnd > centralOffset) throw new Error(`${label} ZIP entry data range is unsafe`);
    if ((flags & 0x0008) !== 0) {
      dataEnd = dataDescriptorEnd(
        bytes,
        dataEnd,
        centralOffset,
        { compressedSize, crc32: entryCrc32, uncompressedSize },
        label,
      );
    }
    if (compressedSize <= 0 || compressedSize > RELEASE_ZIP_LIMITS.maxEntryCompressedBytes) {
      throw new Error(`${label} ZIP compressed entry size limit exceeded: ${name}`);
    }
    if (uncompressedSize <= 0 || uncompressedSize > RELEASE_ZIP_LIMITS.maxEntryUncompressedBytes) {
      throw new Error(`${label} ZIP uncompressed entry size limit exceeded: ${name}`);
    }
    aggregateUncompressedBytes += uncompressedSize;
    if (aggregateUncompressedBytes > RELEASE_ZIP_LIMITS.maxAggregateUncompressedBytes) {
      throw new Error(`${label} ZIP aggregate uncompressed size limit exceeded`);
    }
    if (uncompressedSize / compressedSize > RELEASE_ZIP_LIMITS.maxCompressionRatio) {
      throw new Error(`${label} ZIP compression ratio limit exceeded: ${name}`);
    }
    const signatureBounds = MOZILLA_SIGNATURE_METADATA[name];
    if (signatureBounds) {
      if (uncompressedSize < signatureBounds.minBytes || uncompressedSize > signatureBounds.maxBytes) {
        throw new Error(`Signed XPI signature metadata size is invalid: ${name}`);
      }
      signatureMetadataBytes += uncompressedSize;
      if (signatureMetadataBytes > MAX_SIGNATURE_METADATA_BYTES) {
        throw new Error("Signed XPI aggregate signature metadata size is invalid");
      }
    }
    entries.push({
      compressedSize,
      compressionMethod,
      crc32: entryCrc32,
      dataEnd,
      dataStart: localExtraEnd,
      localOffset,
      name,
      uncompressedSize,
    });
    cursor = nextCursor;
  }
  if (cursor !== endOffset) throw new Error(`${label} ZIP central directory size is inconsistent`);
  const actualNames = entries.map((entry) => entry.name).sort();
  const canonicalNames = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(canonicalNames)) {
    const detail = label === "Signed XPI" ? "runtime or signature metadata" : "runtime";
    throw new Error(`${label} ZIP ${detail} entries do not match the exact release allowlist`);
  }
  const entriesByOffset = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  if (entriesByOffset[0]?.localOffset !== 0) {
    throw new Error(`${label} ZIP contains unaccounted bytes before the first entry`);
  }
  for (const [index, entry] of entriesByOffset.entries()) {
    const nextOffset = entriesByOffset[index + 1]?.localOffset ?? centralOffset;
    if (entry.dataEnd !== nextOffset) {
      throw new Error(`${label} ZIP contains unaccounted bytes between entry data records`);
    }
  }
  return entries;
}

function extractZipEntries(bytes, label, expectedNames) {
  const inspectedEntries = inspectZipCentralDirectory(bytes, label, expectedNames);
  const entries = new Map();
  for (const entry of inspectedEntries) {
    const compressedBytes = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let uncompressedBytes;
    if (entry.compressionMethod === 0) {
      uncompressedBytes = Buffer.from(compressedBytes);
    } else {
      try {
        uncompressedBytes = inflateRawSync(compressedBytes, {
          maxOutputLength: entry.uncompressedSize,
        });
      } catch (error) {
        throw new Error(`${label} ZIP entry could not be inflated: ${entry.name}: ${error.message}`);
      }
    }
    if (uncompressedBytes.length !== entry.uncompressedSize) {
      throw new Error(`${label} ZIP entry inflated size mismatch: ${entry.name}`);
    }
    if (crc32(uncompressedBytes) !== entry.crc32) {
      throw new Error(`${label} ZIP entry CRC mismatch: ${entry.name}`);
    }
    entries.set(entry.name, uncompressedBytes);
  }
  return entries;
}

function jsonSemanticallyEqual(left, right) {
  const leftNumber = left?.[JSON_NUMBER_TOKEN];
  const rightNumber = right?.[JSON_NUMBER_TOKEN];
  if (leftNumber !== undefined || rightNumber !== undefined) {
    return leftNumber !== undefined && rightNumber !== undefined && leftNumber === rightNumber;
  }
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonSemanticallyEqual(entry, right[index]))
    );
  }
  if (typeof left !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && Object.hasOwn(right, key) && jsonSemanticallyEqual(left[key], right[key]),
    )
  );
}

function parseStrictJson(text, label) {
  let index = 0;

  const fail = (message) => {
    throw new Error(`${label} manifest ${message}`);
  };
  const skipWhitespace = () => {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  };
  const parseString = () => {
    if (text[index] !== '"') fail("is not valid JSON");
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail("is not valid JSON");
        }
      }
      if (character === "\\") {
        index += 1;
        const escape = text[index];
        if (escape === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(index + 1, index + 5))) {
            fail("is not valid JSON");
          }
          index += 5;
        } else if ('"\\/bfnrt'.includes(escape)) {
          index += 1;
        } else {
          fail("is not valid JSON");
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail("is not valid JSON");
      index += 1;
    }
    fail("is not valid JSON");
  };
  const parseNumber = () => {
    const match = text.slice(index).match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/);
    if (!match) fail("is not valid JSON");
    index += match[0].length;
    const [, sign, integer, fraction = "", exponentToken = "0"] = match;
    if (exponentToken.replace(/^[+-]/, "").length > 6) {
      fail("contains a number exponent outside the supported range");
    }
    let coefficient = `${integer}${fraction}`.replace(/^0+/, "");
    if (!coefficient) return Object.freeze({ [JSON_NUMBER_TOKEN]: sign ? "-0" : "0" });
    const trailingZeroCount = coefficient.match(/0+$/)?.[0].length ?? 0;
    if (trailingZeroCount > 0) coefficient = coefficient.slice(0, -trailingZeroCount);
    const exponent = BigInt(exponentToken) - BigInt(fraction.length) + BigInt(trailingZeroCount);
    return Object.freeze({
      [JSON_NUMBER_TOKEN]: `${sign}${coefficient}e${exponent.toString()}`,
    });
  };
  const parseValue = (depth) => {
    if (depth > MAX_JSON_DEPTH) fail("exceeds the nesting limit");
    skipWhitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const entries = [];
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return {};
      }
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) fail(`contains duplicate key ${JSON.stringify(key)}`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") fail("is not valid JSON");
        index += 1;
        entries.push([key, parseValue(depth + 1)]);
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return Object.fromEntries(entries);
        }
        if (text[index] !== ",") fail("is not valid JSON");
        index += 1;
      }
      fail("is not valid JSON");
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      const entries = [];
      if (text[index] === "]") {
        index += 1;
        return entries;
      }
      while (index < text.length) {
        entries.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return entries;
        }
        if (text[index] !== ",") fail("is not valid JSON");
        index += 1;
      }
      fail("is not valid JSON");
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    return parseNumber();
  };

  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail("is not valid JSON");
  return value;
}

function parseManifest(bytes, label) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error(`${label} manifest exceeds the size limit`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} manifest is not valid UTF-8`);
  }
  const manifest = parseStrictJson(text, label);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${label} manifest root must be an object`);
  }
  return manifest;
}

function assertSignedManifestIdentity(manifest, metadata) {
  const gecko = manifest.browser_specific_settings?.gecko;
  if (
    manifest.version !== metadata.version ||
    gecko?.id !== metadata.addOnId ||
    gecko?.strict_min_version !== metadata.strictMinVersion ||
    gecko?.update_url !== metadata.updateManifestUrl
  ) {
    throw new Error("Signed XPI manifest identity does not match release metadata");
  }
}

function assertZipEntriesMatchMetadata(
  entries,
  metadata,
  label,
  { allowSemanticManifestRewrite = false } = {},
) {
  const metadataFiles = new Map(metadata.files.map((file) => [file.path, file]));
  for (const relativePath of RELEASE_PACKAGE_FILES) {
    const bytes = entries.get(relativePath);
    const recorded = metadataFiles.get(relativePath);
    if (!bytes || !recorded) throw new Error(`${label} is missing runtime file: ${relativePath}`);
    if (relativePath === "manifest.json" && allowSemanticManifestRewrite) continue;
    if (sha256(bytes) !== recorded.sha256 || bytes.length !== recorded.size) {
      throw new Error(`${label} runtime file differs from release metadata: ${relativePath}`);
    }
  }
}

function assertRuntimeEntriesEqual({ metadata, signedEntries, sourceEntries }) {
  let signedManifest = null;
  for (const relativePath of RELEASE_PACKAGE_FILES) {
    const sourceBytes = sourceEntries.get(relativePath);
    const signedBytes = signedEntries.get(relativePath);
    if (!sourceBytes || !signedBytes) throw new Error(`Missing signed runtime file: ${relativePath}`);
    if (relativePath === "manifest.json") {
      const sourceManifest = parseManifest(sourceBytes, "Source archive");
      signedManifest = parseManifest(signedBytes, "Signed XPI");
      if (!jsonSemanticallyEqual(sourceManifest, signedManifest)) {
        throw new Error("Signed runtime file differs from release metadata: manifest.json");
      }
    } else if (!sourceBytes.equals(signedBytes)) {
      throw new Error(`Signed runtime file differs from release metadata: ${relativePath}`);
    }
  }
  assertSignedManifestIdentity(signedManifest, metadata);
}

function assertMetadataMatchesLocalAllowlist(metadata, expectedFiles) {
  if (!Array.isArray(expectedFiles) || expectedFiles.length !== RELEASE_PACKAGE_FILES.length) {
    throw new Error("Release finalization requires locally pinned allowlisted file metadata");
  }
  const expected = new Map(expectedFiles.map((file) => [file.path, file]));
  for (const recorded of metadata.files) {
    const local = expected.get(recorded.path);
    if (!local || local.sha256 !== recorded.sha256 || local.size !== recorded.size) {
      throw new Error(`Release metadata does not match the local allowlisted file: ${recorded.path}`);
    }
  }
}

function parseReleaseMetadata(bytes, { expectedFiles, repository, sourceArchive, sourceSha, version }) {
  if (bytes.length <= 0 || bytes.length > MAX_RELEASE_METADATA_BYTES) {
    throw new Error("Release metadata size is invalid");
  }
  let metadata;
  try {
    metadata = assertReleaseMetadata(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error(`Release metadata is invalid: ${error.message}`);
  }
  if (
    metadata.version !== version ||
    metadata.sourceDigest !== sourceSha ||
    metadata.sourceRepository !== repository
  ) {
    throw new Error("Release metadata is not bound to the exact finalization source");
  }
  if (
    metadata.sourceArchive.sha256 !== sourceArchive.sha256 ||
    metadata.sourceArchive.size !== sourceArchive.size
  ) {
    throw new Error("Release source archive bytes do not match release metadata");
  }
  assertMetadataMatchesLocalAllowlist(metadata, expectedFiles);
  return metadata;
}

function validateReleaseObject({ release, sourceSha, tag, tagCommit }) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("Release lookup returned a malformed object");
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error("Release lookup returned a malformed release id");
  }
  if (release.tag_name !== tag) throw new Error("Release tag identity mismatch");
  if (release.name !== `CHZZK ${tag.slice(1)}`) throw new Error("Release title identity mismatch");
  if (release.prerelease !== false) throw new Error("Release state must not be a prerelease");
  if (typeof release.draft !== "boolean") throw new Error("Release draft state is unknown");
  if (release.draft) {
    if (release.immutable !== false) throw new Error("Draft release immutable state is unknown or invalid");
    if (release.target_commitish !== sourceSha) {
      throw new Error("Draft release target commit does not match the exact source commit");
    }
    if (tagCommit && tagCommit !== sourceSha) {
      throw new Error("Draft release tag resolves to a different source commit");
    }
  } else {
    if (release.immutable !== true) throw new Error("Published release is not immutable");
    if (!tagCommit || tagCommit !== sourceSha) {
      throw new Error("Published release tag does not resolve to the exact source commit");
    }
  }
}

function validateBasenames({ metadataPath, signedXpiPath, sourceArchivePath }, names) {
  if (
    basename(sourceArchivePath) !== names.source ||
    basename(metadataPath) !== names.metadata ||
    basename(signedXpiPath) !== names.signed
  ) {
    throw new Error("Release state inspection requires canonical local asset basenames");
  }
}

function assetSnapshot({ assetMetadata, release, tag }) {
  return Object.freeze({
    assets: Object.freeze(
      assetMetadata
        .map((asset) =>
          Object.freeze({
            contentType: asset.contentType,
            digest: asset.digest,
            id: asset.id,
            name: asset.name,
            size: asset.size,
          }),
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
    immutable: release.immutable,
    releaseId: release.id,
    tag,
  });
}

export async function inspectFinalizationReleaseState({
  expectedFiles,
  metadataPath,
  repository,
  runGh,
  signedXpiPath,
  sourceArchivePath,
  sourceSha,
  version,
}) {
  assertFinalizationReleaseVersion(version);
  if (!REPOSITORY_RE.test(String(repository ?? ""))) throw new Error("Invalid GitHub repository identity");
  sourceSha = String(sourceSha ?? "").toLowerCase();
  if (!FULL_GIT_SHA_RE.test(sourceSha)) throw new Error("Source commit must be one full Git SHA");

  const names = canonicalReleaseAssetNames(version);
  validateBasenames({ metadataPath, signedXpiPath, sourceArchivePath }, names);
  const tag = `v${version}`;
  const release = listMatchingReleases(runGh, repository, tag);
  const tagCommit = resolveTagCommit(runGh, repository, tag);
  if (!release) {
    if (tagCommit) throw new Error(`Refusing orphan release tag without a release: ${tag}`);
    return { draftSignedReady: false, reuseExisting: false, signedSha256: "" };
  }
  validateReleaseObject({ release, sourceSha, tag, tagCommit });

  const expectedNames = [names.source, names.metadata, names.signed];
  const assetMetadata = releaseAssetRecords(release, expectedNames).map((asset) =>
    validateAssetMetadata(asset, names),
  );
  const downloadsDir = mkdtempSync(join(tmpdir(), "chzzk-finalize-assets-"));
  chmodSync(downloadsDir, 0o700);
  try {
    const downloads = new Map();
    for (const metadata of assetMetadata) {
      const assetDir = mkdtempSync(join(downloadsDir, "asset-"));
      chmodSync(assetDir, 0o700);
      downloads.set(metadata.name, downloadAsset(runGh, { directory: assetDir, metadata, repository, tag }));
    }

    const source = downloads.get(names.source);
    const metadataAsset = downloads.get(names.metadata);
    const signed = downloads.get(names.signed);
    if (source.size > RELEASE_ZIP_LIMITS.maxSourceCompressedBytes) {
      throw new Error("Source archive compressed archive size limit exceeded");
    }
    if (signed.size > RELEASE_ZIP_LIMITS.maxSignedCompressedBytes) {
      throw new Error("Signed XPI compressed archive size limit exceeded");
    }
    const metadata = parseReleaseMetadata(metadataAsset.bytes, {
      expectedFiles,
      repository,
      sourceArchive: source,
      sourceSha,
      version,
    });
    const sourceEntries = extractZipEntries(source.bytes, "Source archive", RELEASE_PACKAGE_FILES);
    const signedEntries = extractZipEntries(signed.bytes, "Signed XPI", [
      ...RELEASE_PACKAGE_FILES,
      ...Object.keys(MOZILLA_SIGNATURE_METADATA),
    ]);
    assertZipEntriesMatchMetadata(sourceEntries, metadata, "Source archive");
    assertZipEntriesMatchMetadata(signedEntries, metadata, "Signed XPI", {
      allowSemanticManifestRewrite: true,
    });
    assertRuntimeEntriesEqual({ metadata, signedEntries, sourceEntries });

    atomicWrite(sourceArchivePath, source.bytes);
    atomicWrite(metadataPath, metadataAsset.bytes);
    atomicWrite(signedXpiPath, signed.bytes);

    return {
      assetSnapshot: assetSnapshot({ assetMetadata, release, tag }),
      draftSignedReady: release.draft === true,
      reuseExisting: release.draft === false,
      signedSha256: signed.sha256,
    };
  } finally {
    rmSync(downloadsDir, { force: true, recursive: true });
  }
}
