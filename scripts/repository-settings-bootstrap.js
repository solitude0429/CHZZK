#!/bin/sh
// 2>/dev/null; if [ "${CHZZK_REPOSITORY_SETTINGS_PARENT_BOUNDARY-}" != 1 ] || [ "${PATH-}" != /usr/local/bin:/usr/bin:/bin ] || [ "${ALL_PROXY+x}" = x ] || [ "${BASH_ENV+x}" = x ] || [ "${CDPATH+x}" = x ] || [ "${CHZZK_RELEASE_ADMIN_TOKEN+x}" = x ] || [ "${CHZZK_REPOSITORY_ADMIN_TOKEN+x}" = x ] || [ "${CURL_CA_BUNDLE+x}" = x ] || [ "${ENV+x}" = x ] || [ "${GH_ENTERPRISE_TOKEN+x}" = x ] || [ "${GH_TOKEN+x}" = x ] || [ "${GITHUB_ACTIONS+x}" = x ] || [ "${GITHUB_ENTERPRISE_TOKEN+x}" = x ] || [ "${GITHUB_TOKEN+x}" = x ] || [ "${GLOBIGNORE+x}" = x ] || [ "${HTTPS_PROXY+x}" = x ] || [ "${HTTP_PROXY+x}" = x ] || [ "${LD_AUDIT+x}" = x ] || [ "${LD_LIBRARY_PATH+x}" = x ] || [ "${LD_PRELOAD+x}" = x ] || [ "${NODE_EXTRA_CA_CERTS+x}" = x ] || [ "${NODE_OPTIONS+x}" = x ] || [ "${NODE_PATH+x}" = x ] || [ "${NO_PROXY+x}" = x ] || [ "${REQUESTS_CA_BUNDLE+x}" = x ] || [ "${SSL_CERT_DIR+x}" = x ] || [ "${SSL_CERT_FILE+x}" = x ] || [ "${XDG_CONFIG_HOME+x}" = x ] || [ "${all_proxy+x}" = x ] || [ "${http_proxy+x}" = x ] || [ "${https_proxy+x}" = x ] || [ "${no_proxy+x}" = x ]; then echo "Repository settings bootstrap requires the documented trusted parent-shell boundary" >&2; exit 1; fi; exec /usr/bin/env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/node "$0" --chzzk-clean-bootstrap "$@"; exit $?
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CONFIGURATOR_PATH = "scripts/configure-repository.js";
const EXPECTED_REPOSITORY = "solitude0429/CHZZK";
const EXPECTED_REPOSITORY_ID = 1_275_903_171;
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API_HEADERS = Object.freeze([
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
]);
const MAX_CONFIGURATOR_BYTES = 512 * 1024;
const TRUSTED_EXECUTABLE_CANDIDATES = Object.freeze({
  gh: Object.freeze(["/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"]),
  git: Object.freeze(["/usr/bin/git", "/bin/git"]),
  node: Object.freeze(["/usr/bin/node"]),
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

export function decodeProtectedConfigurator(record) {
  if (
    record?.type !== "file" ||
    record?.path !== CONFIGURATOR_PATH ||
    record?.encoding !== "base64" ||
    !Number.isSafeInteger(record?.size) ||
    record.size <= 0 ||
    record.size > MAX_CONFIGURATOR_BYTES ||
    !FULL_GIT_SHA_RE.test(String(record?.sha ?? "").toLowerCase()) ||
    typeof record?.content !== "string"
  ) {
    throw new Error("Protected repository configurator record is missing or malformed");
  }
  if (/[^A-Za-z0-9+/=\r\n]/.test(record.content)) {
    throw new Error("Protected repository configurator is not canonical base64");
  }
  const encoded = record.content.replace(/[\r\n]/g, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Protected repository configurator is not canonical base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length !== record.size ||
    gitBlobSha(bytes) !== record.sha.toLowerCase()
  ) {
    throw new Error("Protected repository configurator bytes do not match the Git blob identity");
  }
  return bytes;
}

function protectedSystemExecutable(path, name) {
  if (typeof path !== "string" || !path.startsWith("/") || path !== resolve(path) || path.includes("\0")) {
    throw new Error(`Repository settings bootstrap ${name} path is missing or malformed`);
  }
  const canonicalPath = realpathSync(path);
  const metadata = statSync(canonicalPath);
  if (
    !metadata.isFile() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new Error(`Repository settings bootstrap ${name} is not a protected system executable`);
  }
  return canonicalPath;
}

function trustedExecutable(name) {
  const candidates = TRUSTED_EXECUTABLE_CANDIDATES[name];
  if (!candidates) {
    throw new Error(`Repository settings bootstrap command is not allowlisted: ${name}`);
  }
  for (const candidate of candidates) {
    try {
      return protectedSystemExecutable(candidate, name);
    } catch {
      // Try the next fixed system path.
    }
  }
  throw new Error(`No root-owned, non-writable system ${name} executable is available`);
}

function assertTrustedExecutables(executables) {
  if (
    executables === null ||
    typeof executables !== "object" ||
    Object.keys(executables).sort().join(",") !== "gh,git,node"
  ) {
    throw new Error("Repository settings bootstrap executable set is malformed");
  }
  return Object.freeze({
    gh: protectedSystemExecutable(executables.gh, "gh"),
    git: protectedSystemExecutable(executables.git, "git"),
    node: protectedSystemExecutable(executables.node, "node"),
  });
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
  const privateHome = assertPrivateOperatorDirectory(ghHome, "Repository settings bootstrap GitHub home");
  for (const child of ["cache", "config"]) {
    assertPrivateOperatorDirectory(
      join(privateHome, child),
      `Repository settings bootstrap GitHub ${child} directory`,
    );
  }
  return privateHome;
}

function createTrustedGhHome() {
  const ghHome = mkdtempSync("/tmp/chzzk-repository-settings-gh-");
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

export function createTrustedSettingsEnvironments(token, ghHome) {
  if (typeof token !== "string" || !/^\S+$/.test(token)) {
    throw new Error("Repository settings bootstrap requires an explicit narrow GH_TOKEN");
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
      (command !== "git" && command !== "gh") ||
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
    ) {
      throw new Error("Repository settings bootstrap command is not allowlisted or is malformed");
    }
    const commandArgs = command === "git" ? [...TRUSTED_GIT_PREFIX, ...args] : args;
    const result = spawnSync(executables[command], commandArgs, {
      cwd: options.cwd,
      encoding: "utf8",
      env: environments[command],
      input: options.input,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} command failed with status ${result.status ?? "unknown"}`);
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

function moduleDataUrl(bytes) {
  return `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`;
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
    throw new Error("Repository settings bootstrap must be invoked by one absolute installed path");
  }
  const canonicalPath = realpathSync(bootstrapFile);
  if (pathIsWithin(checkoutRoot, canonicalPath)) {
    throw new Error("Repository settings bootstrap must be an external installed copy");
  }
  if (!canonicalPath.endsWith(".mjs")) {
    throw new Error("Repository settings bootstrap installed copy must use an .mjs filename");
  }
  const metadata = statSync(canonicalPath, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isFile() || metadata.uid !== currentUid || (metadata.mode & 0o777n) !== 0o500n) {
    throw new Error("Repository settings bootstrap installed copy must be operator-owned mode 0500");
  }
  assertPrivateOperatorDirectory(
    dirname(canonicalPath),
    "Repository settings bootstrap installation directory",
  );
  return canonicalPath;
}

function readRemoteIdentity({ checkoutRoot, repository, runCommand }) {
  const repositoryState = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}`), { cwd: checkoutRoot }),
    "Repository lookup",
  );
  if (
    repository !== EXPECTED_REPOSITORY ||
    repositoryState?.id !== EXPECTED_REPOSITORY_ID ||
    repositoryState?.full_name !== EXPECTED_REPOSITORY ||
    repositoryState.archived !== false
  ) {
    throw new Error("Repository identity is missing, archived, or mismatched");
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
  return { defaultBranch, sourceSha };
}

function assertExactLocalCheckout({ checkoutRoot, defaultBranch, repository, runCommand, sourceSha }) {
  const localRoot = capture(runCommand, "git", ["rev-parse", "--show-toplevel"], checkoutRoot);
  const localOrigin = capture(runCommand, "git", ["remote", "get-url", "origin"], checkoutRoot);
  const localHead = capture(runCommand, "git", ["rev-parse", "HEAD"], checkoutRoot).toLowerCase();
  const localBranch = capture(runCommand, "git", ["symbolic-ref", "--short", "HEAD"], checkoutRoot);
  const localStatus = capture(
    runCommand,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    checkoutRoot,
  );
  if (
    realpathSync(localRoot) !== checkoutRoot ||
    !exactRepositoryOrigin(localOrigin, repository) ||
    localHead !== sourceSha ||
    localBranch !== defaultBranch ||
    localStatus
  ) {
    throw new Error(
      "Repository settings bootstrap requires the exact clean protected default-branch checkout",
    );
  }
}

function executeProtectedConfigurator({
  apply,
  checkoutRoot,
  configuratorBytes,
  context,
  nodeEnvironment,
  trustedExecutables,
}) {
  const loader = `await import(${JSON.stringify(moduleDataUrl(configuratorBytes))});\n`;
  const result = spawnSync(trustedExecutables.node, ["--input-type=module"], {
    cwd: checkoutRoot,
    env: {
      ...nodeEnvironment,
      CHZZK_GITHUB_REPOSITORY: context.repository,
      CHZZK_REPOSITORY_SETTINGS_BOOTSTRAP_SHA: context.sourceSha,
      CHZZK_REPOSITORY_SETTINGS_CHECKOUT: checkoutRoot,
      CHZZK_REPOSITORY_SETTINGS_DEFAULT_BRANCH: context.defaultBranch,
      CHZZK_REPOSITORY_SETTINGS_MODE: apply ? "apply" : "dry-run",
      CHZZK_REPOSITORY_SETTINGS_OPERATOR_LOGIN: context.operatorLogin,
      CHZZK_REPOSITORY_SETTINGS_TRUSTED_GH: trustedExecutables.gh,
      CHZZK_REPOSITORY_SETTINGS_TRUSTED_GH_HOME: context.trustedGhHome,
      CHZZK_REPOSITORY_SETTINGS_TRUSTED_GIT: trustedExecutables.git,
      CHZZK_REPOSITORY_SETTINGS_TRUSTED_NODE: trustedExecutables.node,
    },
    input: loader,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Protected repository configurator exited with status ${result.status ?? "unknown"}`);
  }
}

export async function runProtectedRepositorySettings({
  apply = false,
  bootstrapFile,
  checkout,
  executeConfigurator = executeProtectedConfigurator,
  nodeEnvironment,
  repository,
  runCommand,
  trustedExecutables,
  trustedGhHome,
}) {
  if (process.env.GITHUB_ACTIONS !== undefined) {
    throw new Error("Repository settings bootstrap must run out of band");
  }
  if (!REPOSITORY_RE.test(String(repository ?? ""))) {
    throw new Error("Repository settings repository must use owner/repository form");
  }
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error("Repository settings bootstrap is pinned to solitude0429/CHZZK");
  }
  if (typeof apply !== "boolean" || typeof runCommand !== "function") {
    throw new Error("Repository settings bootstrap arguments are malformed");
  }
  if (
    typeof checkout !== "string" ||
    !checkout.startsWith("/") ||
    checkout !== resolve(checkout) ||
    checkout.includes("\0")
  ) {
    throw new Error("Repository settings checkout must be one canonical absolute path");
  }
  const checkoutRoot = realpathSync(checkout);
  if (!statSync(checkoutRoot).isDirectory()) {
    throw new Error("Repository settings checkout must resolve to a directory");
  }
  assertExternalInstalledBootstrap(bootstrapFile, checkoutRoot);
  const executables = assertTrustedExecutables(trustedExecutables);
  const privateGhHome = assertTrustedGhHome(trustedGhHome);

  const { defaultBranch, sourceSha } = readRemoteIdentity({
    checkoutRoot,
    repository,
    runCommand,
  });
  const operator = parseJson(
    runCommand("gh", apiArgs("user"), { cwd: checkoutRoot }),
    "Repository settings operator lookup",
  );
  const operatorLogin = operator?.login;
  if (typeof operatorLogin !== "string" || !GITHUB_LOGIN_RE.test(operatorLogin)) {
    throw new Error("Authenticated repository settings operator is missing or malformed");
  }
  const permission = parseJson(
    runCommand(
      "gh",
      apiArgs(`repos/${repository}/collaborators/${encodeURIComponent(operatorLogin)}/permission`),
      { cwd: checkoutRoot },
    ),
    "Repository settings operator permission lookup",
  );
  if (
    permission?.permission !== "admin" ||
    permission?.user?.login?.toLowerCase() !== operatorLogin.toLowerCase()
  ) {
    throw new Error("Authenticated repository settings operator does not have exact admin authority");
  }
  assertExactLocalCheckout({
    checkoutRoot,
    defaultBranch,
    repository,
    runCommand,
    sourceSha,
  });

  const configuratorRecord = parseJson(
    runCommand("gh", apiArgs(`repos/${repository}/contents/${CONFIGURATOR_PATH}?ref=${sourceSha}`), {
      cwd: checkoutRoot,
    }),
    "Protected repository configurator lookup",
  );
  const configuratorBytes = decodeProtectedConfigurator(configuratorRecord);

  const recheckedIdentity = readRemoteIdentity({ checkoutRoot, repository, runCommand });
  if (recheckedIdentity.defaultBranch !== defaultBranch || recheckedIdentity.sourceSha !== sourceSha) {
    throw new Error("Protected default-branch head changed before configurator execution");
  }
  assertExactLocalCheckout({
    checkoutRoot,
    defaultBranch,
    repository,
    runCommand,
    sourceSha,
  });

  const context = Object.freeze({
    apply,
    defaultBranch,
    operatorLogin,
    repository,
    sourceSha,
    trustedGhHome: privateGhHome,
  });
  await executeConfigurator({
    apply,
    checkoutRoot,
    configuratorBytes,
    context,
    nodeEnvironment,
    trustedExecutables: executables,
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
      "Repository settings bootstrap must be executed directly through its pre-runtime boundary",
    );
  }
  const tokenRecord = readFileSync(0, "utf8");
  if (
    !tokenRecord.endsWith("\n") ||
    tokenRecord.slice(0, -1).includes("\n") ||
    !/^\S+$/.test(tokenRecord.slice(0, -1))
  ) {
    throw new Error("Repository settings bootstrap token input is missing or malformed");
  }
  const token = tokenRecord.slice(0, -1);
  const args = process.argv.slice(3);
  const apply = args.includes("--apply");
  const positionals = args.filter((argument) => argument !== "--apply");
  if (
    positionals.length !== 2 ||
    args.length !== positionals.length + (apply ? 1 : 0) ||
    args.some((argument) => argument.includes("\0"))
  ) {
    throw new Error(
      "Usage: /absolute/path/repository-settings-bootstrap.mjs OWNER/REPOSITORY /absolute/checkout [--apply]",
    );
  }
  const [repository, checkout] = positionals;
  if (!REPOSITORY_RE.test(repository)) {
    throw new Error("Repository settings repository must use owner/repository form");
  }
  const bootstrapFile = realpathSync(process.argv[1]);
  const trustedExecutables = Object.freeze({
    gh: trustedExecutable("gh"),
    git: trustedExecutable("git"),
    node: trustedExecutable("node"),
  });
  if (realpathSync(process.execPath) !== trustedExecutables.node) {
    throw new Error("Repository settings bootstrap must use the required protected /usr/bin/node");
  }
  const trustedGhHome = createTrustedGhHome();
  try {
    const environments = createTrustedSettingsEnvironments(token, trustedGhHome);
    const runCommand = createTrustedCommandRunner(trustedExecutables, environments);
    const nodeEnvironment = Object.freeze({ ...environments.gh });
    sanitizeBootstrapProcessEnvironment();
    await runProtectedRepositorySettings({
      apply,
      bootstrapFile,
      checkout,
      nodeEnvironment,
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
    console.error(`Repository settings bootstrap failed: ${error.message}`);
    process.exitCode = 1;
  }
}
