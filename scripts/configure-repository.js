#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REQUIRED_GITHUB_ACTIONS_CHECKS = [
  "analyze",
  "dependency-review",
  "exact-head-review",
  "firefox-e2e",
  "verify",
];

const OBSOLETE_LABELS = ["release-review-required", "security-review-required"];
const OBSOLETE_VARIABLES = ["AUTOMATED_REVIEW_LOGIN"];
const GH_COMMAND = process.env.CHZZK_GH_COMMAND || "gh";
const GH_COMMAND_PREFIX = process.env.CHZZK_GH_COMMAND_PREFIX ? [process.env.CHZZK_GH_COMMAND_PREFIX] : [];
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const API_HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];

function command(commandName, args, { input } = {}) {
  const result = spawnSync(commandName, args, {
    encoding: "utf8",
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${commandName} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function ghApi(method, endpoint, body = null) {
  const args = ["api", "--method", method, ...API_HEADERS];
  if (body !== null) args.push("--input", "-");
  args.push(endpoint);
  return command(GH_COMMAND, [...GH_COMMAND_PREFIX, ...args], {
    input: body === null ? undefined : `${JSON.stringify(body)}\n`,
  });
}

function ghApiPages(endpoint) {
  return command(GH_COMMAND, [
    ...GH_COMMAND_PREFIX,
    "api",
    "--method",
    "GET",
    ...API_HEADERS,
    "--paginate",
    "--slurp",
    endpoint,
  ]);
}

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function requiredString(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredLogin(name) {
  const value = requiredString(name);
  if (!GITHUB_LOGIN_RE.test(value)) throw new Error(`${name} must be an exact GitHub login`);
  return value;
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
    state.branchProtection.allow_deletions?.enabled !== false ||
    state.branchProtection.allow_force_pushes?.enabled !== false ||
    state.branchProtection.required_conversation_resolution?.enabled !== true ||
    state.branchProtection.required_pull_request_reviews != null
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

function fullProtectionUpdate(protection) {
  const requiredStatusChecks =
    protection.required_status_checks === null
      ? null
      : {
          checks: normalizeChecks(protection.required_status_checks),
          strict: protection.required_status_checks.strict,
        };
  return {
    allow_deletions: false,
    allow_force_pushes: false,
    allow_fork_syncing: enabledProtection(protection, "allow_fork_syncing"),
    block_creations: enabledProtection(protection, "block_creations"),
    enforce_admins: enabledProtection(protection, "enforce_admins"),
    lock_branch: enabledProtection(protection, "lock_branch"),
    required_conversation_resolution: true,
    required_linear_history: enabledProtection(protection, "required_linear_history"),
    required_pull_request_reviews: null,
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
  return {
    actionsPermissions,
    branchProtection,
    immutableReleases: readJson(ghApi("GET", `repos/${repository}/immutable-releases`), "Immutable releases"),
    labels: paginatedArrays(`repos/${repository}/labels?per_page=100`, "Repository labels"),
    repository: repositoryState,
    selectedActions,
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

function applyChange(change, repository, endpoints) {
  if (change.kind === "repository") {
    ghApi("PATCH", `repos/${repository}`, change.settings);
    return;
  }
  if (change.kind === "actions-permissions") {
    ghApi("PUT", `repos/${repository}/actions/permissions`, {
      allowed_actions: "selected",
      enabled: true,
    });
    return;
  }
  if (change.kind === "selected-actions") {
    ghApi("PUT", `repos/${repository}/actions/permissions/selected-actions`, {
      github_owned_allowed: true,
      patterns_allowed: [],
      verified_allowed: false,
    });
    return;
  }
  if (change.kind === "workflow-permissions") {
    ghApi("PUT", `repos/${repository}/actions/permissions/workflow`, {
      can_approve_pull_request_reviews: false,
      default_workflow_permissions: "read",
    });
    return;
  }
  if (change.kind === "immutable-releases") {
    ghApi("PUT", `repos/${repository}/immutable-releases`, {});
    return;
  }
  if (change.kind === "variable") {
    const endpoint = `repos/${repository}/actions/variables/${encodeURIComponent(change.name)}`;
    if (change.action === "delete") {
      ghApi("DELETE", endpoint);
    } else if (change.action === "create") {
      ghApi("POST", `repos/${repository}/actions/variables`, {
        name: change.name,
        value: change.value,
      });
    } else {
      ghApi("PATCH", endpoint, {
        name: change.name,
        value: change.value,
      });
    }
    return;
  }
  if (change.kind === "label") {
    ghApi("DELETE", `repos/${repository}/labels/${encodeURIComponent(change.name)}`);
    return;
  }
  if (change.kind === "status-checks") {
    ghApi("PATCH", endpoints.status, {
      checks: change.checks,
      strict: change.strict,
    });
    return;
  }
  if (change.kind === "pull-request-protection") {
    const protection = readJson(ghApi("GET", endpoints.protection), "Branch protection before update");
    ghApi("PUT", endpoints.protection, fullProtectionUpdate(protection));
    return;
  }
  if (change.kind === "admin-enforcement") {
    ghApi("POST", endpoints.admins);
    return;
  }
  throw new Error(`Unsupported repository setting change: ${String(change.kind)}`);
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  try {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error("Repository settings must be managed out of band, never in GitHub Actions");
    }
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== "--apply") || args.length > 1) {
      throw new Error("Usage: node scripts/configure-repository.js [--apply]");
    }
    const apply = args.includes("--apply");
    const repository = requiredString("CHZZK_GITHUB_REPOSITORY");
    const releaseOperatorLogin = requiredLogin("CHZZK_RELEASE_OPERATOR_LOGIN");
    if (!REPOSITORY_RE.test(repository)) {
      throw new Error("CHZZK_GITHUB_REPOSITORY must use owner/repository form");
    }

    const repositoryState = readJson(ghApi("GET", `repos/${repository}`), "Repository lookup");
    const branch = repositoryState.default_branch;
    if (typeof branch !== "string" || !branch) throw new Error("Repository default branch is missing");
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
      for (const change of plannedChanges) applyChange(change, repository, endpoints);
      state = readState(repository, endpoints);
      const remainingChanges = planRepositorySettings(state, githubActionsApp.id, releaseOperatorLogin);
      if (remainingChanges.length > 0) {
        throw new Error(`Repository settings did not converge: ${JSON.stringify(remainingChanges)}`);
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
        statusContexts: REQUIRED_GITHUB_ACTIONS_CHECKS,
      }),
    );
  } catch (error) {
    console.error(`Repository settings failed: ${error.message}`);
    process.exitCode = 1;
  }
}
