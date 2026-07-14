import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { assertReleaseMetadata, verifySignedReleaseArtifacts } from "./release-artifacts.js";
import { buildUpdateManifestDocument, validateUpdateManifestDocument } from "./update-manifest.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureDirectory(path, mode) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${path}`);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(path, { mode, recursive: true });
    chmodSync(path, mode);
    return true;
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

function writeDurableFile(path, bytes, mode = 0o644) {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
}

function snapshotLink(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) throw new Error(`Managed live path is not a symbolic link: ${path}`);
    return { exists: true, target: readlinkSync(path) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, target: null };
    throw error;
  }
}

function atomicSymlink(target, path) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  symlinkSync(target, temporaryPath);
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function restoreLink(path, snapshot) {
  if (snapshot.exists) {
    atomicSymlink(snapshot.target, path);
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function exactDirectoryMatches(path, files) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const expectedNames = [...files.keys()].sort();
    const actualNames = readdirSync(path).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) return false;
    for (const [name, expected] of files) {
      const filePath = join(path, name);
      const fileStat = lstatSync(filePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o777) !== 0o644) return false;
      if (!readFileSync(filePath).equals(expected)) return false;
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function indexHtml(metadata) {
  const version = metadata.version;
  return Buffer.from(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>CHZZK ${version}</title></head>
<body>
<h1>CHZZK ${version}</h1>
<ul>
<li><a href="updates.json">Firefox update manifest</a></li>
<li><a href="chzzk-${version}-release-metadata.json">Release metadata</a></li>
<li><a href="chzzk-${version}-signed.xpi">Signed XPI</a></li>
<li><a href="chzzk-${version}.zip">Unsigned source archive</a></li>
</ul>
</body>
</html>
`);
}

export async function deployUpdateRelease({
  metadataPath,
  onTransactionStep = () => {},
  signedXpiPath,
  sourceArchivePath,
  targetDir,
}) {
  if (!targetDir) throw new Error("targetDir is required");
  const verified = await verifySignedReleaseArtifacts({ metadataPath, signedXpiPath, sourceArchivePath });
  const metadataBytes = readFileSync(metadataPath);
  const metadata = assertReleaseMetadata(JSON.parse(metadataBytes.toString("utf8")));
  const signedXpiBytes = readFileSync(signedXpiPath);
  const sourceArchiveBytes = readFileSync(sourceArchivePath);
  if (verified.sourceDigest !== metadata.sourceDigest || verified.version !== metadata.version) {
    throw new Error("Verified signed release identity differs from release metadata");
  }

  const signedXpiSha256 = sha256(signedXpiBytes);
  const updateManifest = buildUpdateManifestDocument({ metadata, signedXpiBytes });
  validateUpdateManifestDocument(updateManifest, {
    expectedMetadata: metadata,
    expectedSignedXpiSha256: signedXpiSha256,
  });
  const provenance = {
    assets: {
      [basename(metadataPath)]: sha256(metadataBytes),
      [basename(signedXpiPath)]: signedXpiSha256,
      [basename(sourceArchivePath)]: sha256(sourceArchiveBytes),
    },
    schemaVersion: 1,
    sourceDigest: metadata.sourceDigest,
    sourceRepository: metadata.sourceRepository,
    version: metadata.version,
  };
  const files = new Map([
    [basename(metadataPath), metadataBytes],
    [basename(signedXpiPath), signedXpiBytes],
    [basename(sourceArchivePath), sourceArchiveBytes],
    ["index.html", indexHtml(metadata)],
    ["provenance.json", Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`)],
    ["updates.json", Buffer.from(`${JSON.stringify(updateManifest, null, 2)}\n`)],
  ]);

  ensureDirectory(targetDir, 0o755);
  const releasesDir = join(targetDir, "releases");
  ensureDirectory(releasesDir, 0o755);
  const releaseDir = join(releasesDir, metadata.version);
  const managedLinks = new Map([
    ["current", `releases/${metadata.version}`],
    ["index.html", "current/index.html"],
    ["provenance.json", "current/provenance.json"],
    ["updates.json", "current/updates.json"],
  ]);
  const snapshots = new Map(
    [...managedLinks.keys()].map((name) => [name, snapshotLink(join(targetDir, name))]),
  );
  const releaseExists = exactDirectoryMatches(releaseDir, files);
  try {
    const stat = lstatSync(releaseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !releaseExists) {
      throw new Error(`Existing immutable release differs from requested release: ${releaseDir}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const linksAlreadyExact = [...managedLinks].every(
    ([name, expectedTarget]) => snapshots.get(name).exists && snapshots.get(name).target === expectedTarget,
  );
  if (releaseExists && linksAlreadyExact) {
    return { releaseDir, reusedRelease: true, signedXpiSha256, version: metadata.version };
  }

  let createdRelease = false;
  let stageDir = null;
  if (!releaseExists) {
    stageDir = mkdtempSync(join(releasesDir, `.staging-${metadata.version}-`));
    chmodSync(stageDir, 0o700);
    try {
      for (const [name, bytes] of files) writeDurableFile(join(stageDir, name), bytes);
      fsyncDirectory(stageDir);
      chmodSync(stageDir, 0o755);
      renameSync(stageDir, releaseDir);
      stageDir = null;
      createdRelease = true;
      fsyncDirectory(releasesDir);
      onTransactionStep("release-created");
    } finally {
      if (stageDir) rmSync(stageDir, { force: true, recursive: true });
    }
  }

  try {
    for (const [name, expectedTarget] of managedLinks) {
      atomicSymlink(expectedTarget, join(targetDir, name));
      fsyncDirectory(targetDir);
      onTransactionStep(name === "current" ? "current-link" : `stable-link:${name}`);
    }
  } catch (activationError) {
    const rollbackErrors = [];
    for (const [name, snapshot] of [...snapshots].reverse()) {
      try {
        restoreLink(join(targetDir, name), snapshot);
      } catch (error) {
        rollbackErrors.push(error.message);
      }
    }
    try {
      fsyncDirectory(targetDir);
    } catch (error) {
      rollbackErrors.push(error.message);
    }
    if (rollbackErrors.length === 0 && createdRelease) {
      rmSync(releaseDir, { force: true, recursive: true });
      fsyncDirectory(releasesDir);
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${activationError.message}; rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw activationError;
  }

  if (!exactDirectoryMatches(releaseDir, files))
    throw new Error("Activated release failed post-commit verification");
  for (const [name, expectedTarget] of managedLinks) {
    if (readlinkSync(join(targetDir, name)) !== expectedTarget) {
      throw new Error(`Activated live link failed verification: ${name}`);
    }
  }
  return { releaseDir, reusedRelease: releaseExists, signedXpiSha256, version: metadata.version };
}
