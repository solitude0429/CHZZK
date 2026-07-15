import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
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
import { basename, join, parse, resolve, sep } from "node:path";

import { assertReleaseMetadata, verifySignedReleaseStructure } from "./release-artifacts.js";
import { buildUpdateManifestDocument, validateUpdateManifestDocument } from "./update-manifest.js";

const MANAGED_LINK_NAMES = Object.freeze(["current", "index.html", "provenance.json", "updates.json"]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_RE = /^[a-f0-9]{16}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeDirectoryChain(path, expectedUid) {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const components = absolutePath.slice(root.length).split(sep).filter(Boolean);
  let current = root;

  for (const component of components) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe deployment path contains a symbolic link or non-directory: ${current}`);
    }
    if (stat.uid !== 0 && stat.uid !== expectedUid) {
      throw new Error(`Unsafe deployment path ownership: ${current}`);
    }
    const stickyRootDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o022) !== 0 && !stickyRootDirectory) {
      throw new Error(`Unsafe writable deployment path permissions: ${current}`);
    }
  }
  return absolutePath;
}

function assertManagedDirectory(path, expectedUid) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Expected a real managed directory: ${path}`);
  }
  if (stat.uid !== expectedUid) {
    throw new Error(`Unsafe managed directory ownership: ${path}`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`Unsafe writable managed directory permissions: ${path}`);
  }
  return stat;
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

function assertPrivateStateDirectory(path, expectedUid) {
  const stat = assertManagedDirectory(path, expectedUid);
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`Deployment state directory must use mode 0700: ${path}`);
  }
  return stat;
}

function assertPrivateRegularFile(path, expectedUid) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Deployment state path must be a regular file: ${path}`);
  }
  if (stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`Unsafe deployment state file ownership or permissions: ${path}`);
  }
  return stat;
}

function startProcessBoundLock(lockPath) {
  const readyMarker = "chzzk-deployment-lock-ready\n";
  const child = spawn(
    "/usr/bin/flock",
    [
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "75",
      lockPath,
      "/bin/sh",
      "-c",
      `printf '${readyMarker}'; /bin/cat >/dev/null`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Timed out while acquiring deployment lock: ${lockPath}`));
    }, 5000);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.once("error", rejectOnce);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (settled || !stdout.includes(readyMarker)) return;
      settled = true;
      clearTimeout(timeout);
      let released = false;
      resolve({
        assertHeld() {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`Deployment lock holder exited unexpectedly: ${lockPath}`);
          }
        },
        async release() {
          if (released) return;
          released = true;
          child.stdin.end();
          const { code, signal } = await closed;
          if (code !== 0 || signal !== null) {
            throw new Error(
              `Deployment lock holder failed during release: ${code ?? signal ?? "unknown"}: ${stderr.trim()}`,
            );
          }
        },
      });
    });
    closed.then(({ code, signal }) => {
      if (code === 75) {
        rejectOnce(new Error(`Another update deployment is in progress: ${lockPath}`));
        return;
      }
      rejectOnce(
        new Error(`Unable to acquire deployment lock: ${code ?? signal ?? "unknown"}: ${stderr.trim()}`),
      );
    });
  });
}

async function acquireDeploymentLock(targetDir, expectedUid) {
  const stateDir = join(targetDir, ".deploy-state");
  const stateDirectoryCreated = ensureDirectory(stateDir, 0o700);
  assertPrivateStateDirectory(stateDir, expectedUid);
  if (stateDirectoryCreated) fsyncDirectory(targetDir);
  const lockPath = join(stateDir, "lock");
  try {
    writeDurableFile(lockPath, Buffer.alloc(0), 0o600);
    fsyncDirectory(stateDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  assertPrivateRegularFile(lockPath, expectedUid);
  const holder = await startProcessBoundLock(lockPath);
  return { ...holder, stateDir };
}

function writeDurableFile(path, bytes, mode = 0o644) {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, bytes);
    chmodSync(path, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
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

function exactDirectoryMatches(path, files, expectedUid) {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== expectedUid ||
      (stat.mode & 0o022) !== 0
    ) {
      return false;
    }
    const expectedNames = [...files.keys()].sort();
    const actualNames = readdirSync(path).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) return false;
    for (const [name, expected] of files) {
      const filePath = join(path, name);
      const fileStat = lstatSync(filePath);
      if (
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        fileStat.uid !== expectedUid ||
        (fileStat.mode & 0o777) !== 0o644
      ) {
        return false;
      }
      if (!readFileSync(filePath).equals(expected)) return false;
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has invalid keys: ${actual.join(", ")}`);
  }
}

function transactionPaths(stateDir) {
  return {
    journalPath: join(stateDir, "transaction.json"),
    nextPath: join(stateDir, "transaction.next"),
  };
}

function removePrivateStateFileIfPresent(path, stateDir, expectedUid) {
  try {
    assertPrivateRegularFile(path, expectedUid);
    unlinkSync(path);
    fsyncDirectory(stateDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function assertTransaction(transaction) {
  assertExactKeys(
    transaction,
    [
      "expectedFiles",
      "releaseExisted",
      "schemaVersion",
      "snapshots",
      "stageName",
      "transactionId",
      "version",
    ],
    "Deployment transaction",
  );
  if (transaction.schemaVersion !== 1) throw new Error("Unsupported deployment transaction schema");
  if (!VERSION_RE.test(String(transaction.version ?? ""))) {
    throw new Error("Deployment transaction version is invalid");
  }
  if (!TRANSACTION_ID_RE.test(String(transaction.transactionId ?? ""))) {
    throw new Error("Deployment transaction ID is invalid");
  }
  if (transaction.stageName !== `.staging-${transaction.version}-${transaction.transactionId}`) {
    throw new Error("Deployment transaction staging path is invalid");
  }
  if (typeof transaction.releaseExisted !== "boolean") {
    throw new Error("Deployment transaction release state is invalid");
  }

  assertExactKeys(transaction.snapshots, MANAGED_LINK_NAMES, "Deployment transaction snapshots");
  for (const name of MANAGED_LINK_NAMES) {
    const snapshot = transaction.snapshots[name];
    assertExactKeys(snapshot, ["exists", "target"], `Deployment transaction snapshot ${name}`);
    if (typeof snapshot.exists !== "boolean") {
      throw new Error(`Deployment transaction snapshot existence is invalid: ${name}`);
    }
    if (snapshot.exists) {
      if (
        typeof snapshot.target !== "string" ||
        !snapshot.target ||
        snapshot.target.length > 4096 ||
        snapshot.target.includes("\0")
      ) {
        throw new Error(`Deployment transaction snapshot target is invalid: ${name}`);
      }
    } else if (snapshot.target !== null) {
      throw new Error(`Deployment transaction absent snapshot has a target: ${name}`);
    }
  }

  if (
    !transaction.expectedFiles ||
    typeof transaction.expectedFiles !== "object" ||
    Array.isArray(transaction.expectedFiles)
  ) {
    throw new Error("Deployment transaction expected files are invalid");
  }
  const fileNames = Object.keys(transaction.expectedFiles);
  if (fileNames.length < 1 || fileNames.length > 32) {
    throw new Error("Deployment transaction expected file count is invalid");
  }
  for (const name of fileNames) {
    if (!name || basename(name) !== name || name === "." || name === "..") {
      throw new Error(`Deployment transaction filename is invalid: ${name}`);
    }
    const expected = transaction.expectedFiles[name];
    assertExactKeys(expected, ["sha256", "size"], `Deployment transaction file ${name}`);
    if (!SHA256_RE.test(String(expected.sha256 ?? ""))) {
      throw new Error(`Deployment transaction file digest is invalid: ${name}`);
    }
    if (!Number.isSafeInteger(expected.size) || expected.size < 0) {
      throw new Error(`Deployment transaction file size is invalid: ${name}`);
    }
  }
  return transaction;
}

function createTransaction({ files, releaseExisted, snapshots, version }) {
  const transactionId = randomBytes(8).toString("hex");
  return assertTransaction({
    expectedFiles: Object.fromEntries(
      [...files.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, bytes]) => [name, { sha256: sha256(bytes), size: bytes.length }]),
    ),
    releaseExisted,
    schemaVersion: 1,
    snapshots: Object.fromEntries(MANAGED_LINK_NAMES.map((name) => [name, snapshots.get(name)])),
    stageName: `.staging-${version}-${transactionId}`,
    transactionId,
    version,
  });
}

function writeTransaction(stateDir, transaction, expectedUid) {
  const { journalPath, nextPath } = transactionPaths(stateDir);
  removePrivateStateFileIfPresent(nextPath, stateDir, expectedUid);
  try {
    lstatSync(journalPath);
    throw new Error(`Unresolved deployment transaction already exists: ${journalPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  try {
    writeDurableFile(nextPath, Buffer.from(`${JSON.stringify(transaction, null, 2)}\n`), 0o600);
    renameSync(nextPath, journalPath);
    fsyncDirectory(stateDir);
  } catch (error) {
    try {
      removePrivateStateFileIfPresent(nextPath, stateDir, expectedUid);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function readTransaction(stateDir, expectedUid) {
  const { journalPath, nextPath } = transactionPaths(stateDir);
  removePrivateStateFileIfPresent(nextPath, stateDir, expectedUid);
  let stat;
  try {
    stat = assertPrivateRegularFile(journalPath, expectedUid);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.size <= 0 || stat.size > 1024 * 1024) {
    throw new Error(`Deployment transaction size is invalid: ${journalPath}`);
  }
  try {
    return assertTransaction(JSON.parse(readFileSync(journalPath, "utf8")));
  } catch (error) {
    throw new Error(`Deployment transaction is invalid: ${error.message}`);
  }
}

function removeTransaction(stateDir, expectedUid) {
  const { journalPath, nextPath } = transactionPaths(stateDir);
  removePrivateStateFileIfPresent(nextPath, stateDir, expectedUid);
  removePrivateStateFileIfPresent(journalPath, stateDir, expectedUid);
}

function assertRecoverableLivePaths(targetDir) {
  for (const name of MANAGED_LINK_NAMES) {
    const path = join(targetDir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink()) {
        throw new Error(`Managed live path changed type during deployment recovery: ${path}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function assertOwnedTransactionDirectory(path, expectedUid) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    throw new Error(`Unsafe transaction directory: ${path}`);
  }
  return stat;
}

function createdReleaseMatchesExpectedSubset(path, expectedFiles, expectedUid) {
  try {
    assertOwnedTransactionDirectory(path, expectedUid);
    const expectedNames = new Set(Object.keys(expectedFiles));
    for (const name of readdirSync(path)) {
      const expected = expectedFiles[name];
      if (!expectedNames.has(name) || !expected) return false;
      const filePath = join(path, name);
      const stat = lstatSync(filePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== expectedUid ||
        (stat.mode & 0o777) !== 0o644 ||
        stat.size !== expected.size ||
        sha256(readFileSync(filePath)) !== expected.sha256
      ) {
        return false;
      }
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function removeOwnedTransactionDirectory(path, expectedUid) {
  try {
    assertOwnedTransactionDirectory(path, expectedUid);
    rmSync(path, { force: true, recursive: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function rollbackTransaction({ allowChangedCreatedRelease, expectedUid, stateDir, targetDir, transaction }) {
  assertRecoverableLivePaths(targetDir);
  for (const name of [...MANAGED_LINK_NAMES].reverse()) {
    restoreLink(join(targetDir, name), transaction.snapshots[name]);
  }
  fsyncDirectory(targetDir);
  for (const name of MANAGED_LINK_NAMES) {
    const restored = snapshotLink(join(targetDir, name));
    if (JSON.stringify(restored) !== JSON.stringify(transaction.snapshots[name])) {
      throw new Error(`Deployment recovery failed to restore live link: ${name}`);
    }
  }

  const releasesDir = join(targetDir, "releases");
  assertManagedDirectory(releasesDir, expectedUid);
  const releaseDir = join(releasesDir, transaction.version);
  if (!transaction.releaseExisted) {
    if (
      !allowChangedCreatedRelease &&
      !createdReleaseMatchesExpectedSubset(releaseDir, transaction.expectedFiles, expectedUid)
    ) {
      throw new Error(`Interrupted deployment release changed unexpectedly: ${releaseDir}`);
    }
    removeOwnedTransactionDirectory(releaseDir, expectedUid);
  }
  removeOwnedTransactionDirectory(join(releasesDir, transaction.stageName), expectedUid);
  fsyncDirectory(releasesDir);
  removeTransaction(stateDir, expectedUid);
}

function recoverInterruptedTransaction({ expectedUid, stateDir, targetDir }) {
  const transaction = readTransaction(stateDir, expectedUid);
  if (!transaction) return false;
  rollbackTransaction({
    allowChangedCreatedRelease: false,
    expectedUid,
    stateDir,
    targetDir,
    transaction,
  });
  return true;
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
  const deploymentUid = process.geteuid?.();
  if (!Number.isSafeInteger(deploymentUid) || deploymentUid < 0) {
    throw new Error("Unable to determine deployment owner identity");
  }
  targetDir = assertSafeDirectoryChain(targetDir, deploymentUid);
  ensureDirectory(targetDir, 0o755);
  targetDir = assertSafeDirectoryChain(targetDir, deploymentUid);
  assertManagedDirectory(targetDir, deploymentUid);

  const releaseDeploymentLock = await acquireDeploymentLock(targetDir, deploymentUid);
  try {
    releaseDeploymentLock.assertHeld();
    recoverInterruptedTransaction({
      expectedUid: deploymentUid,
      stateDir: releaseDeploymentLock.stateDir,
      targetDir,
    });
    releaseDeploymentLock.assertHeld();
    onTransactionStep("lock-acquired");

    const verified = await verifySignedReleaseStructure({
      metadataPath,
      signedXpiPath,
      sourceArchivePath,
    });
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

    const releasesDir = join(targetDir, "releases");
    const releasesDirectoryCreated = ensureDirectory(releasesDir, 0o755);
    assertManagedDirectory(releasesDir, deploymentUid);
    if (releasesDirectoryCreated) fsyncDirectory(targetDir);
    const releaseDir = join(releasesDir, metadata.version);
    const managedLinks = new Map([
      ["current", `releases/${metadata.version}`],
      ["index.html", "current/index.html"],
      ["provenance.json", "current/provenance.json"],
      ["updates.json", "current/updates.json"],
    ]);
    const snapshots = new Map(MANAGED_LINK_NAMES.map((name) => [name, snapshotLink(join(targetDir, name))]));
    const releaseExists = exactDirectoryMatches(releaseDir, files, deploymentUid);
    try {
      assertManagedDirectory(releaseDir, deploymentUid);
      if (!releaseExists) {
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

    const transaction = createTransaction({
      files,
      releaseExisted: releaseExists,
      snapshots,
      version: metadata.version,
    });
    let stageDir = null;
    try {
      writeTransaction(releaseDeploymentLock.stateDir, transaction, deploymentUid);
      releaseDeploymentLock.assertHeld();

      if (!releaseExists) {
        stageDir = join(releasesDir, transaction.stageName);
        mkdirSync(stageDir, { mode: 0o700 });
        chmodSync(stageDir, 0o700);
        for (const [name, bytes] of files) writeDurableFile(join(stageDir, name), bytes);
        fsyncDirectory(stageDir);
        chmodSync(stageDir, 0o755);
        fsyncDirectory(stageDir);
        renameSync(stageDir, releaseDir);
        stageDir = null;
        fsyncDirectory(releasesDir);
        releaseDeploymentLock.assertHeld();
        onTransactionStep("release-created");
      }

      for (const [name, expectedTarget] of managedLinks) {
        releaseDeploymentLock.assertHeld();
        atomicSymlink(expectedTarget, join(targetDir, name));
        fsyncDirectory(targetDir);
        onTransactionStep(name === "current" ? "current-link" : `stable-link:${name}`);
      }
      releaseDeploymentLock.assertHeld();
      if (!exactDirectoryMatches(releaseDir, files, deploymentUid)) {
        throw new Error("Activated release failed post-commit verification");
      }
      for (const [name, expectedTarget] of managedLinks) {
        if (readlinkSync(join(targetDir, name)) !== expectedTarget) {
          throw new Error(`Activated live link failed verification: ${name}`);
        }
      }
      removeTransaction(releaseDeploymentLock.stateDir, deploymentUid);
      return { releaseDir, reusedRelease: releaseExists, signedXpiSha256, version: metadata.version };
    } catch (activationError) {
      try {
        rollbackTransaction({
          allowChangedCreatedRelease: true,
          expectedUid: deploymentUid,
          stateDir: releaseDeploymentLock.stateDir,
          targetDir,
          transaction,
        });
      } catch (rollbackError) {
        throw new Error(`${activationError.message}; rollback failed: ${rollbackError.message}`);
      }
      throw activationError;
    } finally {
      if (stageDir) rmSync(stageDir, { force: true, recursive: true });
    }
  } finally {
    await releaseDeploymentLock.release();
  }
}
