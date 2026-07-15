#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const STATUS_CONTEXT = "CHZZK review completion";
const GH_COMMAND = process.env.CHZZK_GH_COMMAND || "gh";
const GH_COMMAND_PREFIX = process.env.CHZZK_GH_COMMAND_PREFIX ? [process.env.CHZZK_GH_COMMAND_PREFIX] : [];
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const API_HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];
const DESIRED_LABELS = [
  {
    color: "b60205",
    description: "Force the exact-head automated security review gate",
    name: "security-review-required",
  },
  {
    color: "d93f0b",
    description: "Force the exact-head automated release review gate",
    name: "release-review-required",
  },
];

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

function readOptionalBooleanProtection(endpoint) {
  try {
    return readJson(ghApi("GET", endpoint), "Optional branch protection");
  } catch (error) {
    if (/\(HTTP 404\)\s*$/.test(error.message)) return { enabled: false };
    throw error;
  }
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

function normalizeChecks(statusProtection) {
  const checks = Array.isArray(statusProtection?.checks)
    ? statusProtection.checks
    : Array.isArray(statusProtection?.contexts)
      ? statusProtection.contexts.map((context) => ({ context }))
      : null;
  if (!checks) throw new Error("Required status-check protection is malformed");
  const normalized = checks.map((check) => {
    if (typeof check?.context !== "string" || !check.context) {
      throw new Error("Existing required check identity is malformed");
    }
    if (check.app_id === null || check.app_id === undefined) return { context: check.context };
    if (!Number.isSafeInteger(check.app_id) || check.app_id < 1) {
      throw new Error("Existing required check source is malformed");
    }
    return { app_id: check.app_id, context: check.context };
  });
  const keys = normalized.map(checkKey);
  if (new Set(keys).size !== keys.length) throw new Error("Existing required checks contain duplicates");
  return normalized;
}

function checkKey(check) {
  return `${check.context}\u0000${check.app_id ?? "any"}`;
}

function sameChecks(left, right) {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map(checkKey));
  return right.every((check) => leftKeys.has(checkKey(check)));
}

function expectedChecks(statusProtection, gateAppId) {
  return [
    ...normalizeChecks(statusProtection).filter((check) => check.context !== STATUS_CONTEXT),
    { app_id: gateAppId, context: STATUS_CONTEXT },
  ];
}

function readManagedState(repository, statusEndpoint, conversationsEndpoint, adminsEndpoint) {
  const variables = paginatedField(
    `repos/${repository}/actions/variables?per_page=100`,
    "variables",
    "Repository variable listing",
  );
  const labels = paginatedArrays(`repos/${repository}/labels?per_page=100`, "Repository label listing");
  for (const variable of variables) {
    if (typeof variable?.name !== "string" || typeof variable.value !== "string") {
      throw new Error("Repository variable identity or value is malformed");
    }
  }
  for (const label of labels) {
    if (
      typeof label?.name !== "string" ||
      typeof label.color !== "string" ||
      (label.description !== null && typeof label.description !== "string")
    ) {
      throw new Error("Repository label state is malformed");
    }
  }
  return {
    adminProtection: readJson(ghApi("GET", adminsEndpoint), "Administrator enforcement protection"),
    conversationProtection: readOptionalBooleanProtection(conversationsEndpoint),
    labels,
    statusProtection: readJson(ghApi("GET", statusEndpoint), "Required status-check protection"),
    variables,
  };
}

function planChanges(state, desiredVariables, gateAppId) {
  const changes = [];
  const variables = new Map(state.variables.map((variable) => [variable.name, variable.value]));
  if (variables.size !== state.variables.length) throw new Error("Repository variables contain duplicates");
  for (const [name, value] of desiredVariables) {
    if (!variables.has(name)) changes.push({ action: "create", kind: "variable", name, value });
    else if (variables.get(name) !== value) changes.push({ action: "update", kind: "variable", name, value });
  }

  const labels = new Map(state.labels.map((label) => [label.name, label]));
  if (labels.size !== state.labels.length) throw new Error("Repository labels contain duplicates");
  for (const desired of DESIRED_LABELS) {
    const existing = labels.get(desired.name);
    if (!existing) changes.push({ action: "create", kind: "label", ...desired });
    else if (
      existing.color.toLowerCase() !== desired.color ||
      (existing.description ?? "") !== desired.description
    ) {
      changes.push({ action: "update", kind: "label", ...desired });
    }
  }

  const currentChecks = normalizeChecks(state.statusProtection);
  const checks = expectedChecks(state.statusProtection, gateAppId);
  if (state.statusProtection.strict !== true || !sameChecks(currentChecks, checks)) {
    changes.push({ action: "update", checks, kind: "status-checks", strict: true });
  }
  if (state.conversationProtection.enabled !== true) {
    changes.push({ action: "enable", kind: "conversation-resolution" });
  }
  if (state.adminProtection.enabled !== true) {
    changes.push({ action: "enable", kind: "admin-enforcement" });
  }
  return changes;
}

function applyChange(change, repository, statusEndpoint, conversationsEndpoint, adminsEndpoint) {
  if (change.kind === "variable") {
    if (change.action === "create") {
      ghApi("POST", `repos/${repository}/actions/variables`, {
        name: change.name,
        value: change.value,
      });
    } else {
      ghApi("PATCH", `repos/${repository}/actions/variables/${encodeURIComponent(change.name)}`, {
        name: change.name,
        value: change.value,
      });
    }
    return;
  }
  if (change.kind === "label") {
    const body = {
      color: change.color,
      description: change.description,
    };
    if (change.action === "create") {
      ghApi("POST", `repos/${repository}/labels`, { ...body, name: change.name });
    } else {
      ghApi("PATCH", `repos/${repository}/labels/${encodeURIComponent(change.name)}`, {
        ...body,
        new_name: change.name,
      });
    }
    return;
  }
  if (change.kind === "status-checks") {
    ghApi("PATCH", statusEndpoint, { checks: change.checks, strict: change.strict });
    return;
  }
  if (change.kind === "conversation-resolution") {
    ghApi("PUT", conversationsEndpoint, {});
    return;
  }
  if (change.kind === "admin-enforcement") {
    ghApi("POST", adminsEndpoint);
    return;
  }
  throw new Error(`Unsupported configuration change: ${String(change.kind)}`);
}

try {
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("Repository review-gate settings must be managed out of band, never in GitHub Actions");
  }
  if (process.argv.slice(2).some((argument) => argument !== "--apply") || process.argv.slice(2).length > 1) {
    throw new Error("Usage: node scripts/configure-review-gate.js [--apply]");
  }
  const apply = process.argv.includes("--apply");
  const repository = requiredString("CHZZK_GITHUB_REPOSITORY");
  const automatedReviewLogin = requiredLogin("CHZZK_AUTOMATED_REVIEW_LOGIN");
  const releaseOperatorLogin = requiredLogin("CHZZK_RELEASE_OPERATOR_LOGIN");
  if (!REPOSITORY_RE.test(repository)) {
    throw new Error("CHZZK_GITHUB_REPOSITORY must use owner/repository form");
  }

  const repositoryState = readJson(ghApi("GET", `repos/${repository}`), "Repository lookup");
  const branch = repositoryState.default_branch;
  if (typeof branch !== "string" || !branch) throw new Error("Repository default branch is missing");
  const encodedBranch = encodeURIComponent(branch);
  const statusEndpoint = `repos/${repository}/branches/${encodedBranch}/protection/required_status_checks`;
  const conversationsEndpoint = `repos/${repository}/branches/${encodedBranch}/protection/required_conversation_resolution`;
  const adminsEndpoint = `repos/${repository}/branches/${encodedBranch}/protection/enforce_admins`;
  const githubActionsApp = readJson(ghApi("GET", "apps/github-actions"), "GitHub Actions App lookup");
  if (
    githubActionsApp.slug !== "github-actions" ||
    !Number.isSafeInteger(githubActionsApp.id) ||
    githubActionsApp.id < 1
  ) {
    throw new Error("GitHub Actions App identity is missing or malformed");
  }
  const gateAppId = githubActionsApp.id;
  const desiredVariables = [
    ["AUTOMATED_REVIEW_LOGIN", automatedReviewLogin],
    ["RELEASE_OPERATOR_LOGIN", releaseOperatorLogin],
  ];
  let state = readManagedState(repository, statusEndpoint, conversationsEndpoint, adminsEndpoint);
  const plannedChanges = planChanges(state, desiredVariables, gateAppId);

  if (apply) {
    for (const change of plannedChanges) {
      applyChange(change, repository, statusEndpoint, conversationsEndpoint, adminsEndpoint);
    }
    state = readManagedState(repository, statusEndpoint, conversationsEndpoint, adminsEndpoint);
    const remainingChanges = planChanges(state, desiredVariables, gateAppId);
    if (remainingChanges.length > 0) {
      throw new Error(`Review gate settings did not converge: ${JSON.stringify(remainingChanges)}`);
    }
  }

  console.log(
    JSON.stringify({
      applied: apply,
      automatedReviewLogin,
      branch,
      exact: apply || plannedChanges.length === 0,
      gateAppId,
      plannedChanges,
      releaseOperatorLogin,
      repository,
      statusContext: STATUS_CONTEXT,
    }),
  );
} catch (error) {
  console.error(`Review gate settings failed: ${error.message}`);
  process.exitCode = 1;
}
