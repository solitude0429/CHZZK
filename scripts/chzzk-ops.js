#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { runWindowsSignedUpdateSmoke } from "./run-windows-signed-update-smoke.js";

export const OPS_REPOSITORY = "solitude0429/CHZZK";
export const OPS_REPOSITORY_ID = 1_275_903_171;
export const OPS_LOGIN = "solitude0429";
export const OPS_DEFAULT_BRANCH = "main";
export const OPS_REMOTE = "origin";
export const OPS_SERVER = "server";
export const OPS_TARGET = "/srv/admin/chzzk-updates";
export const OPS_UPDATE_ORIGIN = "https://chzzk.home.arpa:8443";
export const OPS_SIGNING_WORKFLOW = "sign-unlisted.yml";
export const OPS_SIGNER_WORKFLOW = `${OPS_REPOSITORY}/.github/workflows/sign-unlisted.yml`;
export const OPS_ACTIONS_APP_ID = 15_368;
export const REQUIRED_CHECKS = Object.freeze(["analyze", "dependency-review", "firefox-e2e", "verify"]);

const PUBLIC_COMMANDS = new Set(["status", "ship", "release", "deploy", "rollback"]);
const ALLOWED_EXECUTABLES = new Set(["gh", "git", "scp", "ssh"]);
const FULL_SHA_RE = /^[a-f0-9]{40}$/;
const NONCE_RE = /^[a-f0-9]{32}$/;
const VERSION_RE = /^(\d{2})\.(\d{1,2})\.(\d{1,2})$/;
const EXTENSION_VERSION_RE = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/;
const SAFE_BRANCH_RE = /^(?![./])(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9._/-]+(?<![./])$/;
const RELEASE_RUN_PREFIX = "Release assets";
const API_HEADERS = Object.freeze([
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
]);
const ASSET_CONTENT_TYPES = Object.freeze({
  metadata: "application/json",
  signed: "application/x-xpinstall",
  source: "application/zip",
});
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const RUN_DISCOVERY_ATTEMPTS = 60;
const RUN_DISCOVERY_DELAY_MS = 2_000;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has invalid keys: ${actual.join(", ")}`);
  }
  return value;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateSha(value, label = "commit SHA") {
  const normalized = String(value ?? "").toLowerCase();
  if (!FULL_SHA_RE.test(normalized)) throw new Error(`${label} is not an exact 40-character SHA`);
  return normalized;
}

export function parseExtensionVersion(value) {
  const text = String(value ?? "");
  if (!EXTENSION_VERSION_RE.test(text)) {
    throw new Error("version must be canonical MAJOR.MINOR.PATCH");
  }
  return Object.freeze({ canonical: text, components: text.split(".").map(Number) });
}

export function compareExtensionVersions(left, right) {
  const leftParts = parseExtensionVersion(left).components;
  const rightParts = parseExtensionVersion(right).components;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function parseUtcVersion(value) {
  const match = VERSION_RE.exec(String(value ?? ""));
  if (!match) throw new Error("version must use UTC YY.M.D format");
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("version is not a real UTC calendar date");
  }
  const canonical = `${match[1]}.${month}.${day}`;
  if (canonical !== value) throw new Error(`version must be canonical: ${canonical}`);
  return Object.freeze({ canonical, date, day, month, year });
}

export function formatUtcVersion(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("date is invalid");
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2099) throw new Error("UTC release year must be between 2000 and 2099");
  return `${String(year).slice(-2)}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

export function compareUtcVersions(left, right) {
  return parseUtcVersion(left).date.getTime() - parseUtcVersion(right).date.getTime();
}

function tagFor(version) {
  return `v${parseExtensionVersion(version).canonical}`;
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("usage: chzzk-ops <status|ship|release|deploy|rollback> [version] [--json]");
  }
  const command = argv[0];
  if (!PUBLIC_COMMANDS.has(command)) throw new Error(`unknown command: ${String(command)}`);
  let json = false;
  let optionVersion = null;
  const positional = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new Error("--json may be specified only once");
      json = true;
    } else if (argument === "--version") {
      if (optionVersion !== null || index + 1 >= argv.length) {
        throw new Error("--version requires exactly one value");
      }
      optionVersion = argv[++index];
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length > 1) throw new Error(`${command} accepts at most one positional version`);
  if (positional.length > 0 && optionVersion !== null) {
    throw new Error("provide the version either positionally or with --version, not both");
  }
  let version = positional.length > 0 ? positional[0] : (optionVersion ?? undefined);
  if (new Set(["status", "ship", "release"]).has(command) && version !== undefined) {
    throw new Error(`${command} does not accept a version`);
  }
  if (command === "rollback" && version === undefined) {
    throw new Error("rollback requires an immutable release version");
  }
  if (version !== undefined) version = parseExtensionVersion(version).canonical;
  return Object.freeze({ command, json, version: version ?? null });
}

export function redactSensitive(value) {
  let text = String(value ?? "");
  text = text.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@");
  text = text.replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[redacted]");
  text = text.replace(/\b(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return text;
}

function validateInvocation(command, args) {
  if (!ALLOWED_EXECUTABLES.has(command)) throw new Error(`operator executable is not allowed: ${command}`);
  if (
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new Error("operator command arguments are malformed");
  }
  if (command === "gh" && args[0] === "auth" && args[1] === "token") {
    throw new Error("the operator must use the gh keyring and never extract its token");
  }
  for (const argument of args) {
    if (/^(?:GH|GITHUB)_.+TOKEN=/i.test(argument)) {
      throw new Error("tokens must never be passed in command arguments");
    }
  }
}

export function createSubprocessRunner({ environment = process.env, spawn = spawnSync } = {}) {
  const keyringEnvironment = { ...environment };
  for (const name of ["GH_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_TOKEN"]) {
    delete keyringEnvironment[name];
  }
  return async (command, args, options = {}) => {
    validateInvocation(command, args);
    const result = spawn(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: keyringEnvironment,
      input: options.input,
      maxBuffer: MAX_COMMAND_OUTPUT,
      shell: false,
      stdio: options.stdio ?? "pipe",
      windowsHide: true,
    });
    if (result.error) throw new Error(`${command} could not start: ${redactSensitive(result.error.message)}`);
    const status = Number.isInteger(result.status) ? result.status : 1;
    const output = Object.freeze({
      status,
      stderr: String(result.stderr ?? "").trimEnd(),
      stdout: String(result.stdout ?? "").trimEnd(),
    });
    if (status !== 0 && !options.allowFailure) {
      const detail = redactSensitive(output.stderr || output.stdout || `exit ${status}`);
      throw new Error(`${command} failed: ${detail}`);
    }
    return output;
  };
}

async function invoke(run, command, args, options = {}) {
  validateInvocation(command, args);
  const result = await run(command, args, options);
  if (typeof result === "string") return { status: 0, stderr: "", stdout: result.trimEnd() };
  if (!result || typeof result !== "object") throw new Error(`${command} runner returned no result`);
  const normalized = {
    status: Number.isInteger(result.status) ? result.status : 0,
    stderr: String(result.stderr ?? "").trimEnd(),
    stdout: String(result.stdout ?? "").trimEnd(),
  };
  if (normalized.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} failed: ${redactSensitive(normalized.stderr || normalized.stdout)}`);
  }
  return normalized;
}

async function textCommand(run, command, args, options = {}) {
  return (await invoke(run, command, args, options)).stdout.trim();
}

async function jsonCommand(run, command, args, label, options = {}) {
  const result = await invoke(run, command, args, options);
  if (result.status !== 0 && options.allowFailure) return null;
  return parseJson(result.stdout, label);
}

function apiArgs(endpoint, { method = "GET" } = {}) {
  const input = method === "GET" ? [] : ["--input", "-"];
  return ["api", "--method", method, ...API_HEADERS, ...input, endpoint];
}

export function normalizeRepositoryRemote(value) {
  const text = String(value ?? "").trim();
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(text);
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(text);
  const match = https ?? ssh;
  if (!match) throw new Error("origin must be a canonical github.com HTTPS or SSH URL");
  return `${match[1]}/${match[2]}`;
}

function validateBranch(branch) {
  if (!SAFE_BRANCH_RE.test(String(branch ?? ""))) throw new Error("current Git branch name is unsafe");
  return branch;
}

function encodeRef(value) {
  return encodeURIComponent(validateBranch(value));
}

export async function readRepositoryContext({ cwd = process.cwd(), run }) {
  const root = realpathSync(await textCommand(run, "git", ["rev-parse", "--show-toplevel"], { cwd }));
  const origin = await textCommand(run, "git", ["remote", "get-url", OPS_REMOTE], { cwd: root });
  if (normalizeRepositoryRemote(origin).toLowerCase() !== OPS_REPOSITORY.toLowerCase()) {
    throw new Error(`origin is not the canonical ${OPS_REPOSITORY} repository`);
  }
  const branch = validateBranch(
    await textCommand(run, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }),
  );
  const headSha = validateSha(
    await textCommand(run, "git", ["rev-parse", "HEAD"], { cwd: root }),
    "local HEAD",
  );
  const dirtyOutput = await textCommand(run, "git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
  });
  const viewer = await jsonCommand(run, "gh", apiArgs("user"), "GitHub viewer", { cwd: root });
  if (viewer?.login !== OPS_LOGIN) throw new Error(`gh must be authenticated as ${OPS_LOGIN}`);
  const repository = await jsonCommand(run, "gh", apiArgs(`repos/${OPS_REPOSITORY}`), "GitHub repository", {
    cwd: root,
  });
  if (
    repository?.id !== OPS_REPOSITORY_ID ||
    repository?.full_name !== OPS_REPOSITORY ||
    repository?.default_branch !== OPS_DEFAULT_BRANCH ||
    repository?.archived === true ||
    repository?.disabled === true ||
    repository?.permissions?.admin !== true ||
    repository?.allow_squash_merge !== true ||
    repository?.allow_merge_commit !== false ||
    repository?.allow_rebase_merge !== false ||
    repository?.allow_auto_merge !== false ||
    repository?.delete_branch_on_merge !== true
  ) {
    throw new Error("GitHub repository identity, authority, or merge policy is unexpected");
  }
  const remoteBranch = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/branches/${encodeRef(OPS_DEFAULT_BRANCH)}`),
    "protected default branch",
    { cwd: root },
  );
  const remoteMainSha = validateSha(remoteBranch?.commit?.sha, "remote main HEAD");
  if (remoteBranch?.protected !== true) throw new Error("GitHub main branch is not protected");
  const protection = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/branches/${encodeRef(OPS_DEFAULT_BRANCH)}/protection`),
    "default branch protection",
    { cwd: root },
  );
  const checks = Array.isArray(protection?.required_status_checks?.checks)
    ? protection.required_status_checks.checks
    : [];
  const checkNames = checks.map((check) => check?.context).sort();
  if (
    protection?.required_status_checks?.strict !== true ||
    JSON.stringify(checkNames) !== JSON.stringify([...REQUIRED_CHECKS].sort()) ||
    checks.some((check) => check?.app_id !== OPS_ACTIONS_APP_ID) ||
    protection?.enforce_admins?.enabled !== true ||
    protection?.required_pull_request_reviews?.required_approving_review_count !== 0 ||
    protection?.required_conversation_resolution?.enabled !== true ||
    protection?.allow_force_pushes?.enabled !== false ||
    protection?.allow_deletions?.enabled !== false
  ) {
    throw new Error("GitHub main branch protection differs from the exact operator policy");
  }
  return Object.freeze({
    branch,
    clean: dirtyOutput === "",
    dirtyEntries: dirtyOutput ? dirtyOutput.split(/\r?\n/).length : 0,
    headSha,
    remoteMainSha,
    root,
  });
}

function requireClean(context) {
  if (!context.clean) throw new Error("operator mutation requires a clean Git worktree");
}

function requireExactMain(context) {
  requireClean(context);
  if (context.branch !== OPS_DEFAULT_BRANCH || context.headSha !== context.remoteMainSha) {
    throw new Error("operation requires clean local main at the exact protected remote HEAD");
  }
}

function readProjectVersion(root) {
  const packageJson = parseJson(readFileSync(join(root, "package.json"), "utf8"), "package.json");
  const manifest = parseJson(readFileSync(join(root, "manifest.json"), "utf8"), "manifest.json");
  if (typeof packageJson?.version !== "string" || packageJson.version !== manifest?.version) {
    throw new Error("package.json and manifest.json versions must match");
  }
  return packageJson.version;
}

function canonicalAssetNames(version) {
  const canonical = parseExtensionVersion(version).canonical;
  return Object.freeze({
    metadata: `chzzk-${canonical}-release-metadata.json`,
    signed: `chzzk-${canonical}-signed.xpi`,
    source: `chzzk-${canonical}.zip`,
  });
}

function releaseRunTitle(version, nonce) {
  parseUtcVersion(version);
  if (!NONCE_RE.test(nonce)) throw new Error("release nonce is invalid");
  return `${RELEASE_RUN_PREFIX} ${nonce}`;
}

export function parseReleaseRunTitle(title) {
  const escaped = RELEASE_RUN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped} ([a-f0-9]{32})$`).exec(String(title ?? ""));
  if (!match) return null;
  return Object.freeze({ nonce: match[1] });
}

function sameUtcDay(isoTimestamp, date) {
  if (typeof isoTimestamp !== "string") return false;
  const parsed = new Date(isoTimestamp);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === date.getUTCFullYear() &&
    parsed.getUTCMonth() === date.getUTCMonth() &&
    parsed.getUTCDate() === date.getUTCDate()
  );
}

export function classifyDailyReleaseState({ headSha, now, releases, runs, version }) {
  const exactHead = validateSha(headSha, "daily release source");
  const parsedVersion = parseUtcVersion(version);
  if (formatUtcVersion(now) !== version)
    throw new Error("daily release version does not match current UTC day");
  if (!Array.isArray(releases) || !Array.isArray(runs)) throw new Error("release state inputs are malformed");
  const publishedToday = releases.filter(
    (release) => !release.isDraft && sameUtcDay(release.publishedAt, parsedVersion.date),
  );
  if (publishedToday.length > 1)
    throw new Error("more than one GitHub release was published on this UTC day");
  if (publishedToday.length === 1 && publishedToday[0].tagName !== tagFor(version)) {
    throw new Error("another GitHub release already consumed this UTC release day");
  }
  const tagged = releases.filter((release) => release.tagName === tagFor(version));
  if (tagged.length > 1) throw new Error("GitHub returned duplicate releases for the canonical daily tag");
  const release = tagged[0] ?? null;
  if (release?.targetCommitish && !FULL_SHA_RE.test(release.targetCommitish)) {
    throw new Error("daily release tag is not bound to an exact source SHA");
  }
  const matchingRuns = runs
    .map((run) => ({ parsed: parseReleaseRunTitle(run.displayTitle), run }))
    .filter(({ parsed, run }) => parsed && run.headSha?.toLowerCase() === exactHead);
  const pendingRuns = matchingRuns.filter(({ run }) =>
    new Set(["in_progress", "pending", "queued", "requested", "waiting"]).has(run.status),
  );
  if (pendingRuns.length > 1)
    throw new Error("multiple release workflows are pending for the same UTC release");
  if (release?.isImmutable === true && release?.isDraft !== true) {
    return Object.freeze({ kind: "published", pendingRun: null, release });
  }
  if (release?.isDraft === true) {
    return Object.freeze({ kind: "draft", pendingRun: pendingRuns[0]?.run ?? null, release });
  }
  if (release) throw new Error("daily release is neither a draft nor immutable published state");
  if (pendingRuns.length === 1) {
    return Object.freeze({ kind: "workflow", pendingRun: pendingRuns[0].run, release: null });
  }
  return Object.freeze({ kind: "ready", pendingRun: null, release: null });
}

async function listReleaseState(run, context, now) {
  const version = formatUtcVersion(now);
  const releaseResponse = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/releases?per_page=100`),
    "GitHub releases",
    { cwd: context.root },
  );
  if (!Array.isArray(releaseResponse)) throw new Error("GitHub release list is malformed");
  const releases = releaseResponse.map((release) => ({
    isDraft: release?.draft,
    isImmutable: release?.immutable,
    publishedAt: release?.published_at,
    tagName: release?.tag_name,
    targetCommitish: release?.target_commitish,
  }));
  const runs = await jsonCommand(
    run,
    "gh",
    [
      "run",
      "list",
      "--repo",
      OPS_REPOSITORY,
      "--workflow",
      OPS_SIGNING_WORKFLOW,
      "--event",
      "workflow_dispatch",
      "--limit",
      "50",
      "--json",
      "databaseId,displayTitle,event,headBranch,headSha,status,conclusion,createdAt",
    ],
    "release workflow runs",
    { cwd: context.root },
  );
  return {
    state: classifyDailyReleaseState({
      headSha: context.remoteMainSha,
      now,
      releases,
      runs,
      version,
    }),
    version,
  };
}

async function unresolvedConversationCount(run, context, number) {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}`;
  const response = await jsonCommand(
    run,
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      "owner=solitude0429",
      "-F",
      "name=CHZZK",
      "-F",
      `number=${number}`,
    ],
    "pull request conversations",
    { cwd: context.root },
  );
  const threads = response?.data?.repository?.pullRequest?.reviewThreads;
  if (!Array.isArray(threads?.nodes) || threads?.pageInfo?.hasNextPage === true) {
    throw new Error("unable to prove the complete pull request conversation state");
  }
  return threads.nodes.filter((thread) => thread?.isResolved !== true).length;
}

function assertRequiredChecks(pullRequest) {
  const checks = Array.isArray(pullRequest?.statusCheckRollup) ? pullRequest.statusCheckRollup : [];
  for (const name of REQUIRED_CHECKS) {
    const matching = checks.filter((check) => check?.name === name);
    if (matching.length !== 1 || matching[0].conclusion !== "SUCCESS") {
      throw new Error(`required check is not uniquely successful: ${name}`);
    }
  }
}

async function branchChangesProduct(run, context) {
  if (context.branch === OPS_DEFAULT_BRANCH) return false;
  const output = await textCommand(
    run,
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRT", `${context.remoteMainSha}...${context.headSha}`],
    { cwd: context.root },
  );
  const paths = output ? output.split(/\r?\n/).filter(Boolean) : [];
  return paths.some(
    (path) =>
      !(
        path === "AGENTS.md" ||
        path === "README.md" ||
        path === "eslint.config.js" ||
        path.startsWith(".github/") ||
        path.startsWith("docs/") ||
        path.startsWith("scripts/") ||
        path.startsWith("tests/")
      ),
  );
}

function writeVersionDocument(path, document) {
  const temporary = `${path}.chzzk-version-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename removes the temporary path; a failed write reports its own error.
    }
  }
}

async function ensureUtcProjectVersion({ context, run, version }) {
  parseUtcVersion(version);
  if (readProjectVersion(context.root) === version) return context;
  const packagePath = join(context.root, "package.json");
  const lockPath = join(context.root, "package-lock.json");
  const manifestPath = join(context.root, "manifest.json");
  const packageJson = parseJson(readFileSync(packagePath, "utf8"), "package.json");
  const packageLock = parseJson(readFileSync(lockPath, "utf8"), "package-lock.json");
  const manifest = parseJson(readFileSync(manifestPath, "utf8"), "manifest.json");
  if (
    typeof packageJson.version !== "string" ||
    typeof manifest.version !== "string" ||
    typeof packageLock.version !== "string" ||
    typeof packageLock.packages?.[""]?.version !== "string"
  ) {
    throw new Error("project version documents do not have the canonical four version fields");
  }
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  manifest.version = version;
  writeVersionDocument(packagePath, packageJson);
  writeVersionDocument(lockPath, packageLock);
  writeVersionDocument(manifestPath, manifest);
  if (readProjectVersion(context.root) !== version) {
    throw new Error("project version bump failed authoritative readback");
  }
  await invoke(run, "git", ["add", "--", "manifest.json", "package.json", "package-lock.json"], {
    cwd: context.root,
  });
  await invoke(run, "git", ["commit", "-m", `chore: release ${version}`], { cwd: context.root });
  const refreshed = await readRepositoryContext({ cwd: context.root, run });
  requireClean(refreshed);
  if (refreshed.branch !== context.branch || refreshed.remoteMainSha !== context.remoteMainSha) {
    throw new Error("repository state changed while committing the UTC release version");
  }
  return refreshed;
}

async function queueShipPending({ context, run, version }) {
  requireClean(context);
  if (context.branch === OPS_DEFAULT_BRANCH || !context.branch.startsWith("agent/")) {
    throw new Error("same-day product changes must be queued from a clean agent/* branch");
  }
  const existing = await jsonCommand(
    run,
    "gh",
    [
      "pr",
      "list",
      "--repo",
      OPS_REPOSITORY,
      "--state",
      "open",
      "--label",
      "ship-pending",
      "--limit",
      "10",
      "--json",
      "number,headRefName,headRefOid,url",
    ],
    "ship-pending pull requests",
    { cwd: context.root },
  );
  if (!Array.isArray(existing) || existing.length > 1) {
    throw new Error("unable to prove there is at most one ship-pending pull request");
  }
  if (existing.length === 1) {
    if (
      existing[0].headRefName === context.branch &&
      existing[0].headRefOid?.toLowerCase() === context.headSha
    ) {
      return {
        command: "ship",
        pullRequest: existing[0].number,
        queued: true,
        reason: `UTC release ${version} is already published`,
        url: existing[0].url,
      };
    }
    throw new Error(`product release is queued in the existing ship-pending PR: ${existing[0].url}`);
  }
  await invoke(run, "git", ["push", "-u", OPS_REMOTE, `${context.headSha}:refs/heads/${context.branch}`], {
    cwd: context.root,
  });
  await invoke(
    run,
    "gh",
    [
      "label",
      "create",
      "ship-pending",
      "--repo",
      OPS_REPOSITORY,
      "--color",
      "D4C5F9",
      "--description",
      "Queued for the next UTC CHZZK release",
      "--force",
    ],
    { cwd: context.root },
  );
  await invoke(
    run,
    "gh",
    [
      "pr",
      "create",
      "--repo",
      OPS_REPOSITORY,
      "--base",
      OPS_DEFAULT_BRANCH,
      "--head",
      context.branch,
      "--draft",
      "--label",
      "ship-pending",
      "--title",
      "ship-pending: CHZZK changes for the next UTC release",
      "--body",
      `UTC release ${version} is already immutable. Exact queued source: \`${context.headSha}\`.`,
    ],
    { cwd: context.root },
  );
  const created = await jsonCommand(
    run,
    "gh",
    [
      "pr",
      "list",
      "--repo",
      OPS_REPOSITORY,
      "--state",
      "open",
      "--label",
      "ship-pending",
      "--limit",
      "10",
      "--json",
      "number,headRefName,headRefOid,url",
    ],
    "created ship-pending pull request",
    { cwd: context.root },
  );
  if (
    created.length !== 1 ||
    created[0].headRefName !== context.branch ||
    created[0].headRefOid?.toLowerCase() !== context.headSha
  ) {
    throw new Error("GitHub did not bind one ship-pending PR to the exact source SHA");
  }
  return {
    command: "ship",
    pullRequest: created[0].number,
    queued: true,
    reason: `UTC release ${version} is already published`,
    url: created[0].url,
  };
}

export async function shipCurrentBranch({ context, run }) {
  requireClean(context);
  if (context.branch === OPS_DEFAULT_BRANCH) {
    if (context.headSha === context.remoteMainSha) {
      return { command: "ship", headSha: context.headSha, reused: true, state: "already-on-main" };
    }
    throw new Error("local main differs from protected remote main");
  }
  if (!context.branch.startsWith("agent/")) {
    throw new Error("ship requires a clean agent/* branch");
  }
  await invoke(run, "git", ["push", "-u", OPS_REMOTE, `${context.headSha}:refs/heads/${context.branch}`], {
    cwd: context.root,
  });
  const remoteBranch = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/branches/${encodeRef(context.branch)}`),
    "pushed branch",
    { cwd: context.root },
  );
  if (validateSha(remoteBranch?.commit?.sha, "pushed branch HEAD") !== context.headSha) {
    throw new Error("remote branch does not match the exact local source SHA");
  }
  const pullRequests = await jsonCommand(
    run,
    "gh",
    [
      "pr",
      "list",
      "--repo",
      OPS_REPOSITORY,
      "--head",
      context.branch,
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,state,isDraft,headRefOid,baseRefName,url",
    ],
    "pull request lookup",
    { cwd: context.root },
  );
  let pullRequest = pullRequests.find(
    (candidate) => candidate?.headRefOid?.toLowerCase() === context.headSha,
  );
  if (!pullRequest) {
    const openCandidates = pullRequests.filter(
      (candidate) => candidate?.state === "OPEN" && candidate?.baseRefName === OPS_DEFAULT_BRANCH,
    );
    if (openCandidates.length > 1) {
      throw new Error("multiple open pull requests exist for the current branch");
    }
    if (openCandidates.length === 1) {
      const refreshed = await jsonCommand(
        run,
        "gh",
        [
          "pr",
          "view",
          String(openCandidates[0].number),
          "--repo",
          OPS_REPOSITORY,
          "--json",
          "number,state,isDraft,headRefOid,baseRefName,url",
        ],
        "refreshed pull request head",
        { cwd: context.root },
      );
      if (refreshed?.headRefOid?.toLowerCase() !== context.headSha) {
        throw new Error("pull request head has not reached the exact pushed source SHA");
      }
      pullRequest = refreshed;
    }
  }
  if (pullRequest?.state === "MERGED") {
    return { command: "ship", headSha: context.headSha, pullRequest: pullRequest.number, reused: true };
  }
  if (pullRequest?.state === "CLOSED") throw new Error("the exact-head pull request is closed without merge");
  if (!pullRequest) {
    const title = await textCommand(run, "git", ["log", "-1", "--pretty=%s"], { cwd: context.root });
    if (!title || /[\r\n]/.test(title)) throw new Error("commit title is missing or malformed");
    await invoke(
      run,
      "gh",
      [
        "pr",
        "create",
        "--repo",
        OPS_REPOSITORY,
        "--base",
        OPS_DEFAULT_BRANCH,
        "--head",
        context.branch,
        "--title",
        title,
        "--body",
        `Exact source: \`${context.headSha}\`\n\nCreated by the CHZZK operator.`,
      ],
      { cwd: context.root },
    );
    const open = await jsonCommand(
      run,
      "gh",
      [
        "pr",
        "list",
        "--repo",
        OPS_REPOSITORY,
        "--head",
        context.branch,
        "--state",
        "open",
        "--limit",
        "10",
        "--json",
        "number,state,isDraft,headRefOid,baseRefName,url",
      ],
      "created pull request",
      { cwd: context.root },
    );
    pullRequest = open.find((candidate) => candidate?.headRefOid?.toLowerCase() === context.headSha);
  }
  if (
    !Number.isSafeInteger(pullRequest?.number) ||
    pullRequest.state !== "OPEN" ||
    pullRequest.baseRefName !== OPS_DEFAULT_BRANCH ||
    pullRequest.headRefOid?.toLowerCase() !== context.headSha
  ) {
    throw new Error("unable to bind an open pull request to the exact source SHA");
  }
  if (pullRequest.isDraft) {
    await invoke(run, "gh", ["pr", "ready", String(pullRequest.number), "--repo", OPS_REPOSITORY], {
      cwd: context.root,
    });
  }
  await invoke(
    run,
    "gh",
    [
      "pr",
      "checks",
      String(pullRequest.number),
      "--repo",
      OPS_REPOSITORY,
      "--required",
      "--watch",
      "--fail-fast",
    ],
    { cwd: context.root },
  );
  const finalState = await jsonCommand(
    run,
    "gh",
    [
      "pr",
      "view",
      String(pullRequest.number),
      "--repo",
      OPS_REPOSITORY,
      "--json",
      "number,state,isDraft,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup",
    ],
    "final pull request state",
    { cwd: context.root },
  );
  if (
    finalState?.state !== "OPEN" ||
    finalState?.isDraft ||
    finalState?.headRefOid?.toLowerCase() !== context.headSha ||
    finalState?.baseRefName !== OPS_DEFAULT_BRANCH ||
    !new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]).has(finalState?.mergeStateStatus)
  ) {
    throw new Error("pull request changed or is not mergeable at the exact reviewed head");
  }
  assertRequiredChecks(finalState);
  if ((await unresolvedConversationCount(run, context, pullRequest.number)) !== 0) {
    throw new Error("pull request has unresolved conversations");
  }
  const review = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/pulls/${pullRequest.number}/reviews`, { method: "POST" }),
    "exact-head operator review",
    {
      cwd: context.root,
      input: `${JSON.stringify({
        body: `Final CHZZK operator review: required checks passed and no blocking findings remain for exact head ${context.headSha}.`,
        commit_id: context.headSha,
        event: "COMMENT",
      })}\n`,
    },
  );
  if (
    !Number.isSafeInteger(review?.id) ||
    review?.state !== "COMMENTED" ||
    review?.commit_id?.toLowerCase() !== context.headSha
  ) {
    throw new Error("GitHub did not record the final COMMENT review on the exact pull request head");
  }
  const headAfterReview = await jsonCommand(
    run,
    "gh",
    ["pr", "view", String(pullRequest.number), "--repo", OPS_REPOSITORY, "--json", "headRefOid,state"],
    "post-review pull request head",
    { cwd: context.root },
  );
  if (headAfterReview?.state !== "OPEN" || headAfterReview?.headRefOid?.toLowerCase() !== context.headSha) {
    throw new Error("pull request head changed after the final exact-head review");
  }
  await invoke(
    run,
    "gh",
    [
      "pr",
      "merge",
      String(pullRequest.number),
      "--repo",
      OPS_REPOSITORY,
      "--squash",
      "--delete-branch",
      "--match-head-commit",
      context.headSha,
    ],
    { cwd: context.root },
  );
  const merged = await jsonCommand(
    run,
    "gh",
    [
      "pr",
      "view",
      String(pullRequest.number),
      "--repo",
      OPS_REPOSITORY,
      "--json",
      "state,headRefOid,mergeCommit",
    ],
    "merged pull request",
    { cwd: context.root },
  );
  if (merged?.state !== "MERGED" || merged?.headRefOid?.toLowerCase() !== context.headSha) {
    throw new Error("GitHub did not confirm the exact-head squash merge");
  }
  return {
    command: "ship",
    headSha: context.headSha,
    mergeSha: validateSha(merged?.mergeCommit?.oid, "squash merge SHA"),
    pullRequest: pullRequest.number,
    reused: false,
  };
}

function findUniqueFile(root, name) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === name) matches.push(path);
    }
  };
  visit(root);
  if (matches.length !== 1) throw new Error(`workflow artifact must contain exactly one ${name}`);
  return matches[0];
}

async function attestFiles(run, context, files, sourceSha) {
  for (const path of Object.values(files)) {
    await invoke(
      run,
      "gh",
      [
        "attestation",
        "verify",
        path,
        "--repo",
        OPS_REPOSITORY,
        "--source-digest",
        sourceSha,
        "--signer-workflow",
        OPS_SIGNER_WORKFLOW,
      ],
      { cwd: context.root },
    );
  }
}

async function verifyAssetSetDefault({ context, directory, run, sourceSha, version }) {
  const names = canonicalAssetNames(version);
  const files = Object.fromEntries(
    Object.entries(names).map(([kind, name]) => [kind, findUniqueFile(directory, name)]),
  );
  await attestFiles(run, context, files, sourceSha);
  const { verifySignedReleaseStructure } = await import("./lib/release-artifacts.js");
  const verified = await verifySignedReleaseStructure({
    metadataPath: files.metadata,
    signedXpiPath: files.signed,
    sourceArchivePath: files.source,
  });
  if (verified.version !== version || verified.sourceDigest !== sourceSha) {
    throw new Error("verified release artifacts do not match the requested version and source SHA");
  }
  const digests = Object.fromEntries(
    Object.entries(files).map(([kind, path]) => [kind, sha256(readFileSync(path))]),
  );
  return Object.freeze({ digests, files, metadata: verified.metadata, names });
}

function validateReleaseReadback(release, { sourceSha, version, verified = null }) {
  const tag = tagFor(version);
  if (
    release?.tag_name !== tag ||
    release?.draft === true ||
    release?.immutable !== true ||
    String(release?.target_commitish ?? "").toLowerCase() !== sourceSha
  ) {
    throw new Error("published release readback is not exact and immutable");
  }
  if (verified) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (assets.length !== 3) throw new Error("published release must contain exactly three assets");
    for (const [kind, name] of Object.entries(verified.names)) {
      const matches = assets.filter((asset) => asset?.name === name);
      if (
        matches.length !== 1 ||
        matches[0].state !== "uploaded" ||
        matches[0].digest !== `sha256:${verified.digests[kind]}`
      ) {
        throw new Error(`published release asset readback differs: ${name}`);
      }
    }
  }
  return release;
}

async function releaseByTag(run, context, version) {
  return jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/releases/tags/${encodeURIComponent(tagFor(version))}`),
    "release lookup",
    { cwd: context.root },
  );
}

async function releaseByTagIfPresent(run, context, version) {
  const releases = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/releases?per_page=100`),
    "release existence lookup",
    { cwd: context.root },
  );
  if (!Array.isArray(releases)) throw new Error("GitHub release list is malformed");
  const matches = releases.filter((release) => release?.tag_name === tagFor(version));
  if (matches.length > 1) throw new Error("GitHub returned duplicate releases for the exact tag");
  return matches[0] ?? null;
}

async function verifyPublishedRelease(run, context, version) {
  await invoke(run, "gh", ["release", "verify", tagFor(version), "--repo", OPS_REPOSITORY], {
    cwd: context.root,
  });
}

async function uploadDraftRelease({ context, run, sourceSha, verified, version }) {
  let release = await releaseByTagIfPresent(run, context, version);
  if (!release) {
    const payload = {
      body: `CHZZK ${version}\n\nExact source: ${sourceSha}`,
      draft: true,
      name: `CHZZK ${version}`,
      prerelease: false,
      tag_name: tagFor(version),
      target_commitish: sourceSha,
    };
    release = await jsonCommand(
      run,
      "gh",
      apiArgs(`repos/${OPS_REPOSITORY}/releases`, { method: "POST" }),
      "draft release creation",
      { cwd: context.root, input: `${JSON.stringify(payload)}\n` },
    );
  }
  if (
    !Number.isSafeInteger(release?.id) ||
    release?.draft !== true ||
    release?.tag_name !== tagFor(version) ||
    String(release?.target_commitish ?? "").toLowerCase() !== sourceSha
  ) {
    throw new Error("existing daily release is not the exact compatible draft");
  }
  const existing = Array.isArray(release.assets) ? release.assets : [];
  for (const [kind, name] of Object.entries(verified.names)) {
    const matches = existing.filter((asset) => asset?.name === name);
    if (matches.length > 1) throw new Error(`draft contains duplicate asset: ${name}`);
    if (matches.length === 1) {
      if (matches[0].digest !== `sha256:${verified.digests[kind]}`) {
        throw new Error(`draft asset differs and will not be overwritten: ${name}`);
      }
      continue;
    }
    const endpoint = `https://uploads.github.com/repos/${OPS_REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    await invoke(
      run,
      "gh",
      [
        "api",
        "--method",
        "POST",
        "-H",
        `Content-Type: ${ASSET_CONTENT_TYPES[kind]}`,
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
        "--input",
        verified.files[kind],
        endpoint,
      ],
      { cwd: context.root },
    );
  }
  const prepared = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/releases/${release.id}`),
    "prepared draft release",
    { cwd: context.root },
  );
  if (
    prepared?.id !== release.id ||
    prepared?.draft !== true ||
    prepared?.immutable === true ||
    prepared?.tag_name !== tagFor(version) ||
    String(prepared?.target_commitish ?? "").toLowerCase() !== sourceSha ||
    !Array.isArray(prepared?.assets) ||
    prepared.assets.length !== 3
  ) {
    throw new Error("draft release changed before publication");
  }
  for (const [kind, name] of Object.entries(verified.names)) {
    const matches = prepared.assets.filter((asset) => asset?.name === name);
    if (
      matches.length !== 1 ||
      matches[0].state !== "uploaded" ||
      matches[0].digest !== `sha256:${verified.digests[kind]}`
    ) {
      throw new Error(`draft release asset failed pre-publication readback: ${name}`);
    }
  }
  const immutableSetting = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/immutable-releases`),
    "pre-publication immutable release setting",
    { cwd: context.root },
  );
  if (immutableSetting?.enabled !== true) {
    throw new Error("immutable GitHub releases must remain enabled before publication");
  }
  const published = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/releases/${release.id}`, { method: "PATCH" }),
    "release publication",
    { cwd: context.root, input: '{"draft":false}\n' },
  );
  if (published?.id !== release.id || published?.draft === true) {
    throw new Error("GitHub did not publish the exact prepared draft release");
  }
  return jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/releases/${release.id}`),
    "published release readback",
    { cwd: context.root },
  );
}

async function waitForExactRun({ context, nonce, run, sleep, sourceSha, version }) {
  const expectedTitle = releaseRunTitle(version, nonce);
  for (let attempt = 0; attempt < RUN_DISCOVERY_ATTEMPTS; attempt += 1) {
    const runs = await jsonCommand(
      run,
      "gh",
      [
        "run",
        "list",
        "--repo",
        OPS_REPOSITORY,
        "--workflow",
        OPS_SIGNING_WORKFLOW,
        "--event",
        "workflow_dispatch",
        "--limit",
        "50",
        "--json",
        "databaseId,displayTitle,event,headBranch,headSha,status,conclusion",
      ],
      "release run discovery",
      { cwd: context.root },
    );
    const matches = runs.filter(
      (candidate) =>
        candidate?.displayTitle === expectedTitle &&
        candidate?.event === "workflow_dispatch" &&
        candidate?.headBranch === OPS_DEFAULT_BRANCH &&
        candidate?.headSha?.toLowerCase() === sourceSha,
    );
    if (matches.length > 1) throw new Error("release dispatch resolved to multiple workflow runs");
    if (matches.length === 1 && Number.isSafeInteger(matches[0].databaseId)) return matches[0];
    if (attempt + 1 < RUN_DISCOVERY_ATTEMPTS) await sleep(RUN_DISCOVERY_DELAY_MS);
  }
  throw new Error("timed out locating the exact release workflow run");
}

export async function reusableSuccessfulRun({ context, run, sourceSha }) {
  const runs = await jsonCommand(
    run,
    "gh",
    [
      "run",
      "list",
      "--repo",
      OPS_REPOSITORY,
      "--workflow",
      OPS_SIGNING_WORKFLOW,
      "--event",
      "workflow_dispatch",
      "--limit",
      "50",
      "--json",
      "databaseId,displayTitle,event,headBranch,headSha,status,conclusion,createdAt",
    ],
    "successful release run lookup",
    { cwd: context.root },
  );
  const candidates = runs
    .filter(
      (candidate) =>
        Number.isSafeInteger(candidate?.databaseId) &&
        parseReleaseRunTitle(candidate?.displayTitle) &&
        candidate?.event === "workflow_dispatch" &&
        candidate?.headBranch === OPS_DEFAULT_BRANCH &&
        candidate?.headSha?.toLowerCase() === sourceSha &&
        candidate?.status === "completed" &&
        candidate?.conclusion === "success",
    )
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const artifactName = `chzzk-release-assets-${sourceSha}`;
  for (const candidate of candidates) {
    const response = await jsonCommand(
      run,
      "gh",
      apiArgs(`repos/${OPS_REPOSITORY}/actions/runs/${candidate.databaseId}/artifacts`),
      "release run artifact lookup",
      { cwd: context.root },
    );
    const matches = Array.isArray(response?.artifacts)
      ? response.artifacts.filter(
          (artifact) =>
            artifact?.name === artifactName &&
            artifact?.expired === false &&
            Number.isSafeInteger(artifact?.size_in_bytes) &&
            artifact.size_in_bytes > 0,
        )
      : [];
    if (matches.length > 1) throw new Error("successful release run has duplicate canonical artifacts");
    if (matches.length === 1) return Object.freeze({ ...candidate, artifactName });
  }
  return null;
}

export async function completeRelease({
  context,
  daily,
  makeTempDirectory,
  nonceFactory,
  run,
  sleep,
  verifyAssetSet,
}) {
  requireExactMain(context);
  const version = daily.version;
  if (readProjectVersion(context.root) !== version) {
    throw new Error(`project version must be today's canonical UTC version ${version}`);
  }
  if (daily.state.kind === "published") {
    const release = await releaseByTag(run, context, version);
    validateReleaseReadback(release, { sourceSha: context.headSha, version });
    assertReleaseAssetSummary(release, version);
    await verifyPublishedRelease(run, context, version);
    return { command: "release", reused: true, sourceSha: context.headSha, version };
  }
  const immutableSetting = await jsonCommand(
    run,
    "gh",
    apiArgs(`repos/${OPS_REPOSITORY}/immutable-releases`),
    "immutable release setting",
    { cwd: context.root },
  );
  if (immutableSetting?.enabled !== true) throw new Error("immutable GitHub releases must be enabled");
  let exactRun = daily.state.pendingRun;
  if (!exactRun) {
    exactRun = await reusableSuccessfulRun({ context, run, sourceSha: context.headSha });
  }
  if (!exactRun) {
    const nonce = nonceFactory();
    if (!NONCE_RE.test(nonce)) throw new Error("release nonce generator returned an invalid value");
    await invoke(
      run,
      "gh",
      [
        "workflow",
        "run",
        OPS_SIGNING_WORKFLOW,
        "--repo",
        OPS_REPOSITORY,
        "--ref",
        OPS_DEFAULT_BRANCH,
        "--field",
        `source_sha=${context.headSha}`,
        "--field",
        `version=${version}`,
        "--field",
        `nonce=${nonce}`,
      ],
      { cwd: context.root },
    );
    exactRun = await waitForExactRun({
      context,
      nonce,
      run,
      sleep,
      sourceSha: context.headSha,
      version,
    });
  }
  if (!Number.isSafeInteger(exactRun?.databaseId)) throw new Error("pending release run ID is invalid");
  if (exactRun.status !== "completed" || exactRun.conclusion !== "success") {
    await invoke(
      run,
      "gh",
      ["run", "watch", String(exactRun.databaseId), "--repo", OPS_REPOSITORY, "--exit-status"],
      { cwd: context.root },
    );
  }
  const finalRun = await jsonCommand(
    run,
    "gh",
    [
      "run",
      "view",
      String(exactRun.databaseId),
      "--repo",
      OPS_REPOSITORY,
      "--json",
      "databaseId,displayTitle,event,headBranch,headSha,status,conclusion",
    ],
    "completed release run",
    { cwd: context.root },
  );
  const parsedTitle = parseReleaseRunTitle(finalRun?.displayTitle);
  if (
    finalRun?.databaseId !== exactRun.databaseId ||
    !parsedTitle ||
    finalRun?.event !== "workflow_dispatch" ||
    finalRun?.headBranch !== OPS_DEFAULT_BRANCH ||
    finalRun?.headSha?.toLowerCase() !== context.headSha ||
    finalRun?.status !== "completed" ||
    finalRun?.conclusion !== "success"
  ) {
    throw new Error("release workflow final readback is not the exact successful run");
  }
  const workDir = makeTempDirectory("chzzk-release-");
  try {
    await invoke(
      run,
      "gh",
      [
        "run",
        "download",
        String(exactRun.databaseId),
        "--repo",
        OPS_REPOSITORY,
        "--name",
        `chzzk-release-assets-${context.headSha}`,
        "--dir",
        workDir,
      ],
      { cwd: context.root },
    );
    const verified = await verifyAssetSet({
      context,
      directory: workDir,
      run,
      sourceSha: context.headSha,
      version,
    });
    await uploadDraftRelease({ context, run, sourceSha: context.headSha, verified, version });
    const release = await releaseByTag(run, context, version);
    validateReleaseReadback(release, { sourceSha: context.headSha, verified, version });
    await verifyPublishedRelease(run, context, version);
    return {
      command: "release",
      releaseId: release.id,
      reused: false,
      runId: exactRun.databaseId,
      sourceSha: context.headSha,
      version,
    };
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

function assertReleaseAssetSummary(release, version) {
  const names = canonicalAssetNames(version);
  if (
    release?.tag_name !== tagFor(version) ||
    release?.draft === true ||
    release?.immutable !== true ||
    !Array.isArray(release?.assets) ||
    release.assets.length !== 3
  ) {
    throw new Error("deployment requires one exact immutable GitHub release");
  }
  for (const name of Object.values(names)) {
    const matches = release.assets.filter((asset) => asset?.name === name);
    if (
      matches.length !== 1 ||
      matches[0].state !== "uploaded" ||
      !/^sha256:[a-f0-9]{64}$/.test(String(matches[0].digest ?? ""))
    ) {
      throw new Error(`immutable release asset summary is invalid: ${name}`);
    }
  }
  return names;
}

function canonicalLocalFile(path, label) {
  const absolute = resolve(path);
  const unresolved = lstatSync(absolute);
  if (unresolved.isSymbolicLink()) throw new Error(`${label} must not be a reparse point`);
  const canonical = realpathSync.native(absolute);
  const metadata = lstatSync(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error(`${label} must be a nonempty regular file`);
  }
  return canonical;
}

export function verifyLiveUpdateReadback(
  { root, signedXpiSha256, sourceSha, version },
  { environment = process.env, platform = process.platform, runner = spawnSync } = {},
) {
  if (platform !== "win32") throw new Error("production HTTPS readback requires Windows");
  const systemRoot = String(environment.SystemRoot ?? "");
  if (!/^[A-Za-z]:\\[^\0]+$/.test(systemRoot)) throw new Error("SystemRoot is invalid");
  const powershell = canonicalLocalFile(
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "Windows PowerShell",
  );
  const script = canonicalLocalFile(
    join(root, "scripts", "verify-live-update.windows.ps1"),
    "production readback script",
  );
  const childEnvironment = { ...environment };
  for (const name of [
    "GH_ENTERPRISE_TOKEN",
    "GH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) {
    delete childEnvironment[name];
  }
  const result = runner(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Version",
      parseExtensionVersion(version).canonical,
      "-SourceSha",
      validateSha(sourceSha, "live readback source SHA"),
      "-SignedXpiSha256",
      String(signedXpiSha256),
    ],
    {
      encoding: "utf8",
      env: childEnvironment,
      maxBuffer: 64 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result?.error || result?.status !== 0) {
    throw new Error(
      `production HTTPS readback failed: ${redactSensitive(result?.stderr || result?.stdout || result?.error?.message)}`,
    );
  }
  const evidence = exactKeys(
    parseJson(String(result.stdout ?? ""), "production HTTPS readback"),
    ["manifestMime", "schemaVersion", "signedXpiMime", "signedXpiSha256", "sourceSha", "status", "version"],
    "production HTTPS readback",
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.status !== "passed" ||
    evidence.version !== version ||
    evidence.sourceSha !== sourceSha ||
    evidence.signedXpiSha256 !== signedXpiSha256 ||
    evidence.manifestMime !== "application/json" ||
    evidence.signedXpiMime !== "application/x-xpinstall"
  ) {
    throw new Error("production HTTPS readback differs from the verified release");
  }
  return evidence;
}

async function downloadPreviousSignedXpi({ context, directory, run, targetVersion }) {
  const releases = await jsonCommand(
    run,
    "gh",
    [
      "release",
      "list",
      "--repo",
      OPS_REPOSITORY,
      "--exclude-drafts",
      "--limit",
      "100",
      "--json",
      "tagName,isImmutable,publishedAt",
    ],
    "previous signed release list",
    { cwd: context.root },
  );
  const candidates = releases
    .map((release) => {
      const tag = String(release?.tagName ?? "");
      try {
        return {
          ...release,
          version: tag.startsWith("v") ? parseExtensionVersion(tag.slice(1)).canonical : null,
        };
      } catch {
        return { ...release, version: null };
      }
    })
    .filter((release) => release.version && release.version !== targetVersion && release.isImmutable === true)
    .sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)));
  if (candidates.length === 0) return null;
  const previous = candidates[0];
  const release = await releaseByTag(run, context, previous.version);
  const sourceSha = validateSha(release?.target_commitish, "previous release source SHA");
  if (release?.draft === true || release?.immutable !== true) {
    throw new Error("previous signed release is not immutable");
  }
  const name = `chzzk-${previous.version}-signed.xpi`;
  const matches = Array.isArray(release?.assets)
    ? release.assets.filter((asset) => asset?.name === name)
    : [];
  if (
    matches.length !== 1 ||
    matches[0].state !== "uploaded" ||
    !/^sha256:[a-f0-9]{64}$/.test(String(matches[0].digest ?? ""))
  ) {
    throw new Error("previous signed XPI asset is invalid");
  }
  await invoke(
    run,
    "gh",
    [
      "release",
      "download",
      tagFor(previous.version),
      "--repo",
      OPS_REPOSITORY,
      "--dir",
      directory,
      "--pattern",
      name,
    ],
    { cwd: context.root },
  );
  const path = canonicalLocalFile(join(directory, name), "previous signed XPI");
  if (sha256(readFileSync(path)) !== matches[0].digest.slice("sha256:".length)) {
    throw new Error("previous signed XPI differs from its immutable Release digest");
  }
  await attestFiles(run, context, { signed: path }, sourceSha);
  await verifyPublishedRelease(run, context, previous.version);
  return Object.freeze({ path, sourceSha, version: previous.version });
}

async function resolveDeployVersion(run, context, requested) {
  if (requested) return requested;
  const releases = await jsonCommand(
    run,
    "gh",
    [
      "release",
      "list",
      "--repo",
      OPS_REPOSITORY,
      "--exclude-drafts",
      "--limit",
      "10",
      "--json",
      "tagName,isImmutable,publishedAt",
    ],
    "published release list",
    { cwd: context.root },
  );
  const latest = releases.find(
    (release) => release?.isImmutable === true && /^v\d{2}\.\d{1,2}\.\d{1,2}$/.test(release?.tagName),
  );
  if (!latest) throw new Error("no canonical immutable release is available to deploy");
  return parseUtcVersion(latest.tagName.slice(1)).canonical;
}

function ensureInside(parent, path) {
  const child = relative(parent, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || resolve(path) !== path) {
    throw new Error("temporary bundle path escaped its private parent");
  }
}

export async function bundleServerActivator({ directory, root }) {
  const output = join(directory, "server-update-activator.mjs");
  const esbuild = await import("esbuild");
  await esbuild.build({
    bundle: true,
    entryPoints: [join(root, "scripts", "server-update-activator.js")],
    format: "esm",
    logLevel: "silent",
    outfile: output,
    platform: "node",
    sourcemap: false,
    target: "node22",
  });
  chmodSync(output, 0o600);
  return output;
}

async function writeDeploymentBundle({ bundleActivator, directory, nonce, root, verified }) {
  if (!NONCE_RE.test(nonce)) throw new Error("deployment nonce is invalid");
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const [kind, path] of Object.entries(verified.files)) {
    const destination = join(directory, verified.names[kind]);
    copyFileSync(path, destination);
    chmodSync(destination, 0o600);
  }
  return bundleActivator({ directory, root });
}

export async function deployVersion({
  bundleActivator,
  context,
  makeTempDirectory,
  mode,
  nonceFactory,
  requestedVersion,
  run,
  runSignedUpdateSmoke,
  verifyAssetSet,
  verifyLiveReadback,
}) {
  requireExactMain(context);
  const version = await resolveDeployVersion(run, context, requestedVersion);
  const release = await releaseByTag(run, context, version);
  const names = assertReleaseAssetSummary(release, version);
  const sourceSha = validateSha(release.target_commitish, "release target SHA");
  const comparison = await jsonCommand(
    run,
    "gh",
    apiArgs(
      `repos/${OPS_REPOSITORY}/compare/${encodeURIComponent(tagFor(version))}...${encodeURIComponent(context.remoteMainSha)}`,
    ),
    "release ancestry",
    { cwd: context.root },
  );
  if (!new Set(["ahead", "identical"]).has(comparison?.status) || comparison?.behind_by !== 0) {
    throw new Error("release tag is not an ancestor of protected main");
  }
  const workRoot = makeTempDirectory("chzzk-deploy-");
  const downloadDir = join(workRoot, "download");
  const previousDir = join(workRoot, "previous");
  const nonce = nonceFactory();
  const bundleDir = join(workRoot, `chzzk-ops-${nonce}`);
  ensureInside(workRoot, downloadDir);
  ensureInside(workRoot, previousDir);
  ensureInside(workRoot, bundleDir);
  mkdirSync(downloadDir, { mode: 0o700 });
  mkdirSync(previousDir, { mode: 0o700 });
  try {
    await invoke(
      run,
      "gh",
      [
        "release",
        "download",
        tagFor(version),
        "--repo",
        OPS_REPOSITORY,
        "--dir",
        downloadDir,
        "--pattern",
        names.metadata,
        "--pattern",
        names.signed,
        "--pattern",
        names.source,
      ],
      { cwd: context.root },
    );
    const verified = await verifyAssetSet({
      context,
      directory: downloadDir,
      run,
      sourceSha,
      version,
    });
    for (const [kind, name] of Object.entries(names)) {
      const remote = release.assets.find((asset) => asset.name === name).digest;
      if (remote !== `sha256:${verified.digests[kind]}`) {
        throw new Error(`downloaded asset differs from immutable release digest: ${name}`);
      }
    }
    await verifyPublishedRelease(run, context, version);
    const previous =
      mode === "deploy"
        ? await downloadPreviousSignedXpi({
            context,
            directory: previousDir,
            run,
            targetVersion: version,
          })
        : null;
    const activator = await writeDeploymentBundle({
      bundleActivator,
      directory: bundleDir,
      nonce,
      root: context.root,
      verified,
    });
    const remoteDir = `/srv/admin/chzzk-ops-${nonce}`;
    let remoteCreated = false;
    try {
      await invoke(
        run,
        "ssh",
        [OPS_SERVER, "/run/current-system/sw/bin/mkdir", "-m", "0700", "--", remoteDir],
        { cwd: context.root },
      );
      remoteCreated = true;
      await invoke(
        run,
        "scp",
        [
          activator,
          verified.files.metadata,
          verified.files.signed,
          verified.files.source,
          `${OPS_SERVER}:${remoteDir}/`,
        ],
        { cwd: context.root },
      );
      const remoteResult = await invoke(
        run,
        "ssh",
        [
          OPS_SERVER,
          "/run/current-system/sw/bin/node",
          `${remoteDir}/${basename(activator)}`,
          "--mode",
          mode,
          "--metadata",
          `${remoteDir}/${verified.names.metadata}`,
          "--signed",
          `${remoteDir}/${verified.names.signed}`,
          "--source",
          `${remoteDir}/${verified.names.source}`,
          "--target",
          OPS_TARGET,
        ],
        { cwd: context.root },
      );
      const activated = parseJson(remoteResult.stdout, "server activation");
      if (
        activated?.version !== version ||
        activated?.signedXpiSha256 !== verified.digests.signed ||
        typeof activated?.reusedRelease !== "boolean"
      ) {
        throw new Error("server activation readback does not match the verified deployment");
      }
      const liveReadback = await verifyLiveReadback({
        root: context.root,
        signedXpiSha256: verified.digests.signed,
        sourceSha,
        version,
      });
      let firefoxSmoke = null;
      if (previous) {
        const resultPath = join(workRoot, "firefox-update-smoke-result.json");
        firefoxSmoke = await runSignedUpdateSmoke({
          metadataPath: verified.files.metadata,
          newXpiPath: verified.files.signed,
          oldXpiPath: previous.path,
          resultPath,
        });
        if (firefoxSmoke.extensionVersion !== version) {
          throw new Error("Firefox update smoke installed an unexpected extension version");
        }
      }
      return {
        command: mode === "rollback" ? "rollback" : "deploy",
        firefoxSmoke,
        liveReadback,
        previousVersion: previous?.version ?? null,
        reused: activated.reusedRelease,
        sourceSha,
        version,
      };
    } finally {
      if (remoteCreated) {
        const remoteFiles = [
          `${remoteDir}/${basename(activator)}`,
          `${remoteDir}/${verified.names.metadata}`,
          `${remoteDir}/${verified.names.signed}`,
          `${remoteDir}/${verified.names.source}`,
        ];
        await invoke(run, "ssh", [OPS_SERVER, "/run/current-system/sw/bin/rm", "-f", "--", ...remoteFiles], {
          allowFailure: true,
          cwd: context.root,
        });
        await invoke(run, "ssh", [OPS_SERVER, "/run/current-system/sw/bin/rmdir", "--", remoteDir], {
          allowFailure: true,
          cwd: context.root,
        });
      }
    }
  } finally {
    rmSync(workRoot, { force: true, recursive: true });
  }
}

async function synchronizeProtectedMain({ root, run }) {
  await invoke(run, "git", ["fetch", "--prune", OPS_REMOTE, OPS_DEFAULT_BRANCH], { cwd: root });
  await invoke(run, "git", ["switch", OPS_DEFAULT_BRANCH], { cwd: root });
  await invoke(run, "git", ["merge", "--ff-only", `${OPS_REMOTE}/${OPS_DEFAULT_BRANCH}`], {
    cwd: root,
  });
  const context = await readRepositoryContext({ cwd: root, run });
  requireExactMain(context);
  return context;
}

export async function shipWithOperator({
  bundleActivator,
  context,
  makeTempDirectory,
  nonceFactory,
  now,
  run,
  runSignedUpdateSmoke,
  sleep,
  verifyAssetSet,
  verifyLiveReadback,
}) {
  requireClean(context);
  const current = now();
  let daily = await listReleaseState(run, context, current);
  let productChange = await branchChangesProduct(run, context);

  if (context.branch !== OPS_DEFAULT_BRANCH) {
    if (new Set(["draft", "workflow"]).has(daily.state.kind)) {
      throw new Error("the current UTC release must finish before another branch can merge");
    }
    if (productChange && daily.state.kind === "published") {
      return queueShipPending({ context, run, version: daily.version });
    }
    if (productChange) {
      context = await ensureUtcProjectVersion({ context, run, version: daily.version });
    }
    const merged = await shipCurrentBranch({ context, run });
    const mainContext = await synchronizeProtectedMain({ root: context.root, run });
    if (merged.mergeSha && mainContext.headSha !== merged.mergeSha) {
      throw new Error("local protected main differs from the exact squash merge readback");
    }
    if (!productChange) return { ...merged, productChange: false };
    context = mainContext;
    daily = await listReleaseState(run, context, now());
  } else {
    requireExactMain(context);
    productChange = readProjectVersion(context.root) === daily.version;
    if (!productChange) {
      return {
        command: "ship",
        headSha: context.headSha,
        productChange: false,
        reused: true,
        state: "already-on-main",
      };
    }
  }

  const release = await completeRelease({
    context,
    daily,
    makeTempDirectory,
    nonceFactory,
    run,
    sleep,
    verifyAssetSet,
  });
  const deployment = await deployVersion({
    bundleActivator,
    context,
    makeTempDirectory,
    mode: "deploy",
    nonceFactory,
    requestedVersion: release.version,
    run,
    runSignedUpdateSmoke,
    verifyAssetSet,
    verifyLiveReadback,
  });
  return {
    command: "ship",
    deployment,
    headSha: context.headSha,
    productChange: true,
    release,
  };
}

function defaultTempDirectory(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  return path;
}

function defaultSleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readServerStatus({ context, run, verifyLiveReadback }) {
  const currentTarget = await textCommand(
    run,
    "ssh",
    [OPS_SERVER, "/run/current-system/sw/bin/readlink", "--", `${OPS_TARGET}/current`],
    { cwd: context.root },
  );
  const match = /^releases\/((?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2})$/.exec(currentTarget);
  if (!match) throw new Error("server current link is not a canonical managed release");
  const version = parseExtensionVersion(match[1]).canonical;
  const provenance = await jsonCommand(
    run,
    "ssh",
    [OPS_SERVER, "/run/current-system/sw/bin/cat", "--", `${OPS_TARGET}/current/provenance.json`],
    "server provenance",
    { cwd: context.root },
  );
  const signedName = `chzzk-${version}-signed.xpi`;
  const signedXpiSha256 = provenance?.assets?.[signedName];
  if (
    provenance?.schemaVersion !== 1 ||
    provenance?.version !== version ||
    provenance?.sourceRepository !== OPS_REPOSITORY ||
    !FULL_SHA_RE.test(String(provenance?.sourceDigest ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(signedXpiSha256 ?? ""))
  ) {
    throw new Error("server provenance is not canonical");
  }
  const serviceOutput = await textCommand(
    run,
    "ssh",
    [
      OPS_SERVER,
      "/run/current-system/sw/bin/systemctl",
      "is-active",
      "chzzk-updates.service",
      "caddy.service",
    ],
    { cwd: context.root },
  );
  if (
    serviceOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .some((state) => state !== "active")
  ) {
    throw new Error("server update backend or Caddy is inactive");
  }
  const liveReadback = await verifyLiveReadback({
    root: context.root,
    signedXpiSha256,
    sourceSha: provenance.sourceDigest,
    version,
  });
  return Object.freeze({
    caddy: "active",
    liveReadback,
    sourceSha: provenance.sourceDigest,
    updateBackend: "active",
    version,
  });
}

export function createOperator({
  bundleActivator = bundleServerActivator,
  makeTempDirectory = defaultTempDirectory,
  nonceFactory = () => cryptoRandomBytes(16).toString("hex"),
  now = () => new Date(),
  run = createSubprocessRunner(),
  runSignedUpdateSmoke = runWindowsSignedUpdateSmoke,
  sleep = defaultSleep,
  verifyAssetSet = verifyAssetSetDefault,
  verifyLiveReadback = verifyLiveUpdateReadback,
} = {}) {
  return Object.freeze({
    async execute({ command, version = null }) {
      const context = await readRepositoryContext({ run });
      if (command === "status") {
        const daily = await listReleaseState(run, context, now());
        const server = await readServerStatus({ context, run, verifyLiveReadback });
        let projectVersion = null;
        try {
          projectVersion = readProjectVersion(context.root);
        } catch {
          projectVersion = "invalid";
        }
        return {
          branch: context.branch,
          clean: context.clean,
          command,
          dailyState: daily.state.kind,
          headSha: context.headSha,
          pending: new Set(["draft", "workflow"]).has(daily.state.kind),
          projectVersion,
          remoteMainSha: context.remoteMainSha,
          server,
          version: daily.version,
        };
      }
      if (command === "ship") {
        return shipWithOperator({
          bundleActivator,
          context,
          makeTempDirectory,
          nonceFactory,
          now,
          run,
          runSignedUpdateSmoke,
          sleep,
          verifyAssetSet,
          verifyLiveReadback,
        });
      }
      if (command === "release") {
        const current = now();
        const daily = await listReleaseState(run, context, current);
        return completeRelease({
          context,
          daily,
          makeTempDirectory,
          nonceFactory,
          run,
          sleep,
          verifyAssetSet,
        });
      }
      if (command === "deploy") {
        return deployVersion({
          bundleActivator,
          context,
          makeTempDirectory,
          mode: "deploy",
          nonceFactory,
          requestedVersion: version,
          run,
          runSignedUpdateSmoke,
          verifyAssetSet,
          verifyLiveReadback,
        });
      }
      if (command === "rollback") {
        return deployVersion({
          bundleActivator,
          context,
          makeTempDirectory,
          mode: "rollback",
          nonceFactory,
          requestedVersion: version,
          run,
          runSignedUpdateSmoke,
          verifyAssetSet,
          verifyLiveReadback,
        });
      }
      throw new Error(`unsupported command: ${command}`);
    },
  });
}

function humanResult(result) {
  const fields = Object.entries(result)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `${name}=${typeof value === "object" ? JSON.stringify(value) : value}`);
  return fields.join(" ");
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCliArguments(argv);
    const result = await createOperator().execute(parsed);
    process.stdout.write(`${parsed.json ? JSON.stringify({ ok: true, ...result }) : humanResult(result)}\n`);
  } catch (error) {
    const message = redactSensitive(error instanceof Error ? error.message : String(error));
    if (parsed?.json || argv.includes("--json")) {
      process.stderr.write(
        `${JSON.stringify({ command: parsed?.command ?? argv[0] ?? null, error: message, ok: false })}\n`,
      );
    } else {
      process.stderr.write(`CHZZK operator failed: ${message}\n`);
    }
    process.exitCode = 1;
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

if (isDirectInvocation()) await main();
