#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BOOTSTRAP_ENTRYPOINT_PATH = "scripts/finalize-release.js";
const RELEASE_DISPATCH_EVENT_TYPE = "chzzk-release-preflight-v1";
const RELEASE_OPERATIONS = new Set(["dispatch", "finalize"]);
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
const MAX_ENTRYPOINT_BYTES = 256 * 1024;
const TRUSTED_EXECUTABLE_CANDIDATES = Object.freeze({
  gh: Object.freeze(["/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"]),
  git: Object.freeze(["/usr/bin/git", "/bin/git"]),
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

function apiArgs(endpoint, { extra = [], method = "GET" } = {}) {
  return ["api", "--method", method, ...GITHUB_API_HEADERS, ...extra, endpoint];
}

function readBoundVersion(checkoutRoot) {
  const packageJson = parseJson(readFileSync(resolve(checkoutRoot, "package.json"), "utf8"), "package.json");
  const manifest = parseJson(readFileSync(resolve(checkoutRoot, "manifest.json"), "utf8"), "manifest.json");
  const version = packageJson?.version;
  const components = typeof version === "string" ? version.split(".") : [];
  if (
    components.length !== 3 ||
    components.some((component) => !/^(?:0|[1-9]\d{0,8})$/.test(component)) ||
    manifest?.version !== version
  ) {
    throw new Error("package.json and manifest.json must share one canonical release version");
  }
  return version;
}

function gitBlobSha(bytes) {
  const value = Buffer.from(bytes);
  return createHash("sha1")
    .update(Buffer.from(`blob ${value.length}\0`))
    .update(value)
    .digest("hex");
}

function moduleDataUrl(bytes) {
  return `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
}

function decodeProtectedEntrypoint(record) {
  if (
    record?.type !== "file" ||
    record?.path !== BOOTSTRAP_ENTRYPOINT_PATH ||
    record?.encoding !== "base64" ||
    !Number.isSafeInteger(record?.size) ||
    record.size <= 0 ||
    record.size > MAX_ENTRYPOINT_BYTES ||
    !FULL_GIT_SHA_RE.test(String(record?.sha ?? "").toLowerCase()) ||
    typeof record?.content !== "string"
  ) {
    throw new Error("Protected finalizer entrypoint record is missing or malformed");
  }
  if (/[^A-Za-z0-9+/=\r\n]/.test(record.content)) {
    throw new Error("Protected finalizer entrypoint content is not canonical base64");
  }
  const encoded = record.content.replace(/[\r\n]/g, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Protected finalizer entrypoint content is not canonical base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length !== record.size) {
    throw new Error("Protected finalizer entrypoint content size or encoding is inconsistent");
  }
  if (gitBlobSha(bytes) !== record.sha.toLowerCase()) {
    throw new Error("Protected finalizer entrypoint bytes do not match the Git blob identity");
  }
  return bytes;
}

function trustedExecutable(command) {
  const candidates = TRUSTED_EXECUTABLE_CANDIDATES[command];
  if (!candidates) throw new Error(`Release bootstrap command is not allowlisted: ${command}`);
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

function assertTrustedGhHome(ghHome) {
  if (typeof ghHome !== "string" || !ghHome.startsWith("/") || ghHome !== resolve(ghHome)) {
    throw new Error("Release bootstrap GitHub home must be one canonical absolute path");
  }
  const metadata = statSync(ghHome, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== currentUid || (metadata.mode & 0o077n) !== 0n) {
    throw new Error("Release bootstrap GitHub home must be a private operator-owned directory");
  }
  return ghHome;
}

function createTrustedGhHome() {
  const ghHome = mkdtempSync("/tmp/chzzk-release-gh-");
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

function createTrustedEnvironments(token, ghHome) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Administrator release bootstrap requires an explicit narrow GH_TOKEN");
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
    HOME: "/nonexistent",
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

function createTrustedCommandRunner(token, executables, ghHome) {
  const environments = createTrustedEnvironments(token, ghHome);
  return (command, args, options = {}) => {
    if (
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
    ) {
      throw new Error("Release bootstrap command arguments are malformed");
    }
    const executable = executables[command];
    if (!executable) throw new Error(`Release bootstrap command is not allowlisted: ${command}`);
    const commandArgs = command === "git" ? [...TRUSTED_GIT_PREFIX, ...args] : args;
    const result = spawnSync(executable, commandArgs, {
      cwd: options.cwd,
      encoding: options.encoding === null ? null : "utf8",
      env: environments[command],
      input: options.input,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = Buffer.from(result.stderr || result.stdout || "unknown command failure")
        .toString("utf8")
        .trim();
      throw new Error(`${command} command failed: ${detail}`);
    }
    return result.stdout;
  };
}

function sanitizeBootstrapProcessEnvironment() {
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
  process.env.GIT_PAGER = "cat";
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.PATH = TRUSTED_SYSTEM_PATH;
}

function capture(runCommand, command, args, cwd) {
  return String(runCommand(command, args, { cwd })).trim();
}

function dispatchStagingWorkflow({
  checkoutRoot,
  defaultBranch,
  now,
  operatorLogin,
  repository,
  runCommand,
  sourceSha,
}) {
  let immutableSetting;
  try {
    immutableSetting = parseJson(
      runCommand("gh", apiArgs(`repos/${repository}/immutable-releases`), { cwd: checkoutRoot }),
      "Immutable release preflight",
    );
  } catch (error) {
    throw new Error(`Immutable release preflight could not prove the setting is enabled: ${error.message}`);
  }
  if (immutableSetting?.enabled !== true) {
    throw new Error("Immutable release preflight did not return enabled: true");
  }
  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || !Number.isFinite(verifiedAt.getTime())) {
    throw new Error("Immutable release preflight timestamp is invalid");
  }
  const version = readBoundVersion(checkoutRoot);
  const dispatchBody = {
    client_payload: {
      default_branch: defaultBranch,
      immutable_releases_verified: true,
      operator_login: operatorLogin,
      source_sha: sourceSha,
      verified_at: verifiedAt.toISOString(),
      version,
    },
    event_type: RELEASE_DISPATCH_EVENT_TYPE,
  };
  runCommand("gh", apiArgs(`repos/${repository}/dispatches`, { extra: ["--input", "-"], method: "POST" }), {
    cwd: checkoutRoot,
    input: `${JSON.stringify(dispatchBody)}\n`,
  });
  return { defaultBranch, dispatched: true, operatorLogin, sourceSha, version };
}

export async function runProtectedReleaseEntrypoint({
  checkout,
  now = () => new Date(),
  operation = "finalize",
  repository,
  runCommand,
  trustedExecutables,
  trustedGhHome,
}) {
  if (process.env.GITHUB_ACTIONS) {
    throw new Error("The administrator release bootstrap must run out of band, never in GitHub Actions");
  }
  if (!REPOSITORY_RE.test(String(repository ?? ""))) {
    throw new Error("Release repository must use owner/repository form");
  }
  if (!RELEASE_OPERATIONS.has(operation)) {
    throw new Error("Release bootstrap operation must be dispatch or finalize");
  }
  if (typeof runCommand !== "function") {
    throw new Error("Release bootstrap requires a trusted command runner");
  }
  const checkoutRoot = realpathSync(resolve(String(checkout ?? "")));
  if (!statSync(checkoutRoot).isDirectory()) {
    throw new Error("Release checkout must resolve to a directory");
  }

  const repositoryState = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}`), { cwd: checkoutRoot }),
    "Repository lookup",
  );
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
    throw new Error("Repository default branch is not protected or did not resolve to one commit");
  }

  const operator = parseJson(runCommand("gh", apiArgs("user"), { cwd: checkoutRoot }), "Operator lookup");
  const operatorLogin = operator?.login;
  if (typeof operatorLogin !== "string" || !GITHUB_LOGIN_RE.test(operatorLogin)) {
    throw new Error("Authenticated release operator identity is missing or malformed");
  }
  const configuredOperator = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`), {
      cwd: checkoutRoot,
    }),
    "Release operator configuration",
  );
  if (configuredOperator?.name !== "RELEASE_OPERATOR_LOGIN" || configuredOperator?.value !== operatorLogin) {
    throw new Error("Authenticated release operator does not match RELEASE_OPERATOR_LOGIN");
  }

  const localHead = capture(runCommand, "git", ["rev-parse", "HEAD"], checkoutRoot).toLowerCase();
  const localBranch = capture(runCommand, "git", ["symbolic-ref", "--short", "HEAD"], checkoutRoot);
  const localStatus = capture(runCommand, "git", ["status", "--porcelain"], checkoutRoot);
  if (localHead !== sourceSha || localBranch !== defaultBranch || localStatus) {
    throw new Error(
      "Release bootstrap requires a clean checkout at the exact protected remote default-branch head",
    );
  }

  if (operation === "dispatch") {
    return dispatchStagingWorkflow({
      checkoutRoot,
      defaultBranch,
      now,
      operatorLogin,
      repository,
      runCommand,
      sourceSha,
    });
  }

  const entrypointRecord = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}/contents/scripts/finalize-release.js?ref=${sourceSha}`), {
      cwd: checkoutRoot,
    }),
    "Protected finalizer entrypoint lookup",
  );
  const entrypointBytes = decodeProtectedEntrypoint(entrypointRecord);
  if (
    trustedExecutables !== undefined &&
    (typeof trustedExecutables?.gh !== "string" ||
      !trustedExecutables.gh.startsWith("/") ||
      trustedExecutables.gh !== resolve(trustedExecutables.gh) ||
      trustedExecutables.gh.includes("\0") ||
      typeof trustedExecutables?.git !== "string" ||
      !trustedExecutables.git.startsWith("/") ||
      trustedExecutables.git !== resolve(trustedExecutables.git) ||
      trustedExecutables.git.includes("\0"))
  ) {
    throw new Error("Release bootstrap trusted executable paths are malformed");
  }
  if (trustedGhHome !== undefined) assertTrustedGhHome(trustedGhHome);
  const previousBootstrapSha = process.env.CHZZK_RELEASE_BOOTSTRAP_SHA;
  const previousCheckout = process.env.CHZZK_RELEASE_CHECKOUT;
  const previousRepository = process.env.CHZZK_GITHUB_REPOSITORY;
  const previousTrustedGh = process.env.CHZZK_RELEASE_TRUSTED_GH;
  const previousTrustedGhHome = process.env.CHZZK_RELEASE_TRUSTED_GH_HOME;
  const previousTrustedGit = process.env.CHZZK_RELEASE_TRUSTED_GIT;
  process.env.CHZZK_GITHUB_REPOSITORY = repository;
  process.env.CHZZK_RELEASE_BOOTSTRAP_SHA = sourceSha;
  process.env.CHZZK_RELEASE_CHECKOUT = checkoutRoot;
  if (trustedExecutables !== undefined) {
    process.env.CHZZK_RELEASE_TRUSTED_GH = trustedExecutables.gh;
    process.env.CHZZK_RELEASE_TRUSTED_GIT = trustedExecutables.git;
  }
  if (trustedGhHome !== undefined) {
    process.env.CHZZK_RELEASE_TRUSTED_GH_HOME = trustedGhHome;
  }
  try {
    await import(moduleDataUrl(entrypointBytes));
  } finally {
    if (previousBootstrapSha === undefined) delete process.env.CHZZK_RELEASE_BOOTSTRAP_SHA;
    else process.env.CHZZK_RELEASE_BOOTSTRAP_SHA = previousBootstrapSha;
    if (previousCheckout === undefined) delete process.env.CHZZK_RELEASE_CHECKOUT;
    else process.env.CHZZK_RELEASE_CHECKOUT = previousCheckout;
    if (previousRepository === undefined) delete process.env.CHZZK_GITHUB_REPOSITORY;
    else process.env.CHZZK_GITHUB_REPOSITORY = previousRepository;
    if (previousTrustedGh === undefined) delete process.env.CHZZK_RELEASE_TRUSTED_GH;
    else process.env.CHZZK_RELEASE_TRUSTED_GH = previousTrustedGh;
    if (previousTrustedGhHome === undefined) delete process.env.CHZZK_RELEASE_TRUSTED_GH_HOME;
    else process.env.CHZZK_RELEASE_TRUSTED_GH_HOME = previousTrustedGhHome;
    if (previousTrustedGit === undefined) delete process.env.CHZZK_RELEASE_TRUSTED_GIT;
    else process.env.CHZZK_RELEASE_TRUSTED_GIT = previousTrustedGit;
  }
  return { defaultBranch, operatorLogin, sourceSha };
}

async function main() {
  const token = process.env.GH_TOKEN;
  const trustedGhHome = createTrustedGhHome();
  try {
    const trustedExecutables = Object.freeze({
      gh: trustedExecutable("gh"),
      git: trustedExecutable("git"),
    });
    const runCommand = createTrustedCommandRunner(token, trustedExecutables, trustedGhHome);
    sanitizeBootstrapProcessEnvironment();
    const operation = process.argv[2];
    const repository = process.argv[3] ?? process.env.CHZZK_GITHUB_REPOSITORY;
    const checkout = process.argv[4] ?? process.env.CHZZK_RELEASE_CHECKOUT ?? process.cwd();
    await runProtectedReleaseEntrypoint({
      checkout,
      operation,
      repository,
      runCommand,
      trustedExecutables,
      trustedGhHome,
    });
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
    console.error(`Release bootstrap failed: ${error.message}`);
    process.exitCode = 1;
  }
}
