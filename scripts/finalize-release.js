#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API_HEADERS = Object.freeze([
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
]);
const AMBIENT_EXECUTION_ENVIRONMENT_NAMES = new Set([
  "ALL_PROXY",
  "BASH_ENV",
  "CHZZK_RELEASE_ADMIN_TOKEN",
  "CURL_CA_BUNDLE",
  "ENV",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "XDG_CONFIG_HOME",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);
const FINALIZER_SOURCE_PATHS = Object.freeze([
  "scripts/finalize-release.js",
  "scripts/lib/release-finalize-state.js",
  "scripts/lib/release-finalize.js",
  "scripts/lib/release-version.js",
]);
const TRUSTED_GIT_PREFIX = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
]);
const TRUSTED_SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
function trustedBootstrapExecutable(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!value.startsWith("/") || value !== resolve(value) || value.includes("\0")) {
    throw new Error(`Release bootstrap executable path is malformed: ${name}`);
  }
  return value;
}
function trustedGhHomeFromBootstrap() {
  const value = process.env.CHZZK_RELEASE_TRUSTED_GH_HOME;
  if (value === undefined) return "/nonexistent";
  if (!value.startsWith("/") || value !== resolve(value) || value.includes("\0")) {
    throw new Error("Release bootstrap GitHub home path is malformed");
  }
  const metadata = statSync(value, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== currentUid || (metadata.mode & 0o077n) !== 0n) {
    throw new Error("Release bootstrap GitHub home is not a private operator-owned directory");
  }
  for (const child of ["cache", "config"]) {
    const childMetadata = statSync(join(value, child), { bigint: true });
    if (
      !childMetadata.isDirectory() ||
      childMetadata.uid !== currentUid ||
      (childMetadata.mode & 0o077n) !== 0n
    ) {
      throw new Error(`Release bootstrap GitHub ${child} directory is not private`);
    }
  }
  return value;
}
const TRUSTED_GH_EXECUTABLE = trustedBootstrapExecutable("CHZZK_RELEASE_TRUSTED_GH", "gh");
const TRUSTED_GIT_EXECUTABLE = trustedBootstrapExecutable("CHZZK_RELEASE_TRUSTED_GIT", "git");
const TRUSTED_GH_HOME = trustedGhHomeFromBootstrap();
let trustedChildEnvironments;
const repositoryRoot = process.env.CHZZK_RELEASE_CHECKOUT
  ? realpathSync(resolve(process.env.CHZZK_RELEASE_CHECKOUT))
  : fileURLToPath(new URL("../", import.meta.url));

function sanitizeAdministratorEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (
      AMBIENT_EXECUTION_ENVIRONMENT_NAMES.has(name) ||
      name.startsWith("GIT_") ||
      (name.startsWith("GH_") && name !== "GH_TOKEN")
    ) {
      delete process.env[name];
    }
  }
  process.env.GH_HOST = "github.com";
  process.env.GH_PAGER = "cat";
  process.env.GH_PROMPT_DISABLED = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_OPTIONAL_LOCKS = "0";
  process.env.PATH = TRUSTED_SYSTEM_PATH;
}

function createTrustedChildEnvironments() {
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
    HOME: "/nonexistent",
  });
  const token = process.env.GH_TOKEN;
  const gh = Object.freeze({
    ...git,
    GH_CONFIG_DIR: join(TRUSTED_GH_HOME, "config"),
    GH_HOST: "github.com",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    ...(typeof token === "string" && token.trim() ? { GH_TOKEN: token } : {}),
    HOME: TRUSTED_GH_HOME,
    XDG_CACHE_HOME: join(TRUSTED_GH_HOME, "cache"),
  });
  return Object.freeze({ gh, git });
}

function trustedChildEnvironment(command) {
  if (!trustedChildEnvironments) {
    throw new Error("Release finalizer child environment was not initialized");
  }
  if (command === "gh" && !trustedChildEnvironments.gh.GH_TOKEN) {
    throw new Error("Release finalizer requires an explicit narrow GH_TOKEN");
  }
  return trustedChildEnvironments[command];
}

function runTrustedGit(args, options) {
  return spawnSync(TRUSTED_GIT_EXECUTABLE, [...TRUSTED_GIT_PREFIX, ...args], {
    ...options,
    env: trustedChildEnvironment("git"),
  });
}

function runTrustedFinalizerCommand(command, args, options = {}) {
  if (command !== "git" && command !== "gh") {
    throw new Error(`Release finalizer command is not allowlisted: ${command}`);
  }
  const executable = command === "git" ? TRUSTED_GIT_EXECUTABLE : TRUSTED_GH_EXECUTABLE;
  const commandArgs = command === "git" ? [...TRUSTED_GIT_PREFIX, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    env: trustedChildEnvironment(command),
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "unknown command failure").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function captureTrustedGit(cwd, args, label) {
  const result = runTrustedGit(args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = String(
      result.stderr || result.stdout || result.error?.message || "unknown failure",
    ).trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function trustedGitHubApi(cwd, endpoint, label) {
  const result = spawnSync(
    TRUSTED_GH_EXECUTABLE,
    ["api", "--method", "GET", ...GITHUB_API_HEADERS, endpoint],
    {
      cwd,
      encoding: "utf8",
      env: trustedChildEnvironment("gh"),
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const detail = String(
      result.stderr || result.stdout || result.error?.message || "unknown failure",
    ).trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function readRepositoryArgument() {
  const repository = process.env.CHZZK_GITHUB_REPOSITORY ?? process.argv[2];
  if (!REPOSITORY_RE.test(String(repository ?? ""))) {
    throw new Error("Release repository must be provided as owner/repository");
  }
  return repository;
}

function assertRemoteProtectedDefaultHead(cwd, repository) {
  const repositoryState = trustedGitHubApi(cwd, `repos/${repository}`, "Repository lookup");
  if (
    repositoryState?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    repositoryState.archived !== false
  ) {
    throw new Error("Release repository identity is missing, archived, or mismatched");
  }
  const defaultBranch = repositoryState.default_branch;
  if (typeof defaultBranch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    throw new Error("Repository default branch is missing or malformed");
  }
  const branchState = trustedGitHubApi(
    cwd,
    `repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`,
    "Protected default-branch lookup",
  );
  const remoteHead = String(branchState?.commit?.sha ?? "").toLowerCase();
  const bootstrapSha = process.env.CHZZK_RELEASE_BOOTSTRAP_SHA;
  if (
    branchState?.name !== defaultBranch ||
    branchState?.protected !== true ||
    !FULL_GIT_SHA_RE.test(remoteHead) ||
    (bootstrapSha !== undefined && bootstrapSha !== remoteHead)
  ) {
    throw new Error("Repository default branch is not protected or did not resolve to one commit");
  }
  const localHead = captureTrustedGit(cwd, ["rev-parse", "HEAD"], "Local HEAD lookup").toLowerCase();
  const localBranch = captureTrustedGit(cwd, ["symbolic-ref", "--short", "HEAD"], "Local branch lookup");
  if (localHead !== remoteHead || localBranch !== defaultBranch) {
    throw new Error("Release finalizer source is not the exact protected remote default-branch head");
  }
  const operator = trustedGitHubApi(cwd, "user", "Operator lookup");
  const operatorLogin = operator?.login;
  if (typeof operatorLogin !== "string" || !GITHUB_LOGIN_RE.test(operatorLogin)) {
    throw new Error("Authenticated release operator identity is missing or malformed");
  }
  const configuredOperator = trustedGitHubApi(
    cwd,
    `repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`,
    "Release operator configuration",
  );
  if (configuredOperator?.name !== "RELEASE_OPERATOR_LOGIN" || configuredOperator?.value !== operatorLogin) {
    throw new Error("Authenticated release operator does not match RELEASE_OPERATOR_LOGIN");
  }
}

function assertCleanGitStatus(cwd) {
  const result = runTrustedGit(["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (result.error) {
    const detail = (
      result.stderr ||
      result.stdout ||
      result.error.message ||
      "unknown git status failure"
    ).trim();
    throw new Error(`Unable to prove a clean checkout before release finalization: ${detail}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown git status failure").trim();
    throw new Error(`Unable to prove a clean checkout before release finalization: ${detail}`);
  }
  if (result.stderr.trim() || result.stdout.trim()) {
    throw new Error("Release finalization requires a clean git status before loading release code");
  }
}

function assertTrustedFinalizerSources(cwd) {
  const index = runTrustedGit(["ls-files", "-v", "--", ...FINALIZER_SOURCE_PATHS], {
    cwd,
    encoding: "utf8",
  });
  if (index.error || index.status !== 0 || index.stderr.trim()) {
    const detail = String(
      index.stderr || index.stdout || index.error?.message || "unknown index failure",
    ).trim();
    throw new Error(`Unable to verify trusted finalizer index state: ${detail}`);
  }
  const records = new Set(index.stdout.trim() ? index.stdout.trim().split("\n") : []);
  const expectedRecords = FINALIZER_SOURCE_PATHS.map((path) => `H ${path}`);
  if (records.size !== expectedRecords.length || expectedRecords.some((record) => !records.has(record))) {
    throw new Error(
      "Release finalizer sources must be tracked without assume-unchanged or skip-worktree flags",
    );
  }

  const verifiedSources = new Map();
  for (const path of FINALIZER_SOURCE_PATHS) {
    const head = runTrustedGit(["show", `HEAD:${path}`], {
      cwd,
      encoding: null,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (head.error || head.status !== 0 || head.stderr.length !== 0) {
      const detail = Buffer.from(
        head.stderr || head.stdout || head.error?.message || "unknown HEAD lookup failure",
      )
        .toString("utf8")
        .trim();
      throw new Error(`Unable to verify finalizer source against HEAD: ${path}: ${detail}`);
    }
    const headBytes = Buffer.from(head.stdout);
    const workingBytes = readFileSync(join(cwd, path));
    if (!headBytes.equals(workingBytes)) {
      throw new Error(`Release finalizer source differs from the exact HEAD blob: ${path}`);
    }
    verifiedSources.set(path, headBytes);
  }
  return verifiedSources;
}

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function rewriteVerifiedImport(source, specifier, moduleUrl, label) {
  const token = `from "${specifier}"`;
  if (source.split(token).length !== 2) {
    throw new Error(`${label} must import ${specifier} exactly once`);
  }
  return source.replace(token, `from ${JSON.stringify(moduleUrl)}`);
}

function rejectRemainingLocalImports(source, label) {
  if (/\bfrom\s+["']\.\//.test(source)) {
    throw new Error(`${label} contains an unsealed local import`);
  }
}

function buildVerifiedFinalizerModuleUrl(verifiedSources) {
  const versionUrl = moduleDataUrl(verifiedSources.get("scripts/lib/release-version.js").toString("utf8"));
  let stateSource = verifiedSources.get("scripts/lib/release-finalize-state.js").toString("utf8");
  stateSource = rewriteVerifiedImport(
    stateSource,
    "./release-version.js",
    versionUrl,
    "release-finalize-state.js",
  );
  rejectRemainingLocalImports(stateSource, "release-finalize-state.js");
  const stateUrl = moduleDataUrl(stateSource);

  let finalizerSource = verifiedSources.get("scripts/lib/release-finalize.js").toString("utf8");
  finalizerSource = rewriteVerifiedImport(
    finalizerSource,
    "./release-finalize-state.js",
    stateUrl,
    "release-finalize.js",
  );
  if (finalizerSource.includes('from "./release-version.js"')) {
    finalizerSource = rewriteVerifiedImport(
      finalizerSource,
      "./release-version.js",
      versionUrl,
      "release-finalize.js",
    );
  }
  rejectRemainingLocalImports(finalizerSource, "release-finalize.js");
  return moduleDataUrl(finalizerSource);
}

try {
  if (process.env.GITHUB_ACTIONS) {
    throw new Error("The administrator release finalizer must run out of band, never in GitHub Actions");
  }
  sanitizeAdministratorEnvironment();
  trustedChildEnvironments = createTrustedChildEnvironments();
  const repository = readRepositoryArgument();
  assertCleanGitStatus(repositoryRoot);
  const verifiedSources = assertTrustedFinalizerSources(repositoryRoot);
  assertRemoteProtectedDefaultHead(repositoryRoot, repository);
  const finalizerModuleUrl = buildVerifiedFinalizerModuleUrl(verifiedSources);
  const { finalizeStagedReleaseFromAdminPreflight } = await import(finalizerModuleUrl);
  const result = await finalizeStagedReleaseFromAdminPreflight({
    cwd: repositoryRoot,
    repository,
    runCommand: runTrustedFinalizerCommand,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Release finalization failed: ${error.message}`);
  process.exitCode = 1;
}
