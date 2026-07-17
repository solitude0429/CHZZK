#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployUpdateRelease } from "./lib/update-deployment.js";
import { canonicalReleaseAssetNames } from "./lib/release-artifacts.js";
import { assertCanonicalReleaseVersion } from "./lib/release-version.js";

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

function resolveTagCommit(repository, tag) {
  let type = capture("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`, "--jq", ".object.type"]);
  let digest = capture("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`, "--jq", ".object.sha"]);
  if (type === "tag") {
    type = capture("gh", ["api", `repos/${repository}/git/tags/${digest}`, "--jq", ".object.type"]);
    digest = capture("gh", ["api", `repos/${repository}/git/tags/${digest}`, "--jq", ".object.sha"]);
  }
  assert.equal(type, "commit", "release tag must resolve directly to a commit");
  assert.match(digest, /^[a-f0-9]{40}$/i, "release tag commit must be a full SHA");
  return digest.toLowerCase();
}

const version = process.env.CHZZK_VERSION;
const sourceRepository = process.env.CHZZK_GITHUB_REPOSITORY;
const targetDir = process.env.CHZZK_UPDATE_DIR ?? "/var/www/chzzk-updates";
const workflowRef = ".github/workflows/sign-unlisted.yml";
const workDir = mkdtempSync(join(tmpdir(), "chzzk-update-deploy-"));
chmodSync(workDir, 0o700);

try {
  assertCanonicalReleaseVersion(version, "CHZZK_VERSION");
  assert.match(
    sourceRepository ?? "",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "CHZZK_GITHUB_REPOSITORY is required in owner/repository form",
  );
  assert.equal(
    capture("git", ["status", "--porcelain"]),
    "",
    "deploy requires a clean worktree so the verified deployment client is reviewable",
  );

  const tag = `v${version}`;
  const release = JSON.parse(
    capture("gh", [
      "release",
      "view",
      tag,
      "--repo",
      sourceRepository,
      "--json",
      "assets,isDraft,isImmutable,isPrerelease,tagName",
    ]),
  );
  assert.equal(release.isDraft, false, "release must be published before deployment");
  assert.equal(release.isPrerelease, false, "prereleases cannot be deployed to the stable update channel");
  assert.equal(release.isImmutable, true, "release must be immutable before deployment");
  assert.equal(release.tagName, tag, "release tag mismatch");
  const names = canonicalReleaseAssetNames(version);
  const expectedAssetNames = [names.metadata, names.signed, names.source].sort();
  assert.deepEqual(
    release.assets.map((asset) => asset.name).sort(),
    expectedAssetNames,
    "release must contain exactly the immutable deployment asset set",
  );

  const sourceDigest = resolveTagCommit(sourceRepository, tag);
  assert.equal(
    capture("git", ["rev-parse", "HEAD"]).toLowerCase(),
    sourceDigest,
    "deployment client checkout must match the attested release source commit",
  );
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    sourceRepository,
    "--dir",
    workDir,
    "--pattern",
    `chzzk-${version}.zip`,
    "--pattern",
    `chzzk-${version}-release-metadata.json`,
    "--pattern",
    `chzzk-${version}-signed.xpi`,
  ]);

  const metadataPath = join(workDir, `chzzk-${version}-release-metadata.json`);
  const signedXpiPath = join(workDir, `chzzk-${version}-signed.xpi`);
  const sourceArchivePath = join(workDir, `chzzk-${version}.zip`);
  const signerWorkflow = `${sourceRepository}/${workflowRef}`;
  for (const assetPath of [metadataPath, signedXpiPath, sourceArchivePath]) {
    run("gh", [
      "attestation",
      "verify",
      assetPath,
      "--repo",
      sourceRepository,
      "--source-digest",
      sourceDigest,
      "--signer-workflow",
      signerWorkflow,
    ]);
  }

  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.sourceDigest, sourceDigest, "release metadata source digest mismatch");
  assert.equal(metadata.sourceRepository, sourceRepository, "release metadata repository mismatch");
  assert.equal(metadata.version, version, "release metadata version mismatch");

  const result = await deployUpdateRelease({ metadataPath, signedXpiPath, sourceArchivePath, targetDir });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Internal update deployment failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(workDir, { force: true, recursive: true });
}
