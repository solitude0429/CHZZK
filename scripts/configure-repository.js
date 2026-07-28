#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_GITHUB_ACTIONS_CHECKS = ["analyze", "dependency-review", "firefox-e2e", "verify"];
export const REQUIRED_SIGNING_SECRET_NAMES = ["AMO_JWT_ISSUER", "AMO_JWT_SECRET"];

const FIREFOX_SIGNING_ENVIRONMENT = "firefox-signing";
const EXPECTED_REPOSITORY = "solitude0429/CHZZK";
const EXPECTED_REPOSITORY_ID = 1_275_903_171;
const OBSOLETE_LABELS = ["release-review-required", "security-review-required"];
const OBSOLETE_VARIABLES = ["AUTOMATED_REVIEW_LOGIN"];
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const API_HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
const TRUSTED_GIT_PREFIX = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
]);
const TRUSTED_SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

let commandRuntime = null;

function command(commandName, args, { cwd, input } = {}) {
  if (
    commandRuntime === null ||
    (commandName !== "gh" && commandName !== "git") ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new Error("Repository settings command is not allowlisted or is malformed");
  }
  const commandArgs = commandName === "git" ? [...TRUSTED_GIT_PREFIX, ...args] : args;
  const result = spawnSync(commandRuntime.executables[commandName], commandArgs, {
    cwd,
    encoding: "utf8",
    env: commandRuntime.environments[commandName],
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${commandName} command failed with status ${result.status ?? "unknown"}`);
  }
  return result.stdout.trim();
}

function ghApi(method, endpoint, body = null) {
  const args = ["api", "--method", method, ...API_HEADERS];
  if (body !== null) args.push("--input", "-");
  args.push(endpoint);
  return command("gh", args, {
    input: body === null ? undefined : `${JSON.stringify(body)}\n`,
  });
}

function ghApiPages(endpoint) {
  return command("gh", ["api", "--method", "GET", ...API_HEADERS, "--paginate", "--slurp", endpoint]);
}

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function requiredEnvironmentString(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredEnvironmentLogin(name) {
  const value = requiredEnvironmentString(name);
  if (!GITHUB_LOGIN_RE.test(value)) throw new Error(`${name} must be an exact GitHub login`);
  return value;
}

function trustedBootstrapExecutable(name) {
  const value = process.env[name];
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value !== resolve(value) ||
    value.includes("\0")
  ) {
    throw new Error(`Repository settings bootstrap executable is missing or malformed: ${name}`);
  }
  const path = realpathSync(value);
  const metadata = statSync(path);
  if (
    !metadata.isFile() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new Error(`Repository settings bootstrap executable is not a protected system binary: ${name}`);
  }
  return path;
}

function trustedBootstrapHome() {
  const value = process.env.CHZZK_REPOSITORY_SETTINGS_TRUSTED_GH_HOME;
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value !== resolve(value) ||
    value.includes("\0")
  ) {
    throw new Error("Repository settings bootstrap GitHub home is missing or malformed");
  }
  const metadata = statSync(value, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== currentUid || (metadata.mode & 0o077n) !== 0n) {
    throw new Error("Repository settings bootstrap GitHub home is not private");
  }
  for (const child of ["cache", "config"]) {
    const childMetadata = statSync(join(value, child), { bigint: true });
    if (
      !childMetadata.isDirectory() ||
      childMetadata.uid !== currentUid ||
      (childMetadata.mode & 0o077n) !== 0n
    ) {
      throw new Error(`Repository settings bootstrap GitHub ${child} directory is not private`);
    }
  }
  return value;
}

function readBootstrapContext() {
  if (process.env.GITHUB_ACTIONS !== undefined) {
    throw new Error("Repository settings must run out of band, never in GitHub Actions");
  }
  if (!import.meta.url.startsWith("data:text/javascript;base64,")) {
    throw new Error("Repository settings source was not memory-sealed by the external protected bootstrap");
  }
  const repository = requiredEnvironmentString("CHZZK_GITHUB_REPOSITORY");
  const releaseOperatorLogin = requiredEnvironmentLogin("CHZZK_REPOSITORY_SETTINGS_OPERATOR_LOGIN");
  const sourceSha = requiredEnvironmentString("CHZZK_REPOSITORY_SETTINGS_BOOTSTRAP_SHA").toLowerCase();
  const defaultBranch = requiredEnvironmentString("CHZZK_REPOSITORY_SETTINGS_DEFAULT_BRANCH");
  const checkout = requiredEnvironmentString("CHZZK_REPOSITORY_SETTINGS_CHECKOUT");
  const mode = requiredEnvironmentString("CHZZK_REPOSITORY_SETTINGS_MODE");
  const token = requiredEnvironmentString("GH_TOKEN");
  if (!REPOSITORY_RE.test(repository)) {
    throw new Error("CHZZK_GITHUB_REPOSITORY must use owner/repository form");
  }
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error("Repository settings bootstrap context is pinned to solitude0429/CHZZK");
  }
  if (!FULL_GIT_SHA_RE.test(sourceSha)) {
    throw new Error("Repository settings bootstrap SHA must be one full commit identity");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch)) {
    throw new Error("Repository settings default branch is missing or malformed");
  }
  if (
    !checkout.startsWith("/") ||
    checkout !== resolve(checkout) ||
    checkout.includes("\0") ||
    !statSync(realpathSync(checkout)).isDirectory()
  ) {
    throw new Error("Repository settings checkout is missing or malformed");
  }
  if (mode !== "dry-run" && mode !== "apply") {
    throw new Error("Repository settings bootstrap mode is missing or malformed");
  }
  if (!/^\S+$/.test(token)) {
    throw new Error("Repository settings bootstrap token is missing or malformed");
  }
  const executables = Object.freeze({
    gh: trustedBootstrapExecutable("CHZZK_REPOSITORY_SETTINGS_TRUSTED_GH"),
    git: trustedBootstrapExecutable("CHZZK_REPOSITORY_SETTINGS_TRUSTED_GIT"),
    node: trustedBootstrapExecutable("CHZZK_REPOSITORY_SETTINGS_TRUSTED_NODE"),
  });
  if (realpathSync(process.execPath) !== executables.node) {
    throw new Error("Repository settings must run with the bootstrap-selected system Node");
  }
  return Object.freeze({
    apply: mode === "apply",
    checkoutRoot: realpathSync(checkout),
    defaultBranch,
    executables,
    ghHome: trustedBootstrapHome(),
    releaseOperatorLogin,
    repository,
    sourceSha,
    token,
  });
}

function activateCommandRuntime(context) {
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
    HOME: context.ghHome,
    XDG_CONFIG_HOME: join(context.ghHome, "config"),
  });
  const gh = Object.freeze({
    ...git,
    GH_CONFIG_DIR: join(context.ghHome, "config"),
    GH_HOST: "github.com",
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: context.token,
    HOME: context.ghHome,
    XDG_CACHE_HOME: join(context.ghHome, "cache"),
  });
  commandRuntime = Object.freeze({
    environments: Object.freeze({ gh, git }),
    executables: context.executables,
  });
}

function sanitizeProcessEnvironment() {
  for (const name of Object.keys(process.env)) delete process.env[name];
  process.env.LANG = "C.UTF-8";
  process.env.LC_ALL = "C.UTF-8";
  process.env.PATH = TRUSTED_SYSTEM_PATH;
}

function paginatedField(endpoint, field, label) {
  const pages = readJson(ghApiPages(endpoint), label);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.[field]))) {
    throw new Error(`${label} did not return complete paginated results`);
  }
  return pages.flatMap((page) => page[field]);
}

function paginatedArrays(endpoint, label) {
  const pages = readJson(ghApiPages(endpoint), label);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} did not return complete paginated results`);
  }
  return pages.flat();
}

export function normalizeChecks(statusProtection) {
  const checks = Array.isArray(statusProtection?.checks)
    ? statusProtection.checks
    : Array.isArray(statusProtection?.contexts)
      ? statusProtection.contexts.map((context) => ({ app_id: -1, context }))
      : null;
  if (!checks) throw new Error("Required status-check protection is malformed");
  const normalized = checks.map((check) => {
    if (typeof check?.context !== "string" || !check.context) {
      throw new Error("Existing required check identity is malformed");
    }
    if (check.app_id === null || check.app_id === -1) {
      return { app_id: -1, context: check.context };
    }
    if (!Number.isSafeInteger(check.app_id) || check.app_id < 1) {
      throw new Error("Existing required check source is malformed");
    }
    return { app_id: check.app_id, context: check.context };
  });
  const identities = normalized.map(({ app_id: appId, context }) => `${context}\u0000${appId}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Existing required checks contain duplicates");
  }
  return normalized;
}

function sameChecks(left, right) {
  if (left.length !== right.length) return false;
  const identities = new Set(left.map(({ app_id: appId, context }) => `${context}\u0000${appId}`));
  return right.every(({ app_id: appId, context }) => identities.has(`${context}\u0000${appId}`));
}

function desiredChecks(githubActionsAppId) {
  return REQUIRED_GITHUB_ACTIONS_CHECKS.map((context) => ({
    app_id: githubActionsAppId,
    context,
  }));
}

function exactSelectedActions(value) {
  return (
    value?.github_owned_allowed === true &&
    value?.verified_allowed === false &&
    Array.isArray(value.patterns_allowed) &&
    value.patterns_allowed.length === 0
  );
}

function namedItemSet(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} is malformed`);
  const names = items.map((item) => {
    if (typeof item?.name !== "string" || !item.name) {
      throw new Error(`${label} contains a malformed name`);
    }
    return item.name;
  });
  if (new Set(names).size !== names.length) throw new Error(`${label} contains duplicates`);
  return new Set(names);
}

function exactProtectedSigningEnvironment(environment) {
  return (
    environment?.name === FIREFOX_SIGNING_ENVIRONMENT &&
    environment.deployment_branch_policy?.protected_branches === true &&
    environment.deployment_branch_policy?.custom_branch_policies === false
  );
}

export function inspectSigningSecretScope(state) {
  const repositorySecretNames = namedItemSet(state.repositorySecrets, "Repository secrets");
  const environmentSecretNames = namedItemSet(state.signingEnvironmentSecrets, "Signing environment secrets");
  const environmentProtected = exactProtectedSigningEnvironment(state.signingEnvironment);
  const environmentScopedSecretNames = REQUIRED_SIGNING_SECRET_NAMES.filter((name) =>
    environmentSecretNames.has(name),
  );
  const missingEnvironmentSecretNames = REQUIRED_SIGNING_SECRET_NAMES.filter(
    (name) => !environmentSecretNames.has(name),
  );
  const repositoryScopedSecretNames = REQUIRED_SIGNING_SECRET_NAMES.filter((name) =>
    repositorySecretNames.has(name),
  );
  return {
    environment: FIREFOX_SIGNING_ENVIRONMENT,
    environmentProtected,
    environmentScopedSecretNames,
    missingEnvironmentSecretNames,
    repositoryScopedSecretNames,
    safe:
      environmentProtected &&
      missingEnvironmentSecretNames.length === 0 &&
      repositoryScopedSecretNames.length === 0,
  };
}

function signingSecretScopeChange(state) {
  const scope = inspectSigningSecretScope(state);
  if (scope.safe) return null;
  return {
    action: "manual",
    ...scope,
    kind: "signing-secret-scope",
    migrationPlan: [
      `Restrict the ${FIREFOX_SIGNING_ENVIRONMENT} environment to protected branches.`,
      "Populate each missing environment secret from a separately held trusted credential source; GitHub does not expose existing secret values.",
      "Verify the signing job from protected main uses the environment-scoped credentials.",
      "Delete the same-named repository secrets only after the protected-environment signing check succeeds.",
    ],
    requiredSecretNames: REQUIRED_SIGNING_SECRET_NAMES,
  };
}

export function assertRepositoryChangesAutomatable(changes) {
  const manualChanges = changes.filter((change) => change.action === "manual");
  if (manualChanges.length > 0) {
    throw new Error(
      `Manual changes are required before repository settings can be applied: ${JSON.stringify(
        manualChanges.map(summarizeChange),
      )}`,
    );
  }
}

function summarizeChange(change) {
  const summary = {
    action: typeof change?.action === "string" ? change.action : "update",
    kind: typeof change?.kind === "string" ? change.kind : "malformed",
  };
  if (typeof change?.name === "string") summary.name = change.name;
  if (Array.isArray(change?.requiredSecretNames)) {
    summary.requiredSecretNames = change.requiredSecretNames.filter((name) => typeof name === "string");
  }
  return summary;
}

export function applyRepositoryChangesWithRecovery({
  applyPlannedChange,
  changes,
  planCurrentState,
  readCurrentState,
}) {
  if (
    !Array.isArray(changes) ||
    typeof applyPlannedChange !== "function" ||
    typeof planCurrentState !== "function" ||
    typeof readCurrentState !== "function"
  ) {
    throw new Error("Repository settings apply transaction is malformed");
  }
  assertRepositoryChangesAutomatable(changes);
  let appliedCount = 0;
  for (const change of changes) {
    try {
      applyPlannedChange(change);
      appliedCount += 1;
    } catch {
      let recovery;
      try {
        const remainingChanges = planCurrentState(readCurrentState());
        if (!Array.isArray(remainingChanges)) {
          throw new Error("Recovery plan is malformed");
        }
        recovery = {
          appliedCount,
          failedChange: summarizeChange(change),
          remainingChanges: remainingChanges.map(summarizeChange),
          stateRead: "complete",
        };
      } catch {
        recovery = {
          appliedCount,
          failedChange: summarizeChange(change),
          nextAction: "rerun the protected dry-run before any retry",
          stateRead: "failed",
        };
      }
      throw new Error(
        `Repository settings stopped after a partial apply; value-free recovery report: ${JSON.stringify(
          recovery,
        )}`,
      );
    }
  }
  try {
    return readCurrentState();
  } catch {
    throw new Error(
      `Repository settings applied ${appliedCount} change(s), but the full post-apply state could not be read; ` +
        "rerun the protected dry-run before any retry",
    );
  }
}

function emptyPullRequestBypass(value) {
  if (value == null) return true;
  return ["apps", "teams", "users"].every(
    (field) => Array.isArray(value[field]) && value[field].length === 0,
  );
}

function exactZeroApprovalPullRequestProtection(value) {
  return (
    value != null &&
    value.dismiss_stale_reviews === false &&
    value.require_code_owner_reviews === false &&
    value.required_approving_review_count === 0 &&
    value.require_last_push_approval === false &&
    emptyPullRequestBypass(value.bypass_pull_request_allowances)
  );
}

export function planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin) {
  const changes = [];
  const repositoryKeys = [
    ["allow_merge_commit", false],
    ["allow_rebase_merge", false],
    ["allow_squash_merge", true],
    ["delete_branch_on_merge", true],
  ];
  const repositorySettings = Object.fromEntries(repositoryKeys);
  if (repositoryKeys.some(([name, value]) => state.repository?.[name] !== value)) {
    changes.push({ kind: "repository", settings: repositorySettings });
  }

  if (
    state.actionsPermissions?.enabled !== true ||
    state.actionsPermissions?.allowed_actions !== "selected"
  ) {
    changes.push({ kind: "actions-permissions" });
  }
  if (!exactSelectedActions(state.selectedActions)) {
    changes.push({ kind: "selected-actions" });
  }
  if (
    state.workflowPermissions?.default_workflow_permissions !== "read" ||
    state.workflowPermissions?.can_approve_pull_request_reviews !== false
  ) {
    changes.push({ kind: "workflow-permissions" });
  }
  if (state.immutableReleases?.enabled !== true) {
    changes.push({ kind: "immutable-releases" });
  }
  const signingSecretChange = signingSecretScopeChange(state);
  if (signingSecretChange) changes.push(signingSecretChange);

  const variables = new Map(state.variables.map((variable) => [variable.name, variable.value]));
  if (variables.size !== state.variables.length) throw new Error("Repository variables contain duplicates");
  if (!variables.has("RELEASE_OPERATOR_LOGIN")) {
    changes.push({
      action: "create",
      kind: "variable",
      name: "RELEASE_OPERATOR_LOGIN",
      value: releaseOperatorLogin,
    });
  } else if (variables.get("RELEASE_OPERATOR_LOGIN") !== releaseOperatorLogin) {
    changes.push({
      action: "update",
      kind: "variable",
      name: "RELEASE_OPERATOR_LOGIN",
      value: releaseOperatorLogin,
    });
  }
  for (const name of OBSOLETE_VARIABLES) {
    if (variables.has(name)) changes.push({ action: "delete", kind: "variable", name });
  }

  const labelNames = new Set(state.labels.map((label) => label.name));
  if (labelNames.size !== state.labels.length) throw new Error("Repository labels contain duplicates");
  for (const name of OBSOLETE_LABELS) {
    if (labelNames.has(name)) changes.push({ action: "delete", kind: "label", name });
  }

  const checks = desiredChecks(githubActionsAppId);
  const currentChecks = normalizeChecks(state.statusProtection);
  if (state.statusProtection.strict !== true || !sameChecks(currentChecks, checks)) {
    changes.push({ checks, kind: "status-checks", strict: true });
  }
  if (
    state.branchProtection.required_conversation_resolution?.enabled !== true ||
    !exactZeroApprovalPullRequestProtection(state.branchProtection.required_pull_request_reviews)
  ) {
    changes.push({ kind: "pull-request-protection" });
  }
  if (state.branchProtection.enforce_admins?.enabled !== true) {
    changes.push({ kind: "admin-enforcement" });
  }
  return changes;
}

function enabledProtection(protection, name) {
  const enabled = protection?.[name]?.enabled;
  if (typeof enabled !== "boolean") throw new Error(`${name} branch protection is malformed`);
  return enabled;
}

function actorNames(value, field, label) {
  if (!Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value.map((actor) => {
    const name = actor?.[field];
    if (typeof name !== "string" || !name) throw new Error(`${label} actor identity is malformed`);
    return name;
  });
}

function actorRestrictions(value) {
  if (value == null) return null;
  return {
    apps: actorNames(value.apps, "slug", "Push restriction apps"),
    teams: actorNames(value.teams, "slug", "Push restriction teams"),
    users: actorNames(value.users, "login", "Push restriction users"),
  };
}

export function fullProtectionUpdate(protection) {
  const requiredStatusChecks =
    protection.required_status_checks === null
      ? null
      : {
          checks: normalizeChecks(protection.required_status_checks),
          strict: protection.required_status_checks.strict,
        };
  return {
    allow_deletions: enabledProtection(protection, "allow_deletions"),
    allow_force_pushes: enabledProtection(protection, "allow_force_pushes"),
    allow_fork_syncing: enabledProtection(protection, "allow_fork_syncing"),
    block_creations: enabledProtection(protection, "block_creations"),
    enforce_admins: enabledProtection(protection, "enforce_admins"),
    lock_branch: enabledProtection(protection, "lock_branch"),
    required_conversation_resolution: true,
    required_linear_history: enabledProtection(protection, "required_linear_history"),
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
      require_last_push_approval: false,
    },
    required_status_checks: requiredStatusChecks,
    restrictions: actorRestrictions(protection.restrictions),
  };
}

function readState(repository, endpoints) {
  const repositoryState = readJson(ghApi("GET", `repos/${repository}`), "Repository lookup");
  const actionsPermissions = readJson(
    ghApi("GET", `repos/${repository}/actions/permissions`),
    "Actions permissions",
  );
  const selectedActions =
    actionsPermissions.allowed_actions === "selected"
      ? readJson(
          ghApi("GET", `repos/${repository}/actions/permissions/selected-actions`),
          "Selected Actions permissions",
        )
      : null;
  const branchProtection = readJson(ghApi("GET", endpoints.protection), "Branch protection");
  const statusProtection =
    branchProtection.required_status_checks === null
      ? { checks: [], contexts: [], strict: false }
      : readJson(ghApi("GET", endpoints.status), "Required status checks");
  const environments = paginatedField(
    `repos/${repository}/environments?per_page=100`,
    "environments",
    "Repository environments",
  );
  const signingEnvironments = environments.filter(
    (environment) => environment?.name === FIREFOX_SIGNING_ENVIRONMENT,
  );
  if (signingEnvironments.length > 1) {
    throw new Error("Repository environments contain duplicate firefox-signing entries");
  }
  const signingEnvironment =
    signingEnvironments.length === 0
      ? null
      : readJson(
          ghApi("GET", `repos/${repository}/environments/${encodeURIComponent(FIREFOX_SIGNING_ENVIRONMENT)}`),
          "Signing environment",
        );
  return {
    actionsPermissions,
    branchProtection,
    immutableReleases: readJson(ghApi("GET", `repos/${repository}/immutable-releases`), "Immutable releases"),
    labels: paginatedArrays(`repos/${repository}/labels?per_page=100`, "Repository labels"),
    repository: repositoryState,
    repositorySecrets: paginatedField(
      `repos/${repository}/actions/secrets?per_page=100`,
      "secrets",
      "Repository secrets",
    ),
    selectedActions,
    signingEnvironment,
    signingEnvironmentSecrets:
      signingEnvironment === null
        ? []
        : paginatedField(
            `repos/${repository}/environments/${encodeURIComponent(
              FIREFOX_SIGNING_ENVIRONMENT,
            )}/secrets?per_page=100`,
            "secrets",
            "Signing environment secrets",
          ),
    statusProtection,
    variables: paginatedField(
      `repos/${repository}/actions/variables?per_page=100`,
      "variables",
      "Repository variables",
    ),
    workflowPermissions: readJson(
      ghApi("GET", `repos/${repository}/actions/permissions/workflow`),
      "Workflow permissions",
    ),
  };
}

export function applyRepositoryChange(
  change,
  repository,
  endpoints,
  { assertHeadCurrent, callGhApi = ghApi } = {},
) {
  if (typeof assertHeadCurrent !== "function") {
    throw new Error("Repository settings mutation requires an immediate protected-head check");
  }
  const supportedKinds = new Set([
    "actions-permissions",
    "admin-enforcement",
    "immutable-releases",
    "label",
    "pull-request-protection",
    "repository",
    "selected-actions",
    "status-checks",
    "variable",
    "workflow-permissions",
  ]);
  if (!supportedKinds.has(change?.kind)) {
    throw new Error(`Unsupported repository setting change: ${String(change?.kind)}`);
  }
  const protectionUpdate =
    change.kind === "pull-request-protection"
      ? fullProtectionUpdate(
          readJson(callGhApi("GET", endpoints.protection), "Branch protection before update"),
        )
      : null;

  assertHeadCurrent();
  if (change.kind === "repository") {
    callGhApi("PATCH", `repos/${repository}`, change.settings);
    return;
  }
  if (change.kind === "actions-permissions") {
    callGhApi("PUT", `repos/${repository}/actions/permissions`, {
      allowed_actions: "selected",
      enabled: true,
    });
    return;
  }
  if (change.kind === "selected-actions") {
    callGhApi("PUT", `repos/${repository}/actions/permissions/selected-actions`, {
      github_owned_allowed: true,
      patterns_allowed: [],
      verified_allowed: false,
    });
    return;
  }
  if (change.kind === "workflow-permissions") {
    callGhApi("PUT", `repos/${repository}/actions/permissions/workflow`, {
      can_approve_pull_request_reviews: false,
      default_workflow_permissions: "read",
    });
    return;
  }
  if (change.kind === "immutable-releases") {
    callGhApi("PUT", `repos/${repository}/immutable-releases`, {});
    return;
  }
  if (change.kind === "variable") {
    const endpoint = `repos/${repository}/actions/variables/${encodeURIComponent(change.name)}`;
    if (change.action === "delete") {
      callGhApi("DELETE", endpoint);
    } else if (change.action === "create") {
      callGhApi("POST", `repos/${repository}/actions/variables`, {
        name: change.name,
        value: change.value,
      });
    } else {
      callGhApi("PATCH", endpoint, {
        name: change.name,
        value: change.value,
      });
    }
    return;
  }
  if (change.kind === "label") {
    callGhApi("DELETE", `repos/${repository}/labels/${encodeURIComponent(change.name)}`);
    return;
  }
  if (change.kind === "status-checks") {
    callGhApi("PATCH", endpoints.status, {
      checks: change.checks,
      strict: change.strict,
    });
    return;
  }
  if (change.kind === "pull-request-protection") {
    callGhApi("PUT", endpoints.protection, protectionUpdate);
    return;
  }
  if (change.kind === "admin-enforcement") {
    callGhApi("POST", endpoints.admins);
    return;
  }
}

export function assertProtectedBootstrapHeadCurrent(
  context,
  { callGhApi = ghApi, canonicalize = realpathSync, runCommand = command } = {},
) {
  const localRoot = runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: context.checkoutRoot,
  });
  const localHead = runCommand("git", ["rev-parse", "HEAD"], {
    cwd: context.checkoutRoot,
  }).toLowerCase();
  const localBranch = runCommand("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: context.checkoutRoot,
  });
  const localStatus = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: context.checkoutRoot,
  });
  if (
    canonicalize(localRoot) !== context.checkoutRoot ||
    localHead !== context.sourceSha ||
    localBranch !== context.defaultBranch ||
    localStatus
  ) {
    throw new Error(
      "Repository settings checkout changed before apply; a clean exact protected-head checkout is required",
    );
  }

  const repositoryState = readJson(
    callGhApi("GET", `repos/${context.repository}`),
    "Repository identity recheck",
  );
  if (
    repositoryState?.id !== EXPECTED_REPOSITORY_ID ||
    repositoryState?.full_name !== EXPECTED_REPOSITORY ||
    repositoryState.archived !== false ||
    repositoryState.default_branch !== context.defaultBranch
  ) {
    throw new Error("Repository identity or default branch changed after bootstrap verification");
  }
  const branchState = readJson(
    callGhApi("GET", `repos/${context.repository}/branches/${encodeURIComponent(context.defaultBranch)}`),
    "Protected default-branch recheck",
  );
  if (
    branchState?.name !== context.defaultBranch ||
    branchState?.protected !== true ||
    String(branchState?.commit?.sha ?? "").toLowerCase() !== context.sourceSha
  ) {
    throw new Error("Protected default-branch head changed before repository settings apply");
  }
}

function isMainModule() {
  if (import.meta.url.startsWith("data:text/javascript;base64,")) return true;
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  try {
    const context = readBootstrapContext();
    activateCommandRuntime(context);
    sanitizeProcessEnvironment();
    const { apply, releaseOperatorLogin, repository } = context;

    const repositoryState = readJson(ghApi("GET", `repos/${repository}`), "Repository lookup");
    const branch = repositoryState.default_branch;
    if (
      repositoryState?.id !== EXPECTED_REPOSITORY_ID ||
      repositoryState?.full_name !== EXPECTED_REPOSITORY ||
      repositoryState.archived !== false ||
      branch !== context.defaultBranch
    ) {
      throw new Error("Repository identity or default branch no longer matches the bootstrap");
    }
    const encodedBranch = encodeURIComponent(branch);
    const endpoints = {
      admins: `repos/${repository}/branches/${encodedBranch}/protection/enforce_admins`,
      protection: `repos/${repository}/branches/${encodedBranch}/protection`,
      status: `repos/${repository}/branches/${encodedBranch}/protection/required_status_checks`,
    };
    const githubActionsApp = readJson(ghApi("GET", "apps/github-actions"), "GitHub Actions App lookup");
    if (
      githubActionsApp.slug !== "github-actions" ||
      !Number.isSafeInteger(githubActionsApp.id) ||
      githubActionsApp.id < 1
    ) {
      throw new Error("GitHub Actions App identity is missing or malformed");
    }

    let state = readState(repository, endpoints);
    const plannedChanges = planRepositorySettings(state, githubActionsApp.id, releaseOperatorLogin);
    if (apply) {
      assertRepositoryChangesAutomatable(plannedChanges);
      assertProtectedBootstrapHeadCurrent(context);
      state = applyRepositoryChangesWithRecovery({
        applyPlannedChange: (change) =>
          applyRepositoryChange(change, repository, endpoints, {
            assertHeadCurrent: () => assertProtectedBootstrapHeadCurrent(context),
          }),
        changes: plannedChanges,
        planCurrentState: (currentState) =>
          planRepositorySettings(currentState, githubActionsApp.id, releaseOperatorLogin),
        readCurrentState: () => readState(repository, endpoints),
      });
      const remainingChanges = planRepositorySettings(state, githubActionsApp.id, releaseOperatorLogin);
      if (remainingChanges.length > 0) {
        throw new Error(
          `Repository settings did not converge; value-free remaining plan: ${JSON.stringify(
            remainingChanges.map(summarizeChange),
          )}`,
        );
      }
    }

    console.log(
      JSON.stringify({
        applied: apply,
        branch,
        exact: apply || plannedChanges.length === 0,
        githubActionsAppId: githubActionsApp.id,
        plannedChanges,
        releaseOperatorLogin,
        repository,
        signingSecretScope: inspectSigningSecretScope(state),
        statusContexts: REQUIRED_GITHUB_ACTIONS_CHECKS,
      }),
    );
  } catch (error) {
    console.error(`Repository settings failed: ${error.message}`);
    process.exitCode = 1;
  }
}
