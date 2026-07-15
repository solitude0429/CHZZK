import { createHash } from "node:crypto";
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
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import JSZip from "jszip";

import {
  RELEASE_ADD_ON_ID,
  RELEASE_PACKAGE_FILES,
  RELEASE_SOURCE_REPOSITORY,
  RELEASE_UPDATE_MANIFEST_URL,
  MAX_SIGNED_XPI_BYTES,
  assertReleaseMetadata,
} from "./amo-client.js";
import { assertCanonicalReleaseVersion } from "./release-version.js";

export { RELEASE_PACKAGE_FILES, assertReleaseMetadata } from "./amo-client.js";

const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const JSON_NUMBER_TOKEN = Symbol("lossless-json-number");
const MAX_JSON_DEPTH = 128;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SIGNATURE_METADATA_BYTES = 512 * 1024;
const MAX_SOURCE_ARCHIVE_BYTES = 8 * 1024 * 1024;
const SOURCE_DIGEST_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const RELEASE_ZIP_LIMITS = Object.freeze({
  maxAggregateUncompressedBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntryCompressedBytes: 2 * 1024 * 1024,
  maxEntryUncompressedBytes: 4 * 1024 * 1024,
  maxSignedCompressedBytes: MAX_SIGNED_XPI_BYTES,
  maxSourceCompressedBytes: MAX_SOURCE_ARCHIVE_BYTES,
});

export const MOZILLA_SIGNATURE_METADATA = Object.freeze({
  "META-INF/cose.manifest": Object.freeze({ maxBytes: 256 * 1024, minBytes: 256 }),
  "META-INF/cose.sig": Object.freeze({ maxBytes: 64 * 1024, minBytes: 512 }),
  "META-INF/manifest.mf": Object.freeze({ maxBytes: 256 * 1024, minBytes: 256 }),
  "META-INF/mozilla.rsa": Object.freeze({ maxBytes: 64 * 1024, minBytes: 512 }),
  "META-INF/mozilla.sf": Object.freeze({ maxBytes: 16 * 1024, minBytes: 64 }),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readStableRegularFile(path, { onDescriptorOpened = () => {} } = {}) {
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

function ensurePrivateDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700, recursive: true });
  } catch (error) {
    throw new Error(`Unable to create private release directory ${path}: ${error.message}`);
  }
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
      throw new Error(`Refusing to replace non-regular release output: ${path}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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

export function canonicalReleaseAssetNames(version) {
  assertCanonicalReleaseVersion(version);
  return Object.freeze({
    metadata: `chzzk-${version}-release-metadata.json`,
    signed: `chzzk-${version}-signed.xpi`,
    source: `chzzk-${version}.zip`,
  });
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function validateReleaseIdentity({ manifestBytes, packageBytes, sourceDigest, sourceRepository }) {
  if (!SOURCE_DIGEST_RE.test(sourceDigest))
    throw new Error("sourceDigest must be a full hexadecimal Git digest");
  if (sourceRepository !== RELEASE_SOURCE_REPOSITORY) {
    throw new Error("sourceRepository must be the canonical release repository");
  }

  const manifest = parseJsonBytes(manifestBytes, "manifest.json");
  const packageJson = parseJsonBytes(packageBytes, "package.json");
  const version = String(manifest.version ?? "");
  const gecko = manifest.browser_specific_settings?.gecko;
  assertCanonicalReleaseVersion(version, "manifest.json version");
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

export async function prepareReleaseArtifacts({ outputDir, rootDir, sourceDigest, sourceRepository }) {
  if (!rootDir || !outputDir) throw new Error("rootDir and outputDir are required");
  ensurePrivateDirectory(outputDir);
  const stageDir = mkdtempSync(join(outputDir, ".release-stage-"));
  chmodSync(stageDir, 0o700);

  try {
    const preparedFiles = [];
    for (const relativePath of RELEASE_PACKAGE_FILES) {
      const sourcePath = join(rootDir, relativePath);
      const { bytes } = readStableRegularFile(sourcePath);
      const stagedPath = join(stageDir, relativePath);
      ensurePrivateDirectory(dirname(stagedPath));
      writeFileSync(stagedPath, bytes, { flag: "wx", mode: 0o600 });
      chmodSync(stagedPath, 0o600);
      preparedFiles.push({ bytes, path: relativePath, sha256: sha256(bytes), size: bytes.length });
    }

    const manifestBytes = preparedFiles.find((file) => file.path === "manifest.json")?.bytes;
    const packageBytes = readStableRegularFile(join(rootDir, "package.json")).bytes;
    const identity = validateReleaseIdentity({
      manifestBytes,
      packageBytes,
      sourceDigest,
      sourceRepository,
    });

    const zip = new JSZip();
    for (const file of preparedFiles) {
      zip.file(file.path, file.bytes, {
        binary: true,
        createFolders: false,
        date: FIXED_ZIP_DATE,
        unixPermissions: 0o100644,
      });
    }
    const sourceArchiveBytes = await zip.generateAsync({
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
      streamFiles: false,
      type: "nodebuffer",
    });
    const names = canonicalReleaseAssetNames(identity.version);
    const sourceArchiveName = names.source;
    const sourceArchivePath = join(outputDir, sourceArchiveName);
    atomicWrite(sourceArchivePath, sourceArchiveBytes);

    const metadata = {
      addOnId: identity.addOnId,
      files: preparedFiles.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      })),
      schemaVersion: 1,
      sourceArchive: {
        name: sourceArchiveName,
        sha256: sha256(sourceArchiveBytes),
        size: sourceArchiveBytes.length,
      },
      sourceDigest,
      sourceRepository,
      strictMinVersion: identity.strictMinVersion,
      updateManifestUrl: identity.updateManifestUrl,
      version: identity.version,
    };
    assertReleaseMetadata(metadata);
    const metadataName = names.metadata;
    const metadataPath = join(outputDir, metadataName);
    atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    return {
      metadata,
      metadataPath,
      sourceArchivePath,
    };
  } finally {
    rmSync(stageDir, { force: true, recursive: true });
  }
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
    if (cursor + fieldSize > extraBytes.length) {
      throw new Error(`${label} ZIP extra field is malformed`);
    }
    if (fieldId === 0x0001) throw new Error(`${label} ZIP uses an unsupported ZIP64 layout`);
    cursor += fieldSize;
  }
}

function inspectZipCentralDirectory(bytes, label, expectedNames) {
  if (bytes.length < 22) throw new Error(`${label} ZIP is truncated`);
  const endOffset = findZipEndRecord(bytes, label);
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
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
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
      (localCrc32 !== crc32 ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize)
    ) {
      throw new Error(`${label} ZIP local and central entry sizes or CRC differ`);
    }
    const dataEnd = localExtraEnd + compressedSize;
    if (dataEnd > centralOffset) throw new Error(`${label} ZIP entry data range is unsafe`);
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
      dataEnd,
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
  for (const [index, entry] of entriesByOffset.entries()) {
    const nextOffset = entriesByOffset[index + 1]?.localOffset ?? centralOffset;
    if (entry.dataEnd > nextOffset) throw new Error(`${label} ZIP entry data ranges overlap`);
  }
  return entries;
}

function assertSafeZipEntries(zip, inspectedEntries, label) {
  const rawFiles = inspectedEntries.map((entry) => entry.name).sort();
  const parsedFiles = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => {
      if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) {
        throw new Error(`${label} ZIP entry name was normalized from an unsafe raw path`);
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(rawFiles) !== JSON.stringify(parsedFiles)) {
    throw new Error(`${label} ZIP raw entries do not match parsed entries exactly`);
  }
}

function runtimeEntries(zip) {
  return Object.values(zip.files)
    .filter((entry) => !entry.dir && !entry.name.startsWith("META-INF/"))
    .map((entry) => entry.name)
    .sort();
}

function assertExactRuntimeEntries(zip, label) {
  const actual = runtimeEntries(zip);
  const expected = [...RELEASE_PACKAGE_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} runtime entries do not match the release allowlist`);
  }
}

function assertExactSignatureMetadata(zip) {
  const signatureEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.startsWith("META-INF/"),
  );
  const actualNames = signatureEntries.map((entry) => entry.name).sort();
  const expectedNames = Object.keys(MOZILLA_SIGNATURE_METADATA).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Signed XPI signature metadata does not match the exact Mozilla allowlist");
  }
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
    if (!coefficient) {
      return Object.freeze({ [JSON_NUMBER_TOKEN]: sign ? "-0" : "0" });
    }
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

export async function verifySignedReleaseStructure({ metadataPath, signedXpiPath, sourceArchivePath }) {
  const metadataBytes = readStableRegularFile(metadataPath).bytes;
  let metadata;
  try {
    metadata = assertReleaseMetadata(JSON.parse(metadataBytes.toString("utf8")));
  } catch (error) {
    throw new Error(`Release metadata is invalid: ${error.message}`);
  }
  const names = canonicalReleaseAssetNames(metadata.version);
  if (basename(metadataPath) !== names.metadata) {
    throw new Error("Release metadata filename is not canonical");
  }
  if (basename(sourceArchivePath) !== names.source) {
    throw new Error("Source archive filename is not canonical");
  }
  if (basename(signedXpiPath) !== names.signed) {
    throw new Error("Signed XPI filename is not canonical");
  }
  const sourceBytes = readStableRegularFile(sourceArchivePath).bytes;
  const signedBytes = readStableRegularFile(signedXpiPath).bytes;
  if (signedBytes.length <= 0 || signedBytes.length > RELEASE_ZIP_LIMITS.maxSignedCompressedBytes) {
    throw new Error("Signed XPI compressed archive size limit exceeded");
  }
  if (sourceBytes.length <= 0 || sourceBytes.length > RELEASE_ZIP_LIMITS.maxSourceCompressedBytes) {
    throw new Error("Source archive compressed archive size limit exceeded");
  }
  if (
    sha256(sourceBytes) !== metadata.sourceArchive.sha256 ||
    sourceBytes.length !== metadata.sourceArchive.size
  ) {
    throw new Error("Source archive bytes do not match release metadata");
  }

  const sourceEntries = inspectZipCentralDirectory(sourceBytes, "Source archive", RELEASE_PACKAGE_FILES);
  const signedEntries = inspectZipCentralDirectory(signedBytes, "Signed XPI", [
    ...RELEASE_PACKAGE_FILES,
    ...Object.keys(MOZILLA_SIGNATURE_METADATA),
  ]);
  const sourceZip = await JSZip.loadAsync(sourceBytes, { checkCRC32: true });
  const signedZip = await JSZip.loadAsync(signedBytes, { checkCRC32: true });
  assertSafeZipEntries(sourceZip, sourceEntries, "Source archive");
  assertSafeZipEntries(signedZip, signedEntries, "Signed XPI");
  assertExactRuntimeEntries(sourceZip, "Source archive");
  assertExactRuntimeEntries(signedZip, "Signed XPI");
  assertExactSignatureMetadata(signedZip);

  const metadataFiles = new Map((metadata.files ?? []).map((file) => [file.path, file]));
  if (metadataFiles.size !== RELEASE_PACKAGE_FILES.length) {
    throw new Error("Release metadata file list does not match the runtime allowlist");
  }
  let signedManifest = null;
  for (const relativePath of RELEASE_PACKAGE_FILES) {
    const sourceFile = sourceZip.file(relativePath);
    const signedFile = signedZip.file(relativePath);
    const recorded = metadataFiles.get(relativePath);
    if (!sourceFile || !signedFile || !recorded)
      throw new Error(`Missing signed runtime file: ${relativePath}`);
    const sourceFileBytes = await sourceFile.async("nodebuffer");
    const signedFileBytes = await signedFile.async("nodebuffer");
    if (sha256(sourceFileBytes) !== recorded.sha256 || sourceFileBytes.length !== recorded.size) {
      throw new Error(`Signed runtime file differs from release metadata: ${relativePath}`);
    }
    if (relativePath === "manifest.json") {
      const sourceManifest = parseManifest(sourceFileBytes, "Source archive");
      signedManifest = parseManifest(signedFileBytes, "Signed XPI");
      if (!jsonSemanticallyEqual(sourceManifest, signedManifest)) {
        throw new Error("Signed runtime file differs from release metadata: manifest.json");
      }
    } else if (!sourceFileBytes.equals(signedFileBytes)) {
      throw new Error(`Signed runtime file differs from release metadata: ${relativePath}`);
    }
  }

  assertSignedManifestIdentity(signedManifest, metadata);
  return {
    metadata,
    metadataBytes,
    metadataSha256: sha256(metadataBytes),
    signedXpiBytes: signedBytes,
    signedXpiSha256: sha256(signedBytes),
    signedXpiSize: signedBytes.length,
    sourceArchiveBytes: sourceBytes,
    sourceArchiveSha256: sha256(sourceBytes),
    sourceDigest: metadata.sourceDigest,
    verification: "structural-only",
    version: metadata.version,
  };
}
