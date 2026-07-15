import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import JSZip from "jszip";

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

const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const MAX_JSON_DEPTH = 128;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_DIGEST_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertRegularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Release input must be a regular file, not a symbolic link: ${path}`);
  }
  return stat;
}

function ensurePrivateDirectory(path) {
  try {
    mkdirSync(path, { mode: 0o700, recursive: true });
  } catch (error) {
    throw new Error(`Unable to create private release directory ${path}: ${error.message}`);
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
  writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function validateReleaseIdentity(rootDir, sourceDigest, sourceRepository) {
  if (!SOURCE_DIGEST_RE.test(sourceDigest))
    throw new Error("sourceDigest must be a full hexadecimal Git digest");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
    throw new Error("sourceRepository must use owner/repository form");
  }

  assertRegularFile(join(rootDir, "manifest.json"));
  assertRegularFile(join(rootDir, "package.json"));
  const manifest = readJson(join(rootDir, "manifest.json"));
  const packageJson = readJson(join(rootDir, "package.json"));
  const version = String(manifest.version ?? "");
  const gecko = manifest.browser_specific_settings?.gecko;
  if (!VERSION_RE.test(version) || packageJson.version !== version) {
    throw new Error("manifest.json and package.json must carry the same SemVer version");
  }
  if (typeof gecko?.id !== "string" || !gecko.id) throw new Error("Firefox add-on ID is missing");
  if (typeof gecko.strict_min_version !== "string" || !gecko.strict_min_version) {
    throw new Error("Firefox strict_min_version is missing");
  }
  const updateUrl = new URL(gecko.update_url);
  if (
    updateUrl.protocol !== "https:" ||
    updateUrl.username ||
    updateUrl.password ||
    updateUrl.search ||
    updateUrl.hash
  ) {
    throw new Error("Firefox update_url must be a credential-free HTTPS URL without query or fragment");
  }
  return {
    addOnId: gecko.id,
    strictMinVersion: gecko.strict_min_version,
    updateManifestUrl: updateUrl.toString(),
    version,
  };
}

export async function prepareReleaseArtifacts({ outputDir, rootDir, sourceDigest, sourceRepository }) {
  if (!rootDir || !outputDir) throw new Error("rootDir and outputDir are required");
  const identity = validateReleaseIdentity(rootDir, sourceDigest, sourceRepository);
  ensurePrivateDirectory(outputDir);
  const stageDir = mkdtempSync(join(outputDir, ".release-stage-"));
  chmodSync(stageDir, 0o700);

  try {
    const files = [];
    for (const relativePath of RELEASE_PACKAGE_FILES) {
      const sourcePath = join(rootDir, relativePath);
      const stat = assertRegularFile(sourcePath);
      const stagedPath = join(stageDir, relativePath);
      ensurePrivateDirectory(dirname(stagedPath));
      copyFileSync(sourcePath, stagedPath);
      chmodSync(stagedPath, 0o600);
      const bytes = readFileSync(stagedPath);
      files.push({ path: relativePath, sha256: sha256(bytes), size: stat.size });
    }

    const zip = new JSZip();
    for (const file of files) {
      zip.file(file.path, readFileSync(join(stageDir, file.path)), {
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
    const sourceArchiveName = `chzzk-${identity.version}.zip`;
    const sourceArchivePath = join(outputDir, sourceArchiveName);
    atomicWrite(sourceArchivePath, sourceArchiveBytes);

    const metadata = {
      addOnId: identity.addOnId,
      files,
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
    if (!SHA256_RE.test(metadata.sourceArchive.sha256)) throw new Error("Invalid source archive digest");
    const metadataName = `chzzk-${identity.version}-release-metadata.json`;
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

export function assertReleaseMetadata(metadata) {
  if (!metadata || metadata.schemaVersion !== 1) throw new Error("Unsupported release metadata schema");
  if (!VERSION_RE.test(String(metadata.version ?? ""))) throw new Error("Invalid release metadata version");
  if (typeof metadata.addOnId !== "string" || !metadata.addOnId) throw new Error("Invalid release add-on ID");
  if (!SOURCE_DIGEST_RE.test(String(metadata.sourceDigest ?? "")))
    throw new Error("Invalid release source digest");
  if (!SHA256_RE.test(String(metadata.sourceArchive?.sha256 ?? ""))) {
    throw new Error("Invalid release source archive digest");
  }
  if (basename(String(metadata.sourceArchive?.name ?? "")) !== metadata.sourceArchive.name) {
    throw new Error("Invalid release source archive name");
  }
  return metadata;
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

function rawZipEntryNames(bytes, label) {
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

  const names = [];
  const seenNames = new Set();
  const seenLocalOffsets = new Set();
  let cursor = centralOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`${label} ZIP central directory is malformed`);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      (flags & 1) !== 0 ||
      diskStart !== 0 ||
      nextCursor > endOffset ||
      localOffset + 30 > centralOffset ||
      seenLocalOffsets.has(localOffset)
    ) {
      throw new Error(`${label} ZIP entry metadata is unsafe`);
    }
    const centralNameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeSafeZipName(centralNameBytes, label);
    if (seenNames.has(name)) throw new Error(`${label} ZIP contains a duplicate raw entry name`);
    seenNames.add(name);
    seenLocalOffsets.add(localOffset);

    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${label} ZIP local entry header is malformed`);
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    if (localNameEnd + localExtraLength > centralOffset) {
      throw new Error(`${label} ZIP local entry metadata is truncated`);
    }
    const localNameBytes = bytes.subarray(localNameStart, localNameEnd);
    if (!localNameBytes.equals(centralNameBytes)) {
      throw new Error(`${label} ZIP local and central entry names differ`);
    }
    names.push(name);
    cursor = nextCursor;
  }
  if (cursor !== endOffset) throw new Error(`${label} ZIP central directory size is inconsistent`);
  return names;
}

function assertSafeZipEntries(zip, bytes, label) {
  const rawNames = rawZipEntryNames(bytes, label);
  const rawFiles = rawNames.filter((name) => !name.endsWith("/")).sort();
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
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) fail("is not valid JSON");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("contains a non-finite number");
    return value;
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

export async function verifySignedReleaseArtifacts({ metadataPath, signedXpiPath, sourceArchivePath }) {
  assertRegularFile(metadataPath);
  assertRegularFile(signedXpiPath);
  assertRegularFile(sourceArchivePath);
  const metadata = assertReleaseMetadata(readJson(metadataPath));
  const sourceBytes = readFileSync(sourceArchivePath);
  const signedBytes = readFileSync(signedXpiPath);
  if (basename(sourceArchivePath) !== metadata.sourceArchive.name) {
    throw new Error("Source archive filename does not match release metadata");
  }
  if (
    sha256(sourceBytes) !== metadata.sourceArchive.sha256 ||
    sourceBytes.length !== metadata.sourceArchive.size
  ) {
    throw new Error("Source archive bytes do not match release metadata");
  }
  if (basename(signedXpiPath) !== `chzzk-${metadata.version}-signed.xpi`) {
    throw new Error("Signed XPI filename does not match release metadata");
  }

  const sourceZip = await JSZip.loadAsync(sourceBytes, { checkCRC32: true });
  const signedZip = await JSZip.loadAsync(signedBytes, { checkCRC32: true });
  assertSafeZipEntries(sourceZip, sourceBytes, "Source archive");
  assertSafeZipEntries(signedZip, signedBytes, "Signed XPI");
  assertExactRuntimeEntries(sourceZip, "Source archive");
  assertExactRuntimeEntries(signedZip, "Signed XPI");
  const signatureEntries = Object.values(signedZip.files).filter(
    (entry) => !entry.dir && entry.name.startsWith("META-INF/"),
  );
  if (signatureEntries.length === 0 || signatureEntries.length > 20) {
    throw new Error("Signed XPI has invalid signature metadata");
  }

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
    signedXpiSha256: sha256(signedBytes),
    signedXpiSize: signedBytes.length,
    sourceDigest: metadata.sourceDigest,
    version: metadata.version,
  };
}
