import assert from "node:assert/strict";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { RELEASE_PACKAGE_FILES, prepareReleaseArtifacts } from "../../scripts/lib/release-artifacts.js";
import { deployUpdateRelease } from "../../scripts/lib/update-deployment.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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
  signedZip.file("META-INF/mozilla.rsa", Buffer.from("synthetic signature"));
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

describe("atomic internal update deployment", () => {
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
});
