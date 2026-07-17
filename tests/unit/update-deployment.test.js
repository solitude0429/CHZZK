import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { RELEASE_PACKAGE_FILES, prepareReleaseArtifacts } from "../../scripts/lib/release-artifacts.js";
import { deployUpdateRelease, waitForLockProcess } from "../../scripts/lib/update-deployment.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const crashFixture = fileURLToPath(new URL("../fixtures/update-deployment-crash.mjs", import.meta.url));
const STRUCTURAL_SIGNATURE_FIXTURE = Object.freeze({
  "META-INF/cose.manifest": Buffer.alloc(512, "m"),
  "META-INF/cose.sig": Buffer.alloc(1024, "c"),
  "META-INF/manifest.mf": Buffer.alloc(512, "f"),
  "META-INF/mozilla.rsa": Buffer.alloc(1024, "r"),
  "META-INF/mozilla.sf": Buffer.alloc(128, "s"),
});

function mode(path) {
  return statSync(path).mode & 0o777;
}

function makeReleaseSource(version) {
  const rootDir = mkdtempSync(join(tmpdir(), "chzzk-deploy-source-"));
  for (const file of RELEASE_PACKAGE_FILES) cpSync(join(repoRoot, file), join(rootDir, file));
  cpSync(join(repoRoot, "package.json"), join(rootDir, "package.json"));
  const manifestPath = join(rootDir, "manifest.json");
  const packagePath = join(rootDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  manifest.version = version;
  packageJson.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  return rootDir;
}

async function makeSignedRelease(version, sourceDigest) {
  const sourceRoot = makeReleaseSource(version);
  const assetDir = mkdtempSync(join(tmpdir(), "chzzk-deploy-assets-"));
  const prepared = await prepareReleaseArtifacts({
    outputDir: assetDir,
    rootDir: sourceRoot,
    sourceDigest,
    sourceRepository: "solitude0429/CHZZK",
  });
  const sourceZip = await JSZip.loadAsync(readFileSync(prepared.sourceArchivePath));
  const signedZip = new JSZip();
  for (const entry of Object.values(sourceZip.files)) {
    if (!entry.dir) signedZip.file(entry.name, await entry.async("nodebuffer"));
  }
  for (const [name, bytes] of Object.entries(STRUCTURAL_SIGNATURE_FIXTURE)) {
    signedZip.file(name, bytes, { createFolders: false });
  }
  const signedXpiPath = join(assetDir, `chzzk-${version}-signed.xpi`);
  writeFileSync(signedXpiPath, await signedZip.generateAsync({ type: "nodebuffer" }), { mode: 0o600 });
  return {
    cleanup() {
      rmSync(sourceRoot, { force: true, recursive: true });
      rmSync(assetDir, { force: true, recursive: true });
    },
    metadataPath: prepared.metadataPath,
    signedXpiPath,
    sourceArchivePath: prepared.sourceArchivePath,
  };
}

async function holdAdvisoryLock(lockPath) {
  const child = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", lockPath, "/bin/sh", "-c", 'printf "locked\\n"; cat >/dev/null'],
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

  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("locked\n")) resolve();
    });
    child.once("error", reject);
    closed.then(({ code, signal }) => {
      reject(new Error(`lock holder exited before readiness: ${code ?? signal}: ${stderr}`));
    });
  });

  return async () => {
    child.stdin.end();
    const { code, signal } = await closed;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
  };
}

describe("atomic internal update deployment", () => {
  it("bounds waits for a lock-holder child that never reports cleanup", async () => {
    const startedAt = Date.now();
    await assert.rejects(
      waitForLockProcess(new Promise(() => {}), 20, "synthetic lock cleanup"),
      /timed out|lock cleanup/i,
    );
    assert.equal(Date.now() - startedAt < 250, true);
  });

  it("preserves pre-existing directory modes and reuses an exact immutable release", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
    mkdirSync(join(targetDir, "releases"), { mode: 0o701 });
    const release = await makeSignedRelease("0.1.3", "1".repeat(40));
    try {
      const targetMode = mode(targetDir);
      const releasesMode = mode(join(targetDir, "releases"));
      const first = await deployUpdateRelease({ targetDir, ...release });
      const second = await deployUpdateRelease({ targetDir, ...release });

      assert.equal(first.version, "0.1.3");
      assert.equal(second.reusedRelease, true);
      assert.equal(mode(targetDir), targetMode);
      assert.equal(mode(join(targetDir, "releases")), releasesMode);
      assert.equal(readlinkSync(join(targetDir, "current")), "releases/0.1.3");
      assert.equal(readlinkSync(join(targetDir, "updates.json")), "current/updates.json");
      assert.equal(lstatSync(join(targetDir, "updates.json")).isSymbolicLink(), true);
      const updates = JSON.parse(readFileSync(join(targetDir, "updates.json"), "utf8"));
      assert.equal(
        updates.addons["chzzk@solitude0429.local"].updates[0].update_link,
        "https://chzzk-updates.alpha-apple.dedyn.io/releases/0.1.3/chzzk-0.1.3-signed.xpi",
      );
    } finally {
      release.cleanup();
      rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it("deploys the verifier-returned bytes even if every validated input path is replaced afterward", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
    const release = await makeSignedRelease("0.1.3", "e".repeat(40));
    const expected = new Map(
      [release.metadataPath, release.signedXpiPath, release.sourceArchivePath].map((path) => [
        basename(path),
        readFileSync(path),
      ]),
    );
    let replacedAfterVerification = false;
    try {
      await deployUpdateRelease({
        targetDir,
        ...release,
        onTransactionStep(step) {
          if (step !== "artifacts-verified") return;
          replacedAfterVerification = true;
          writeFileSync(release.metadataPath, "{}\n");
          writeFileSync(release.signedXpiPath, "replacement signed bytes");
          writeFileSync(release.sourceArchivePath, "replacement source bytes");
        },
      });

      assert.equal(replacedAfterVerification, true);
      for (const [name, bytes] of expected) {
        assert.deepEqual(readFileSync(join(targetDir, "releases/0.1.3", name)), bytes);
      }
    } finally {
      release.cleanup();
      rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it("rejects writable managed directories instead of reusing them as immutable", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
    const release = await makeSignedRelease("0.1.3", "7".repeat(40));
    try {
      await deployUpdateRelease({ targetDir, ...release });
      chmodSync(targetDir, 0o777);
      chmodSync(join(targetDir, "releases"), 0o777);
      chmodSync(join(targetDir, "releases/0.1.3"), 0o777);

      await assert.rejects(deployUpdateRelease({ targetDir, ...release }), /unsafe|writable|permissions/i);
    } finally {
      release.cleanup();
      rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it("rejects a target reached through a symbolic-link ancestor", async () => {
    const parentDir = mkdtempSync(join(tmpdir(), "chzzk-update-parent-"));
    const realParent = join(parentDir, "real");
    const linkedParent = join(parentDir, "linked");
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent, "dir");
    const release = await makeSignedRelease("0.1.3", "8".repeat(40));
    try {
      await assert.rejects(
        deployUpdateRelease({ targetDir: join(linkedParent, "updates"), ...release }),
        /symbolic link|unsafe.*path/i,
      );
    } finally {
      release.cleanup();
      rmSync(parentDir, { force: true, recursive: true });
    }
  });

  it("uses the validated normalized target instead of following a symlink hidden by parent segments", async () => {
    const targetParent = mkdtempSync(join(tmpdir(), "chzzk-deploy-normalized-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "chzzk-deploy-outside-"));
    const release = await makeSignedRelease("0.1.4", "4".repeat(40));
    try {
      mkdirSync(join(outsideRoot, "landing"), { mode: 0o755 });
      symlinkSync(join(outsideRoot, "landing"), join(targetParent, "redirected"), "dir");
      const ambiguousTarget = `${targetParent}/redirected/../updates`;

      await deployUpdateRelease({
        metadataPath: release.metadataPath,
        signedXpiPath: release.signedXpiPath,
        sourceArchivePath: release.sourceArchivePath,
        targetDir: ambiguousTarget,
      });

      assert.equal(existsSync(join(outsideRoot, "updates")), false);
      assert.equal(readlinkSync(join(targetParent, "updates", "current")), "releases/0.1.4");
    } finally {
      release.cleanup();
      rmSync(targetParent, { force: true, recursive: true });
      rmSync(outsideRoot, { force: true, recursive: true });
    }
  });

  it("fails closed while another process holds the advisory deployment lock", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
    const stateDir = join(targetDir, ".deploy-state");
    const lockPath = join(stateDir, "lock");
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(lockPath, "", { mode: 0o600 });
    const releaseLock = await holdAdvisoryLock(lockPath);
    const signedRelease = await makeSignedRelease("0.1.3", "9".repeat(40));
    try {
      await assert.rejects(
        deployUpdateRelease({ targetDir, ...signedRelease }),
        /deployment.*in progress|lock/i,
      );
    } finally {
      await releaseLock();
      signedRelease.cleanup();
      rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it("rolls back every live link and removes the new release when activation fails", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
    const firstRelease = await makeSignedRelease("0.1.3", "2".repeat(40));
    const secondRelease = await makeSignedRelease("0.1.4", "3".repeat(40));
    try {
      await deployUpdateRelease({ targetDir, ...firstRelease });
      await assert.rejects(
        deployUpdateRelease({
          targetDir,
          ...secondRelease,
          onTransactionStep(step) {
            if (step === "stable-link:updates.json") throw new Error("synthetic activation failure");
          },
        }),
        /synthetic activation failure/,
      );

      assert.equal(readlinkSync(join(targetDir, "current")), "releases/0.1.3");
      assert.equal(readlinkSync(join(targetDir, "updates.json")), "current/updates.json");
      assert.equal(lstatSync(join(targetDir, "releases/0.1.3")).isDirectory(), true);
      assert.throws(() => lstatSync(join(targetDir, "releases/0.1.4")), /ENOENT/);
      const updates = JSON.parse(readFileSync(join(targetDir, "updates.json"), "utf8"));
      assert.equal(updates.addons["chzzk@solitude0429.local"].updates[0].version, "0.1.3");
    } finally {
      firstRelease.cleanup();
      secondRelease.cleanup();
      rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it("rolls back activation when post-commit release verification fails", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
    const firstRelease = await makeSignedRelease("0.1.3", "5".repeat(40));
    const secondRelease = await makeSignedRelease("0.1.4", "6".repeat(40));
    try {
      await deployUpdateRelease({ targetDir, ...firstRelease });
      await assert.rejects(
        deployUpdateRelease({
          targetDir,
          ...secondRelease,
          onTransactionStep(step) {
            if (step === "stable-link:updates.json") {
              writeFileSync(join(targetDir, "releases/0.1.4/updates.json"), "corrupt-after-activation");
            }
          },
        }),
        /post-commit verification/,
      );

      assert.equal(readlinkSync(join(targetDir, "current")), "releases/0.1.3");
      assert.throws(() => lstatSync(join(targetDir, "releases/0.1.4")), /ENOENT/);
      const updates = JSON.parse(readFileSync(join(targetDir, "updates.json"), "utf8"));
      assert.equal(updates.addons["chzzk@solitude0429.local"].updates[0].version, "0.1.3");
    } finally {
      firstRelease.cleanup();
      secondRelease.cleanup();
      rmSync(targetDir, { force: true, recursive: true });
    }
  });

  it("recovers and retries after process death at every durable activation boundary", async () => {
    const firstRelease = await makeSignedRelease("0.1.3", "a".repeat(40));
    const secondRelease = await makeSignedRelease("0.1.4", "b".repeat(40));
    const crashSteps = ["release-created", "current-link", "stable-link:updates.json", "lock-acquired"];
    try {
      for (const crashStep of crashSteps) {
        const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
        try {
          await deployUpdateRelease({ targetDir, ...firstRelease });
          const crashed = spawnSync(process.execPath, [crashFixture], {
            encoding: "utf8",
            env: {
              ...process.env,
              CHZZK_CRASH_STEP: crashStep,
              CHZZK_METADATA_PATH: secondRelease.metadataPath,
              CHZZK_SIGNED_XPI_PATH: secondRelease.signedXpiPath,
              CHZZK_SOURCE_ARCHIVE_PATH: secondRelease.sourceArchivePath,
              CHZZK_TARGET_DIR: targetDir,
            },
            timeout: 10_000,
          });
          assert.equal(
            crashed.signal,
            "SIGKILL",
            `${crashStep}: ${crashed.error?.message ?? ""}\n${crashed.stdout}\n${crashed.stderr}`,
          );

          const retried = await deployUpdateRelease({ targetDir, ...secondRelease });
          assert.equal(retried.version, "0.1.4");
          assert.equal(readlinkSync(join(targetDir, "current")), "releases/0.1.4");
          assert.equal(readlinkSync(join(targetDir, "updates.json")), "current/updates.json");
          assert.throws(() => lstatSync(join(targetDir, ".deploy-state/transaction.json")), /ENOENT/);
          const updates = JSON.parse(readFileSync(join(targetDir, "updates.json"), "utf8"));
          assert.equal(updates.addons["chzzk@solitude0429.local"].updates[0].version, "0.1.4");
        } finally {
          rmSync(targetDir, { force: true, recursive: true });
        }
      }
    } finally {
      firstRelease.cleanup();
      secondRelease.cleanup();
    }
  });

  it("restores the pre-crash generation before a failed retry rolls back", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "chzzk-update-root-"));
    const firstRelease = await makeSignedRelease("0.1.3", "c".repeat(40));
    const secondRelease = await makeSignedRelease("0.1.4", "d".repeat(40));
    try {
      await deployUpdateRelease({ targetDir, ...firstRelease });
      const crashed = spawnSync(process.execPath, [crashFixture], {
        encoding: "utf8",
        env: {
          ...process.env,
          CHZZK_CRASH_STEP: "current-link",
          CHZZK_METADATA_PATH: secondRelease.metadataPath,
          CHZZK_SIGNED_XPI_PATH: secondRelease.signedXpiPath,
          CHZZK_SOURCE_ARCHIVE_PATH: secondRelease.sourceArchivePath,
          CHZZK_TARGET_DIR: targetDir,
        },
        timeout: 10_000,
      });
      assert.equal(crashed.signal, "SIGKILL", `${crashed.stdout}\n${crashed.stderr}`);

      await assert.rejects(
        deployUpdateRelease({
          targetDir,
          ...secondRelease,
          onTransactionStep(step) {
            if (step === "stable-link:updates.json") throw new Error("synthetic retry failure");
          },
        }),
        /synthetic retry failure/,
      );
      assert.equal(readlinkSync(join(targetDir, "current")), "releases/0.1.3");
      assert.equal(readlinkSync(join(targetDir, "updates.json")), "current/updates.json");
      assert.throws(() => lstatSync(join(targetDir, "releases/0.1.4")), /ENOENT/);
      assert.throws(() => lstatSync(join(targetDir, ".deploy-state/transaction.json")), /ENOENT/);
      const updates = JSON.parse(readFileSync(join(targetDir, "updates.json"), "utf8"));
      assert.equal(updates.addons["chzzk@solitude0429.local"].updates[0].version, "0.1.3");
    } finally {
      firstRelease.cleanup();
      secondRelease.cleanup();
      rmSync(targetDir, { force: true, recursive: true });
    }
  });
});
