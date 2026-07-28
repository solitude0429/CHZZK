#!/bin/sh
// 2>/dev/null; if [ "${CHZZK_UPDATE_DEPLOY_PARENT_BOUNDARY-}" != 1 ] || [ "${PATH-}" != /usr/local/bin:/usr/bin:/bin ] || [ "${ALL_PROXY+x}" = x ] || [ "${BASH_ENV+x}" = x ] || [ "${CURL_CA_BUNDLE+x}" = x ] || [ "${ENV+x}" = x ] || [ "${GH_ENTERPRISE_TOKEN+x}" = x ] || [ "${GH_TOKEN+x}" = x ] || [ "${GITHUB_ACTIONS+x}" = x ] || [ "${GITHUB_ENTERPRISE_TOKEN+x}" = x ] || [ "${GITHUB_TOKEN+x}" = x ] || [ "${HTTPS_PROXY+x}" = x ] || [ "${HTTP_PROXY+x}" = x ] || [ "${LD_AUDIT+x}" = x ] || [ "${LD_LIBRARY_PATH+x}" = x ] || [ "${LD_PRELOAD+x}" = x ] || [ "${NODE_EXTRA_CA_CERTS+x}" = x ] || [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_PATH+x}" = x ] || [ "${NO_PROXY+x}" = x ] || [ "${REQUESTS_CA_BUNDLE+x}" = x ] || [ "${SSL_CERT_DIR+x}" = x ] || [ "${SSL_CERT_FILE+x}" = x ] || [ "${XDG_CONFIG_HOME+x}" = x ] || [ "${all_proxy+x}" = x ] || [ "${http_proxy+x}" = x ] || [ "${https_proxy+x}" = x ] || [ "${no_proxy+x}" = x ]; then echo "Internal update deployment bootstrap requires the documented trusted parent-shell boundary" >&2; exit 1; fi; exec /usr/bin/env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/node "$0" --chzzk-clean-bootstrap "$@"; exit $?
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const DEPLOYMENT_REPOSITORY = "solitude0429/CHZZK";
const DEPLOYMENT_REPOSITORY_ID = 1_275_903_171;
const GITHUB_API_HEADERS = Object.freeze([
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
]);
const DEPLOYMENT_SOURCE_PATHS = Object.freeze([
  "scripts/deploy-internal-updates.js",
  "scripts/lib/amo-client.js",
  "scripts/lib/release-artifacts.js",
  "scripts/lib/release-version.js",
  "scripts/lib/update-deployment.js",
  "scripts/lib/update-manifest.js",
]);
const MAX_SOURCE_BYTES = 512 * 1024;
const JSZIP_BUNDLE_PATH = "node_modules/jszip/dist/jszip.min.js";
const JSZIP_BUNDLE_BYTES = 97_630;
const JSZIP_BUNDLE_SHA256 = "acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e";
const TRUSTED_EXECUTABLE_CANDIDATES = Object.freeze({
  gh: Object.freeze(["/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"]),
  git: Object.freeze(["/usr/bin/git", "/bin/git"]),
  node: Object.freeze(["/usr/bin/node", "/usr/local/bin/node", "/bin/node"]),
});
const TRUSTED_GIT_PREFIX = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
]);
const TRUSTED_SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function apiArgs(endpoint) {
  return ["api", "--method", "GET", ...GITHUB_API_HEADERS, endpoint];
}

function gitBlobSha(bytes) {
  const value = Buffer.from(bytes);
  return createHash("sha1")
    .update(Buffer.from(`blob ${value.length}\0`))
    .update(value)
    .digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function decodeProtectedDeploymentSource(record, expectedPath) {
  if (
    record?.type !== "file" ||
    record?.path !== expectedPath ||
    record?.encoding !== "base64" ||
    !Number.isSafeInteger(record?.size) ||
    record.size <= 0 ||
    record.size > MAX_SOURCE_BYTES ||
    !FULL_GIT_SHA_RE.test(String(record?.sha ?? "").toLowerCase()) ||
    typeof record?.content !== "string"
  ) {
    throw new Error(`Protected deployment source record is missing or malformed: ${expectedPath}`);
  }
  if (/[^A-Za-z0-9+/=\r\n]/.test(record.content)) {
    throw new Error(`Protected deployment source is not canonical base64: ${expectedPath}`);
  }
  const encoded = record.content.replace(/[\r\n]/g, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(`Protected deployment source is not canonical base64: ${expectedPath}`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length !== record.size ||
    gitBlobSha(bytes) !== record.sha.toLowerCase()
  ) {
    throw new Error(`Protected deployment source bytes do not match the Git blob: ${expectedPath}`);
  }
  return bytes;
}

function trustedExecutable(command) {
  const candidates = TRUSTED_EXECUTABLE_CANDIDATES[command];
  if (!candidates) throw new Error(`Deployment bootstrap command is not allowlisted: ${command}`);
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      const metadata = statSync(path);
      if (
        metadata.isFile() &&
        metadata.uid === 0 &&
        (metadata.mode & 0o022) === 0 &&
        (metadata.mode & 0o111) !== 0
      ) {
        return path;
      }
    } catch {
      // Try the next fixed system path.
    }
  }
  throw new Error(`No root-owned, non-writable system ${command} executable is available`);
}

function assertPrivateOperatorDirectory(path, label) {
  if (typeof path !== "string" || !path.startsWith("/") || path !== resolve(path) || path.includes("\0")) {
    throw new Error(`${label} must be one canonical absolute path`);
  }
  const metadata = statSync(path, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== currentUid || (metadata.mode & 0o077n) !== 0n) {
    throw new Error(`${label} must be a private operator-owned directory`);
  }
  return path;
}

function assertTrustedGhHome(ghHome) {
  const privateHome = assertPrivateOperatorDirectory(ghHome, "Deployment bootstrap GitHub home");
  for (const child of ["cache", "config"]) {
    assertPrivateOperatorDirectory(
      join(privateHome, child),
      `Deployment bootstrap GitHub ${child} directory`,
    );
  }
  return privateHome;
}

function createTrustedGhHome() {
  const ghHome = mkdtempSync("/tmp/chzzk-update-deploy-gh-");
  try {
    chmodSync(ghHome, 0o700);
    mkdirSync(join(ghHome, "cache"), { mode: 0o700 });
    mkdirSync(join(ghHome, "config"), { mode: 0o700 });
    return assertTrustedGhHome(ghHome);
  } catch (error) {
    rmSync(ghHome, { force: true, recursive: true });
    throw error;
  }
}

export function createTrustedDeploymentEnvironments(token, ghHome) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Internal update deployment bootstrap requires an explicit narrow GH_TOKEN");
  }
  const privateGhHome = assertTrustedGhHome(ghHome);
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
    HOME: privateGhHome,
    XDG_CONFIG_HOME: join(privateGhHome, "config"),
  });
  const gh = Object.freeze({
    ...git,
    GH_CONFIG_DIR: join(privateGhHome, "config"),
    GH_HOST: "github.com",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    HOME: privateGhHome,
    XDG_CACHE_HOME: join(privateGhHome, "cache"),
  });
  return Object.freeze({ gh, git });
}

function createTrustedCommandRunner(executables, environments) {
  return (command, args, options = {}) => {
    if (
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
    ) {
      throw new Error("Deployment bootstrap command arguments are malformed");
    }
    const executable = executables[command];
    if (!executable || (command !== "git" && command !== "gh")) {
      throw new Error(`Deployment bootstrap command is not allowlisted: ${command}`);
    }
    const commandArgs = command === "git" ? [...TRUSTED_GIT_PREFIX, ...args] : args;
    const result = spawnSync(executable, commandArgs, {
      cwd: options.cwd,
      encoding: "utf8",
      env: environments[command],
      input: options.input,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || "unknown command failure").trim();
      throw new Error(`${command} command failed: ${detail}`);
    }
    return result.stdout;
  };
}

function sanitizeBootstrapProcessEnvironment() {
  for (const name of Object.keys(process.env)) delete process.env[name];
  process.env.LANG = "C.UTF-8";
  process.env.LC_ALL = "C.UTF-8";
  process.env.PATH = TRUSTED_SYSTEM_PATH;
}

function capture(runCommand, command, args, cwd) {
  return String(runCommand(command, args, { cwd })).trim();
}

function exactRepositoryOrigin(origin, repository) {
  const lowerRepository = repository.toLowerCase();
  const normalized = String(origin ?? "")
    .trim()
    .toLowerCase();
  return new Set([
    `git@github.com:${lowerRepository}`,
    `git@github.com:${lowerRepository}.git`,
    `https://github.com/${lowerRepository}`,
    `https://github.com/${lowerRepository}.git`,
    `ssh://git@github.com/${lowerRepository}`,
    `ssh://git@github.com/${lowerRepository}.git`,
  ]).has(normalized);
}

function pathIsWithin(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function assertExternalInstalledBootstrap(bootstrapFile, checkoutRoot) {
  if (
    typeof bootstrapFile !== "string" ||
    !bootstrapFile.startsWith("/") ||
    bootstrapFile !== resolve(bootstrapFile) ||
    bootstrapFile.includes("\0")
  ) {
    throw new Error("Deployment bootstrap must be invoked by one absolute installed path");
  }
  const canonicalPath = realpathSync(bootstrapFile);
  if (pathIsWithin(checkoutRoot, canonicalPath)) {
    throw new Error("Deployment bootstrap must be an external installed copy");
  }
  if (!canonicalPath.endsWith(".mjs")) {
    throw new Error("Deployment bootstrap installed copy must use an .mjs filename");
  }
  const metadata = statSync(canonicalPath, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isFile() || metadata.uid !== currentUid || (metadata.mode & 0o777n) !== 0o500n) {
    throw new Error("Deployment bootstrap installed copy must be operator-owned mode 0500");
  }
  assertPrivateOperatorDirectory(dirname(canonicalPath), "Deployment bootstrap installation directory");
  return canonicalPath;
}

function moduleDataUrl(bytes) {
  return `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
}

function rewriteSpecifier(source, specifier, moduleUrl, expectedCount, label) {
  const token = JSON.stringify(specifier);
  const actualCount = source.split(token).length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(`${label} must import ${specifier} exactly ${expectedCount} time(s)`);
  }
  return source.replaceAll(token, JSON.stringify(moduleUrl));
}

function rejectUnsealedImports(source, label) {
  if (/["']\.\.?\//.test(source) || /\bfrom\s+["']jszip["']/.test(source)) {
    throw new Error(`${label} contains an unsealed deployment import`);
  }
}

export function buildSealedDeploymentEntrypoint(sourceBytes, jsZipModuleUrl) {
  if (!(sourceBytes instanceof Map)) {
    throw new Error("Protected deployment sources must use one exact path map");
  }
  const actualPaths = [...sourceBytes.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify([...DEPLOYMENT_SOURCE_PATHS].sort())) {
    throw new Error("Protected deployment source path set is incomplete or contains extras");
  }
  if (
    typeof jsZipModuleUrl !== "string" ||
    !jsZipModuleUrl.startsWith("file:") ||
    jsZipModuleUrl.includes("\0")
  ) {
    throw new Error("Verified JSZip module URL is missing or malformed");
  }
  const source = (path) => {
    const bytes = sourceBytes.get(path);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) {
      throw new Error(`Protected deployment source bytes are missing or malformed: ${path}`);
    }
    return bytes.toString("utf8");
  };

  const versionUrl = moduleDataUrl(sourceBytes.get("scripts/lib/release-version.js"));

  let amoSource = source("scripts/lib/amo-client.js");
  amoSource = rewriteSpecifier(amoSource, "./release-version.js", versionUrl, 1, "amo-client.js");
  rejectUnsealedImports(amoSource, "amo-client.js");
  const amoUrl = moduleDataUrl(amoSource);

  let artifactsSource = source("scripts/lib/release-artifacts.js");
  artifactsSource = rewriteSpecifier(artifactsSource, "jszip", jsZipModuleUrl, 1, "release-artifacts.js");
  artifactsSource = rewriteSpecifier(artifactsSource, "./amo-client.js", amoUrl, 2, "release-artifacts.js");
  artifactsSource = rewriteSpecifier(
    artifactsSource,
    "./release-version.js",
    versionUrl,
    1,
    "release-artifacts.js",
  );
  rejectUnsealedImports(artifactsSource, "release-artifacts.js");
  const artifactsUrl = moduleDataUrl(artifactsSource);

  let manifestSource = source("scripts/lib/update-manifest.js");
  manifestSource = rewriteSpecifier(
    manifestSource,
    "./release-artifacts.js",
    artifactsUrl,
    1,
    "update-manifest.js",
  );
  rejectUnsealedImports(manifestSource, "update-manifest.js");
  const manifestUrl = moduleDataUrl(manifestSource);

  let deploymentSource = source("scripts/lib/update-deployment.js");
  deploymentSource = rewriteSpecifier(
    deploymentSource,
    "./release-artifacts.js",
    artifactsUrl,
    1,
    "update-deployment.js",
  );
  deploymentSource = rewriteSpecifier(
    deploymentSource,
    "./release-version.js",
    versionUrl,
    1,
    "update-deployment.js",
  );
  deploymentSource = rewriteSpecifier(
    deploymentSource,
    "./update-manifest.js",
    manifestUrl,
    1,
    "update-deployment.js",
  );
  rejectUnsealedImports(deploymentSource, "update-deployment.js");
  const deploymentUrl = moduleDataUrl(deploymentSource);

  let entrypointSource = source("scripts/deploy-internal-updates.js");
  entrypointSource = rewriteSpecifier(
    entrypointSource,
    "./lib/update-deployment.js",
    deploymentUrl,
    1,
    "deploy-internal-updates.js",
  );
  entrypointSource = rewriteSpecifier(
    entrypointSource,
    "./lib/release-artifacts.js",
    artifactsUrl,
    1,
    "deploy-internal-updates.js",
  );
  entrypointSource = rewriteSpecifier(
    entrypointSource,
    "./lib/release-version.js",
    versionUrl,
    1,
    "deploy-internal-updates.js",
  );
  rejectUnsealedImports(entrypointSource, "deploy-internal-updates.js");
  return moduleDataUrl(entrypointSource);
}

function readVerifiedJsZipBundle(checkoutRoot) {
  const path = join(checkoutRoot, JSZIP_BUNDLE_PATH);
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size !== JSZIP_BUNDLE_BYTES) {
      throw new Error("Pinned JSZip bundle size is missing or mismatched");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size ||
      sha256(bytes) !== JSZIP_BUNDLE_SHA256
    ) {
      throw new Error("Pinned JSZip bundle changed while it was verified");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function executeSealedEntrypoint({
  checkoutRoot,
  context,
  jsZipBytes,
  nodeEnvironment,
  sourceBytes,
  trustedExecutables,
}) {
  const executionDir = mkdtempSync("/tmp/chzzk-update-deploy-exec-");
  chmodSync(executionDir, 0o700);
  try {
    const artifactDir = join(executionDir, "artifacts");
    mkdirSync(artifactDir, { mode: 0o700 });
    chmodSync(artifactDir, 0o700);
    const jsZipPath = join(executionDir, "jszip-3.10.1.cjs");
    writeFileSync(jsZipPath, jsZipBytes, { flag: "wx", mode: 0o600 });
    chmodSync(jsZipPath, 0o600);
    const entrypointUrl = buildSealedDeploymentEntrypoint(sourceBytes, pathToFileURL(jsZipPath).href);
    const loaderPath = join(executionDir, "sealed-deployment-loader.mjs");
    writeFileSync(loaderPath, `await import(${JSON.stringify(entrypointUrl)});\n`, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(loaderPath, 0o600);
    const result = spawnSync(trustedExecutables.node, [loaderPath], {
      cwd: checkoutRoot,
      env: {
        ...nodeEnvironment,
        CHZZK_GITHUB_REPOSITORY: context.repository,
        CHZZK_UPDATE_DEPLOY_BOOTSTRAP_SHA: context.sourceSha,
        CHZZK_UPDATE_DEPLOY_CHECKOUT: checkoutRoot,
        CHZZK_UPDATE_DEPLOY_DEFAULT_BRANCH: context.defaultBranch,
        CHZZK_UPDATE_DEPLOY_TRUSTED_GH: trustedExecutables.gh,
        CHZZK_UPDATE_DEPLOY_TRUSTED_GH_HOME: context.trustedGhHome,
        CHZZK_UPDATE_DEPLOY_TRUSTED_GIT: trustedExecutables.git,
        CHZZK_UPDATE_DEPLOY_WORK_DIR: artifactDir,
        CHZZK_UPDATE_DIR: context.targetDir,
        CHZZK_VERSION: context.version,
      },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Protected deployment entrypoint exited with status ${result.status ?? "unknown"}`);
    }
  } finally {
    rmSync(executionDir, { force: true, recursive: true });
  }
}

export async function runProtectedDeploymentEntrypoint({
  bootstrapFile,
  checkout,
  executeEntrypoint = executeSealedEntrypoint,
  nodeEnvironment,
  readJsZipBundle = readVerifiedJsZipBundle,
  repository,
  runCommand,
  targetDir = "/var/www/chzzk-updates",
  trustedExecutables,
  trustedGhHome,
  version,
}) {
  if (process.env.GITHUB_ACTIONS) {
    throw new Error("Internal update deployment bootstrap must run out of band");
  }
  if (repository !== DEPLOYMENT_REPOSITORY) {
    throw new Error("Deployment repository does not match the pinned CHZZK repository");
  }
  if (
    typeof version !== "string" ||
    !/^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(version)
  ) {
    throw new Error("Deployment version must be canonical MAJOR.MINOR.PATCH");
  }
  if (typeof targetDir !== "string" || !targetDir.startsWith("/") || targetDir !== resolve(targetDir)) {
    throw new Error("Deployment target must be one canonical absolute path");
  }
  if (typeof runCommand !== "function") {
    throw new Error("Deployment bootstrap requires a trusted command runner");
  }
  if (
    typeof checkout !== "string" ||
    !checkout.startsWith("/") ||
    checkout !== resolve(checkout) ||
    checkout.includes("\0")
  ) {
    throw new Error("Deployment checkout must be one canonical absolute path");
  }
  if (
    typeof trustedExecutables?.gh !== "string" ||
    typeof trustedExecutables?.git !== "string" ||
    typeof trustedExecutables?.node !== "string" ||
    Object.values(trustedExecutables).some(
      (path) => !path.startsWith("/") || path !== resolve(path) || path.includes("\0"),
    )
  ) {
    throw new Error("Deployment bootstrap trusted executable paths are malformed");
  }
  const privateGhHome = assertTrustedGhHome(trustedGhHome);
  const checkoutRoot = realpathSync(resolve(String(checkout ?? "")));
  if (!statSync(checkoutRoot).isDirectory()) {
    throw new Error("Deployment checkout must resolve to a directory");
  }
  const localRoot = capture(runCommand, "git", ["rev-parse", "--show-toplevel"], checkoutRoot);
  const localOrigin = capture(runCommand, "git", ["remote", "get-url", "origin"], checkoutRoot);
  if (realpathSync(localRoot) !== checkoutRoot || !exactRepositoryOrigin(localOrigin, repository)) {
    throw new Error("Deployment checkout must be the exact Git worktree root for the pinned repository");
  }
  assertExternalInstalledBootstrap(bootstrapFile, checkoutRoot);

  const repositoryState = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}`), { cwd: checkoutRoot }),
    "Repository lookup",
  );
  if (
    repositoryState?.id !== DEPLOYMENT_REPOSITORY_ID ||
    repositoryState?.full_name !== DEPLOYMENT_REPOSITORY ||
    repositoryState.archived !== false
  ) {
    throw new Error("Deployment repository identity is missing, archived, or mismatched");
  }
  const defaultBranch = repositoryState.default_branch;
  if (typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    throw new Error("Repository default branch is missing or malformed");
  }
  const branchState = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`), {
      cwd: checkoutRoot,
    }),
    "Protected default-branch lookup",
  );
  const sourceSha = String(branchState?.commit?.sha ?? "").toLowerCase();
  if (
    branchState?.name !== defaultBranch ||
    branchState?.protected !== true ||
    !FULL_GIT_SHA_RE.test(sourceSha)
  ) {
    throw new Error("Deployment default branch is not protected or did not resolve to one commit");
  }
  const operator = parseJson(
    runCommand("gh", apiArgs("user"), { cwd: checkoutRoot }),
    "Deployment operator lookup",
  );
  const operatorLogin = operator?.login;
  if (typeof operatorLogin !== "string" || !GITHUB_LOGIN_RE.test(operatorLogin)) {
    throw new Error("Authenticated deployment operator identity is missing or malformed");
  }
  const configuredOperator = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`), {
      cwd: checkoutRoot,
    }),
    "Deployment operator configuration",
  );
  if (configuredOperator?.name !== "RELEASE_OPERATOR_LOGIN" || configuredOperator?.value !== operatorLogin) {
    throw new Error("Authenticated deployment operator does not match RELEASE_OPERATOR_LOGIN");
  }

  const localHead = capture(runCommand, "git", ["rev-parse", "HEAD"], checkoutRoot).toLowerCase();
  const localBranch = capture(runCommand, "git", ["symbolic-ref", "--short", "HEAD"], checkoutRoot);
  const localStatus = capture(runCommand, "git", ["status", "--porcelain"], checkoutRoot);
  if (localHead !== sourceSha || localBranch !== defaultBranch || localStatus) {
    throw new Error(
      "Deployment bootstrap requires a clean checkout at the exact protected remote default-branch head",
    );
  }

  const sourceBytes = new Map();
  for (const path of DEPLOYMENT_SOURCE_PATHS) {
    const record = parseJson(
      runCommand("gh", apiArgs(`repos/${repository}/contents/${path}?ref=${sourceSha}`), {
        cwd: checkoutRoot,
      }),
      `Protected deployment source lookup: ${path}`,
    );
    sourceBytes.set(path, decodeProtectedDeploymentSource(record, path));
  }
  const jsZipBytes = readJsZipBundle(checkoutRoot);
  if (
    !Buffer.isBuffer(jsZipBytes) ||
    jsZipBytes.length !== JSZIP_BUNDLE_BYTES ||
    sha256(jsZipBytes) !== JSZIP_BUNDLE_SHA256
  ) {
    throw new Error("Deployment bootstrap did not receive the exact pinned JSZip bundle");
  }
  const context = {
    defaultBranch,
    operatorLogin,
    repository,
    sourceSha,
    targetDir,
    trustedGhHome: privateGhHome,
    version,
  };
  await executeEntrypoint({
    checkoutRoot,
    context,
    jsZipBytes,
    nodeEnvironment,
    sourceBytes,
    trustedExecutables,
  });
  return context;
}

async function main() {
  if (
    process.argv[2] !== "--chzzk-clean-bootstrap" ||
    process.env.GITHUB_ACTIONS !== undefined ||
    process.env.NODE_OPTIONS !== undefined ||
    process.env.NODE_PATH !== undefined ||
    process.env.PATH !== TRUSTED_SYSTEM_PATH
  ) {
    throw new Error(
      "Deployment bootstrap must be executed directly through its pre-runtime environment boundary",
    );
  }
  const tokenRecord = readFileSync(0, "utf8");
  if (
    !tokenRecord.endsWith("\n") ||
    tokenRecord.slice(0, -1).includes("\n") ||
    !/^\S+$/.test(tokenRecord.slice(0, -1))
  ) {
    throw new Error("Deployment bootstrap token input is missing or malformed");
  }
  const token = tokenRecord.slice(0, -1);
  const version = process.argv[3];
  const repository = process.argv[4];
  const checkout = process.argv[5];
  const targetDir = process.argv[6] ?? "/var/www/chzzk-updates";
  const bootstrapFile = realpathSync(process.argv[1]);
  const trustedGhHome = createTrustedGhHome();
  try {
    const trustedExecutables = Object.freeze({
      gh: trustedExecutable("gh"),
      git: trustedExecutable("git"),
      node: trustedExecutable("node"),
    });
    if (realpathSync(process.execPath) !== trustedExecutables.node) {
      throw new Error("Deployment bootstrap must be launched by the allowlisted absolute system Node");
    }
    const environments = createTrustedDeploymentEnvironments(token, trustedGhHome);
    const runCommand = createTrustedCommandRunner(trustedExecutables, environments);
    const nodeEnvironment = Object.freeze({ ...environments.gh });
    sanitizeBootstrapProcessEnvironment();
    const result = await runProtectedDeploymentEntrypoint({
      bootstrapFile,
      checkout,
      nodeEnvironment,
      repository,
      runCommand,
      targetDir,
      trustedExecutables,
      trustedGhHome,
      version,
    });
    console.log(JSON.stringify(result));
  } finally {
    rmSync(trustedGhHome, { force: true, recursive: true });
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    await main();
  } catch (error) {
    console.error(`Internal update deployment bootstrap failed: ${error.message}`);
    process.exitCode = 1;
  }
}
