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
  for (const relativePath of RELEASE_PACKAGE_FILES) {
    const sourceFile = sourceZip.file(relativePath);
    const signedFile = signedZip.file(relativePath);
    const recorded = metadataFiles.get(relativePath);
    if (!sourceFile || !signedFile || !recorded)
      throw new Error(`Missing signed runtime file: ${relativePath}`);
    const sourceFileBytes = await sourceFile.async("nodebuffer");
    const signedFileBytes = await signedFile.async("nodebuffer");
    if (
      !sourceFileBytes.equals(signedFileBytes) ||
      sha256(sourceFileBytes) !== recorded.sha256 ||
      sourceFileBytes.length !== recorded.size
    ) {
      throw new Error(`Signed runtime file differs from release metadata: ${relativePath}`);
    }
  }

  const manifest = JSON.parse((await signedZip.file("manifest.json").async("nodebuffer")).toString("utf8"));
  assertSignedManifestIdentity(manifest, metadata);
  return {
    signedXpiSha256: sha256(signedBytes),
    signedXpiSize: signedBytes.length,
    sourceDigest: metadata.sourceDigest,
    version: metadata.version,
  };
}
