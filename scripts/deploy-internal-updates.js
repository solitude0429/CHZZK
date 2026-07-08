import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const packageJson = JSON.parse(
  await import("node:fs").then(({ readFileSync }) =>
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ),
);
const version = process.env.CHZZK_VERSION ?? packageJson.version;
const tag = `v${version}`;
const targetDir = process.env.CHZZK_UPDATE_DIR ?? "/var/www/chzzk-updates";
const workDir = mkdtempSync(join(tmpdir(), "chzzk-update-deploy-"));
const releaseXpi = `chzzk-${version}-signed.xpi`;
const releaseZip = `chzzk-${version}.zip`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function assertCleanWorktree() {
  const status = capture("git", ["status", "--porcelain"]);
  assert.equal(status, "", "deploy requires a clean working tree; commit or stash local changes first");
}

function currentGitCommit() {
  return capture("git", ["rev-parse", "HEAD"]);
}

function currentGitHubRepository() {
  return capture("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

function publishAtomicSymlink(sourcePath, targetPath) {
  const temporaryLink = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  rmSync(temporaryLink, { force: true });
  symlinkSync(relative(dirname(targetPath), sourcePath), temporaryLink);
  renameSync(temporaryLink, targetPath);
}

assertCleanWorktree();

const sourceDigest = process.env.CHZZK_SOURCE_COMMIT ?? currentGitCommit();
const sourceRepository = process.env.CHZZK_SOURCE_REPOSITORY ?? currentGitHubRepository();
const workflowRef = process.env.CHZZK_SIGNING_WORKFLOW_REF ?? ".github/workflows/sign-unlisted.yml";
const signerWorkflow = `${sourceRepository}/${workflowRef}`;

assert.match(sourceDigest, /^[a-f0-9]{40}$/i, "CHZZK_SOURCE_COMMIT/sourceDigest must be a full commit SHA");
assert.match(sourceRepository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "sourceRepository must be owner/repo");
assert.equal(
  workflowRef,
  ".github/workflows/sign-unlisted.yml",
  "workflowRef must be the signing workflow path",
);

run("gh", [
  "release",
  "download",
  tag,
  "--repo",
  sourceRepository,
  "-p",
  releaseXpi,
  "-p",
  releaseZip,
  "-D",
  workDir,
]);

const signedXpiPath = join(workDir, releaseXpi);
const releaseZipPath = join(workDir, releaseZip);
assert.equal(statSync(signedXpiPath).isFile(), true, `${releaseXpi} must exist`);
assert.equal(statSync(releaseZipPath).isFile(), true, `${releaseZip} must exist`);

for (const assetPath of [signedXpiPath, releaseZipPath]) {
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

const provenance = {
  releaseTag: tag,
  sourceDigest,
  sourceRepository,
  verifiedAt: new Date().toISOString(),
  workflowRef,
};
writeFileSync(join(workDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

run("node", ["scripts/build-update-manifest.js"], {
  env: {
    ...process.env,
    RELEASE_BASE_URL: "https://chzzk-updates.alpha-apple.dedyn.io",
    SIGNED_XPI: signedXpiPath,
    UPDATE_SITE_DIR: workDir,
  },
});
run("node", ["scripts/validate-update-manifest.js"], {
  env: {
    ...process.env,
    SIGNED_XPI: signedXpiPath,
    UPDATE_MANIFEST: join(workDir, "updates.json"),
  },
});

mkdirSync(targetDir, { recursive: true });
const releasesDir = join(targetDir, "releases");
mkdirSync(releasesDir, { recursive: true });
const releaseDir = join(releasesDir, version);
assert.equal(existsSync(releaseDir), false, `release directory already exists: ${releaseDir}`);
const stagingDir = mkdtempSync(join(releasesDir, `${version}.tmp-`));

try {
  for (const file of ["index.html", "provenance.json", releaseXpi, releaseZip, "updates.json"]) {
    cpSync(join(workDir, file), join(stagingDir, file));
    chmodSync(join(stagingDir, file), 0o644);
  }
  renameSync(stagingDir, releaseDir);

  for (const file of ["index.html", "provenance.json", releaseXpi, releaseZip]) {
    publishAtomicSymlink(join(releaseDir, file), join(targetDir, file));
  }
  publishAtomicSymlink(join(releaseDir, "updates.json"), join(targetDir, "updates.json"));
} catch (error) {
  rmSync(stagingDir, { force: true, recursive: true });
  throw error;
}

console.log(`deployed CHZZK ${version} update files to ${targetDir}`);
console.log("update manifest: https://chzzk-updates.alpha-apple.dedyn.io/updates.json");
