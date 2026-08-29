#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const DEPLOYMENT_REPOSITORY = "solitude0429/CHZZK";
const TRUSTED_GIT_PREFIX = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
]);
const TRUSTED_SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

function trustedBootstrapExecutable(name) {
  const value = process.env[name];
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value !== resolve(value) ||
    value.includes("\0")
  ) {
    throw new Error(`Deployment bootstrap executable path is missing or malformed: ${name}`);
  }
  const path = realpathSync(value);
  const metadata = statSync(path);
  if (
    !metadata.isFile() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new Error(`Deployment bootstrap executable is not a protected system binary: ${name}`);
  }
  return path;
}

function trustedBootstrapHome() {
  const value = process.env.CHZZK_UPDATE_DEPLOY_TRUSTED_GH_HOME;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value !== resolve(value) ||
    value.includes("\0")
  ) {
    throw new Error("Deployment bootstrap GitHub home path is missing or malformed");
  }
  const metadata = statSync(value, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== currentUid || (metadata.mode & 0o077n) !== 0n) {
    throw new Error("Deployment bootstrap GitHub home is not a private operator-owned directory");
  }
  for (const child of ["cache", "config"]) {
    const childMetadata = statSync(join(value, child), { bigint: true });
    if (
      !childMetadata.isDirectory() ||
      childMetadata.uid !== currentUid ||
      (childMetadata.mode & 0o077n) !== 0n
    ) {
      throw new Error(`Deployment bootstrap GitHub ${child} directory is not private`);
    }
  }
  return value;
}

function trustedBootstrapWorkDir() {
  const value = process.env.CHZZK_UPDATE_DEPLOY_WORK_DIR;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value !== resolve(value) ||
    value.includes("\0")
  ) {
    throw new Error("Deployment bootstrap work directory path is missing or malformed");
  }
  const metadata = statSync(value, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== currentUid || (metadata.mode & 0o077n) !== 0n) {
    throw new Error("Deployment bootstrap work directory is not a private operator-owned directory");
  }
  return value;
}

function readBootstrapContext() {
  if (process.env.GITHUB_ACTIONS) {
    throw new Error("Internal update deployment must run out of band, never in GitHub Actions");
  }
  if (!import.meta.url.startsWith("data:text/javascript;base64,")) {
    throw new Error("Internal update deployment entrypoint was not memory-sealed by the bootstrap");
  }
  const sourceSha = String(process.env.CHZZK_UPDATE_DEPLOY_BOOTSTRAP_SHA ?? "").toLowerCase();
  const defaultBranch = process.env.CHZZK_UPDATE_DEPLOY_DEFAULT_BRANCH;
  const checkout = process.env.CHZZK_UPDATE_DEPLOY_CHECKOUT;
  if (!FULL_GIT_SHA_RE.test(sourceSha)) {
    throw new Error("Internal update deployment requires an exact protected-head bootstrap SHA");
  }
  if (typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    throw new Error("Internal update deployment requires a protected default-branch identity");
  }
  if (
    typeof checkout !== "string" ||
    !checkout.startsWith("/") ||
    checkout !== resolve(checkout) ||
    checkout.includes("\0")
  ) {
    throw new Error("Internal update deployment checkout path is missing or malformed");
  }
  const checkoutRoot = realpathSync(checkout);
  if (!statSync(checkoutRoot).isDirectory()) {
    throw new Error("Internal update deployment checkout must resolve to a directory");
  }
  return {
    checkoutRoot,
    defaultBranch,
    gh: trustedBootstrapExecutable("CHZZK_UPDATE_DEPLOY_TRUSTED_GH"),
    ghHome: trustedBootstrapHome(),
    git: trustedBootstrapExecutable("CHZZK_UPDATE_DEPLOY_TRUSTED_GIT"),
    sourceSha,
    workDir: trustedBootstrapWorkDir(),
  };
}

function createTrustedChildEnvironments(token, ghHome) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Internal update deployment requires an explicit narrow GH_TOKEN");
  }
  const common = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: TRUSTED_SYSTEM_PATH,
  };
  const git = Object.freeze({
    ...common,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: ghHome,
    XDG_CONFIG_HOME: join(ghHome, "config"),
  });
  const gh = Object.freeze({
    ...git,
    GH_CONFIG_DIR: join(ghHome, "config"),
    GH_HOST: "github.com",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    HOME: ghHome,
    XDG_CACHE_HOME: join(ghHome, "cache"),
  });
  return Object.freeze({ gh, git });
}

function sanitizeDeploymentProcessEnvironment() {
  for (const name of Object.keys(process.env)) delete process.env[name];
  process.env.LANG = "C.UTF-8";
  process.env.LC_ALL = "C.UTF-8";
  process.env.PATH = TRUSTED_SYSTEM_PATH;
}

function createTrustedCommandRunner(context, environments) {
  return (command, args, options = {}) => {
    if (
      (command !== "git" && command !== "gh") ||
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
    ) {
      throw new Error("Internal update deployment command is not allowlisted or is malformed");
    }
    const executable = context[command];
    const commandArgs = command === "git" ? [...TRUSTED_GIT_PREFIX, ...args] : args;
    const result = spawnSync(executable, commandArgs, {
      cwd: options.cwd,
      encoding: options.stdio === "inherit" ? undefined : "utf8",
      env: environments[command],
      maxBuffer: 16 * 1024 * 1024,
      stdio: options.stdio,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "unknown command failure").trim();
      throw new Error(`${command} command failed: ${detail}`);
    }
    return String(result.stdout ?? "").trim();
  };
}

async function loadDeploymentLibraries() {
  const [{ deployUpdateRelease }, { canonicalReleaseAssetNames }, { assertCanonicalReleaseVersion }] =
    await Promise.all([
      import("./lib/update-deployment.js"),
      import("./lib/release-artifacts.js"),
      import("./lib/release-version.js"),
    ]);
  return { assertCanonicalReleaseVersion, canonicalReleaseAssetNames, deployUpdateRelease };
}

function resolveTagCommit(runCommand, cwd, repository, tag) {
  let type = runCommand("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`, "--jq", ".object.type"], {
    cwd,
  });
  let digest = runCommand("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`, "--jq", ".object.sha"], {
    cwd,
  });
  if (type === "tag") {
    type = runCommand("gh", ["api", `repos/${repository}/git/tags/${digest}`, "--jq", ".object.type"], {
      cwd,
    });
    digest = runCommand("gh", ["api", `repos/${repository}/git/tags/${digest}`, "--jq", ".object.sha"], {
      cwd,
    });
  }
  assert.equal(type, "commit", "release tag must resolve directly to a commit");
  assert.match(digest, /^[a-f0-9]{40}$/i, "release tag commit must be a full SHA");
  return digest.toLowerCase();
}

function readProtectedDefaultHead(runCommand, cwd, repository, defaultBranch) {
  const branch = JSON.parse(
    runCommand("gh", ["api", `repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`], { cwd }),
  );
  const sourceSha = String(branch?.commit?.sha ?? "").toLowerCase();
  assert.equal(branch?.name, defaultBranch, "deployment default-branch identity changed");
  assert.equal(branch?.protected, true, "deployment default branch is no longer protected");
  assert.match(sourceSha, FULL_GIT_SHA_RE, "deployment default branch did not resolve to one commit");
  return sourceSha;
}

export async function deployInternalUpdateFromProtectedEntrypoint({
  assertVersion,
  canonicalNames,
  checkoutRoot,
  defaultBranch,
  deployRelease,
  runCommand,
  sourceRepository,
  sourceSha,
  targetDir,
  version,
  workDir,
}) {
  if (
    typeof assertVersion !== "function" ||
    typeof canonicalNames !== "function" ||
    typeof deployRelease !== "function"
  ) {
    throw new Error("Internal update deployment libraries were not sealed by the bootstrap");
  }
  assertVersion(version, "CHZZK_VERSION");
  assert.equal(
    sourceRepository,
    DEPLOYMENT_REPOSITORY,
    "CHZZK_GITHUB_REPOSITORY must match the pinned CHZZK repository",
  );
  assert.match(
    defaultBranch ?? "",
    /^[A-Za-z0-9._/-]+$/,
    "deployment default branch is missing or malformed",
  );
  if (
    typeof workDir !== "string" ||
    !workDir.startsWith("/") ||
    workDir !== resolve(workDir) ||
    workDir.includes("\0")
  ) {
    throw new Error("Deployment work directory must be one canonical absolute path");
  }
  const workDirMetadata = statSync(workDir, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : workDirMetadata.uid;
  if (
    !workDirMetadata.isDirectory() ||
    workDirMetadata.uid !== currentUid ||
    (workDirMetadata.mode & 0o077n) !== 0n
  ) {
    throw new Error("Deployment work directory must be private and operator-owned");
  }
  assert.equal(
    runCommand("git", ["status", "--porcelain"], { cwd: checkoutRoot }),
    "",
    "deploy requires a clean worktree so the verified deployment client is reviewable",
  );
  assert.equal(
    runCommand("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot }).toLowerCase(),
    sourceSha,
    "deployment checkout must remain at the protected bootstrap head",
  );

  const tag = `v${version}`;
  const release = JSON.parse(
    runCommand(
      "gh",
      [
        "release",
        "view",
        tag,
        "--repo",
        sourceRepository,
        "--json",
        "assets,isDraft,isImmutable,isPrerelease,tagName",
      ],
      { cwd: checkoutRoot },
    ),
  );
  assert.equal(release.isDraft, false, "release must be published before deployment");
  assert.equal(release.isPrerelease, false, "prereleases cannot be deployed to the stable update channel");
  assert.equal(release.isImmutable, true, "release must be immutable before deployment");
  assert.equal(release.tagName, tag, "release tag mismatch");
  const names = canonicalNames(version);
  const expectedAssetNames = [names.metadata, names.signed, names.source].sort();
  assert.deepEqual(
    release.assets.map((asset) => asset.name).sort(),
    expectedAssetNames,
    "release must contain exactly the immutable deployment asset set",
  );

  const sourceDigest = resolveTagCommit(runCommand, checkoutRoot, sourceRepository, tag);
  assert.equal(
    sourceDigest,
    sourceSha,
    "deployment release source must match the exact protected bootstrap head",
  );

  try {
    runCommand(
      "gh",
      [
        "release",
        "download",
        tag,
        "--repo",
        sourceRepository,
        "--dir",
        workDir,
        "--pattern",
        names.source,
        "--pattern",
        names.metadata,
        "--pattern",
        names.signed,
      ],
      { cwd: checkoutRoot, stdio: "inherit" },
    );

    const metadataPath = join(workDir, names.metadata);
    const signedXpiPath = join(workDir, names.signed);
    const sourceArchivePath = join(workDir, names.source);
    const signerWorkflow = `${sourceRepository}/.github/workflows/sign-unlisted.yml`;
    for (const assetPath of [metadataPath, signedXpiPath, sourceArchivePath]) {
      runCommand(
        "gh",
        [
          "attestation",
          "verify",
          assetPath,
          "--repo",
          sourceRepository,
          "--source-digest",
          sourceDigest,
          "--signer-workflow",
          signerWorkflow,
        ],
        { cwd: checkoutRoot, stdio: "inherit" },
      );
    }

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.sourceDigest, sourceDigest, "release metadata source digest mismatch");
    assert.equal(metadata.sourceRepository, sourceRepository, "release metadata repository mismatch");
    assert.equal(metadata.version, version, "release metadata version mismatch");

    assert.equal(
      runCommand("git", ["status", "--porcelain"], { cwd: checkoutRoot }),
      "",
      "deployment checkout changed before target mutation",
    );
    assert.equal(
      runCommand("git", ["rev-parse", "HEAD"], { cwd: checkoutRoot }).toLowerCase(),
      sourceSha,
      "deployment checkout head changed before target mutation",
    );
    assert.equal(
      runCommand("git", ["symbolic-ref", "--short", "HEAD"], { cwd: checkoutRoot }),
      defaultBranch,
      "deployment checkout branch changed before target mutation",
    );
    assert.equal(
      readProtectedDefaultHead(runCommand, checkoutRoot, sourceRepository, defaultBranch),
      sourceSha,
      "protected default-branch head changed before target mutation",
    );
    return await deployRelease({ metadataPath, signedXpiPath, sourceArchivePath, targetDir });
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

async function main() {
  const token = process.env.GH_TOKEN;
  const version = process.env.CHZZK_VERSION;
  const sourceRepository = process.env.CHZZK_GITHUB_REPOSITORY;
  const targetDir = process.env.CHZZK_UPDATE_DIR ?? "/srv/admin/chzzk-updates";
  const context = readBootstrapContext();
  const environments = createTrustedChildEnvironments(token, context.ghHome);
  sanitizeDeploymentProcessEnvironment();
  const runCommand = createTrustedCommandRunner(context, environments);
  const localBranch = runCommand("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: context.checkoutRoot,
  });
  assert.equal(localBranch, context.defaultBranch, "deployment checkout left the protected default branch");
  const { assertCanonicalReleaseVersion, canonicalReleaseAssetNames, deployUpdateRelease } =
    await loadDeploymentLibraries();
  const result = await deployInternalUpdateFromProtectedEntrypoint({
    assertVersion: assertCanonicalReleaseVersion,
    canonicalNames: canonicalReleaseAssetNames,
    checkoutRoot: context.checkoutRoot,
    defaultBranch: context.defaultBranch,
    deployRelease: deployUpdateRelease,
    runCommand,
    sourceRepository,
    sourceSha: context.sourceSha,
    targetDir,
    version,
    workDir: context.workDir,
  });
  console.log(JSON.stringify(result));
}

function shouldRunMain() {
  if (import.meta.url.startsWith("data:text/javascript;base64,")) return true;
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (shouldRunMain()) {
  try {
    await main();
  } catch (error) {
    console.error(`Internal update deployment failed: ${error.message}`);
    process.exitCode = 1;
  }
}
