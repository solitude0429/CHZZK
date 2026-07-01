import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, cpSync, chmodSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

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

function currentGitCommit() {
  return capture("git", ["rev-parse", "HEAD"]);
}

function currentGitHubRepository() {
  return capture("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

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

run("gh", ["release", "download", tag, "-p", releaseXpi, "-p", releaseZip, "-D", workDir]);

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
for (const file of ["index.html", "provenance.json", releaseXpi, releaseZip, "updates.json"]) {
  cpSync(join(workDir, file), join(targetDir, file));
  chmodSync(join(targetDir, file), 0o644);
}

console.log(`deployed CHZZK ${version} update files to ${targetDir}`);
console.log("update manifest: https://chzzk-updates.alpha-apple.dedyn.io/updates.json");
