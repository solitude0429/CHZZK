#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const STATUS_CONTEXT = "CHZZK review completion";
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function command(commandName, args, { input, inherit = false } = {}) {
  const result = spawnSync(commandName, args, {
    encoding: inherit ? undefined : "utf8",
    input,
    stdio: inherit ? "inherit" : undefined,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = inherit ? "command failed" : (result.stderr || result.stdout || "").trim();
    throw new Error(`${commandName} ${args.join(" ")} failed: ${detail}`);
  }
  return inherit ? "" : result.stdout.trim();
}

function ghApi(method, endpoint, body = null) {
  const args = [
    "api",
    "--method",
    method,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
  ];
  if (body !== null) args.push("--input", "-");
  args.push(endpoint);
  return command("gh", args, { input: body === null ? undefined : `${JSON.stringify(body)}\n` });
}

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function actorRestrictions(value) {
  if (!value) return undefined;
  const result = {
    apps: (value.apps ?? []).map((app) => app.slug),
    teams: (value.teams ?? []).map((team) => team.slug),
    users: (value.users ?? []).map((user) => user.login),
  };
  if (Object.values(result).some((entries) => entries.some((entry) => typeof entry !== "string"))) {
    throw new Error("Existing branch review restrictions are malformed");
  }
  return result;
}

function requiredString(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
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
  const reviewAppSlug = requiredString("CHZZK_REVIEW_APP_SLUG");
  const reviewCheckName = requiredString("CHZZK_REVIEW_CHECK_NAME");
  const releaseOperatorLogin = requiredString("CHZZK_RELEASE_OPERATOR_LOGIN");
  if (reviewAppSlug === "github-actions" && reviewCheckName === STATUS_CONTEXT) {
    throw new Error("The automated reviewer must not be configured as the review gate's own check");
  }
  if (!REPOSITORY_RE.test(repository))
    throw new Error("CHZZK_GITHUB_REPOSITORY must use owner/repository form");

  const repositoryState = readJson(ghApi("GET", `repos/${repository}`), "Repository lookup");
  const branch = repositoryState.default_branch;
  if (typeof branch !== "string" || !branch) throw new Error("Repository default branch is missing");
  const encodedBranch = encodeURIComponent(branch);
  const statusEndpoint = `repos/${repository}/branches/${encodedBranch}/protection/required_status_checks`;
  const reviewsEndpoint = `repos/${repository}/branches/${encodedBranch}/protection/required_pull_request_reviews`;
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

  if (apply) {
    for (const [name, value] of [
      ["AUTOMATED_REVIEW_APP_SLUG", reviewAppSlug],
      ["AUTOMATED_REVIEW_CHECK_NAME", reviewCheckName],
      ["RELEASE_OPERATOR_LOGIN", releaseOperatorLogin],
    ]) {
      command("gh", ["variable", "set", name, "--repo", repository, "--body", value]);
    }
    for (const [name, description, color] of [
      ["security-review-required", "Force the exact-head automated security review gate", "B60205"],
      ["release-review-required", "Force the exact-head automated release review gate", "D93F0B"],
    ]) {
      command("gh", [
        "label",
        "create",
        name,
        "--repo",
        repository,
        "--description",
        description,
        "--color",
        color,
        "--force",
      ]);
    }
  }

  let statusProtection = readJson(ghApi("GET", statusEndpoint), "Required status-check protection");
  const existingChecks = Array.isArray(statusProtection.checks)
    ? statusProtection.checks.map((check) => {
        if (typeof check?.context !== "string" || !check.context) {
          throw new Error("Existing required check identity is malformed");
        }
        return Number.isSafeInteger(check.app_id)
          ? { app_id: check.app_id, context: check.context }
          : { context: check.context };
      })
    : (statusProtection.contexts ?? []).map((context) => ({ context }));
  if (apply) {
    ghApi("PATCH", statusEndpoint, {
      checks: [
        ...existingChecks.filter((check) => check.context !== STATUS_CONTEXT),
        { app_id: gateAppId, context: STATUS_CONTEXT },
      ],
      strict: true,
    });
    statusProtection = readJson(ghApi("GET", statusEndpoint), "Required status-check protection");
  }
  const configuredGateCheck = (statusProtection.checks ?? []).find(
    (check) => check?.context === STATUS_CONTEXT,
  );
  if (statusProtection.strict !== true || configuredGateCheck?.app_id !== gateAppId) {
    throw new Error(
      `Default branch must strictly require the ${STATUS_CONTEXT} check from the GitHub Actions App`,
    );
  }

  let reviewProtection = readJson(ghApi("GET", reviewsEndpoint), "Pull request review protection");
  if (apply) {
    const reviewBody = {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: reviewProtection.require_code_owner_reviews === true,
      require_last_push_approval: true,
      required_approving_review_count: Math.max(
        1,
        Number(reviewProtection.required_approving_review_count ?? 0),
      ),
      bypass_pull_request_allowances: { apps: [], teams: [], users: [] },
    };
    const dismissalRestrictions = actorRestrictions(reviewProtection.dismissal_restrictions);
    if (dismissalRestrictions) reviewBody.dismissal_restrictions = dismissalRestrictions;
    ghApi("PATCH", reviewsEndpoint, reviewBody);
    ghApi("PUT", conversationsEndpoint, {});
    ghApi("POST", adminsEndpoint);
    reviewProtection = readJson(ghApi("GET", reviewsEndpoint), "Pull request review protection");
  }
  const bypassAllowances = actorRestrictions(reviewProtection.bypass_pull_request_allowances) ?? {
    apps: [],
    teams: [],
    users: [],
  };
  if (
    reviewProtection.dismiss_stale_reviews !== true ||
    reviewProtection.require_last_push_approval !== true ||
    !Number.isSafeInteger(reviewProtection.required_approving_review_count) ||
    reviewProtection.required_approving_review_count < 1 ||
    Object.values(bypassAllowances).some((actors) => actors.length > 0)
  ) {
    throw new Error(
      "Default branch must require a non-bypassable approval after the last push and dismiss stale reviews",
    );
  }
  const conversationProtection = readJson(
    ghApi("GET", conversationsEndpoint),
    "Required conversation-resolution protection",
  );
  if (conversationProtection.enabled !== true) {
    throw new Error("Default branch must require all review conversations to be resolved");
  }
  const adminProtection = readJson(ghApi("GET", adminsEndpoint), "Administrator enforcement protection");
  if (adminProtection.enabled !== true) {
    throw new Error("Default branch protections must apply to administrators");
  }

  for (const [name, expected] of [
    ["AUTOMATED_REVIEW_APP_SLUG", reviewAppSlug],
    ["AUTOMATED_REVIEW_CHECK_NAME", reviewCheckName],
    ["RELEASE_OPERATOR_LOGIN", releaseOperatorLogin],
  ]) {
    const variable = readJson(
      ghApi("GET", `repos/${repository}/actions/variables/${name}`),
      `Repository variable ${name}`,
    );
    if (variable.value !== expected) throw new Error(`Repository variable ${name} is not configured exactly`);
  }

  console.log(
    JSON.stringify({
      applied: apply,
      branch,
      gateAppId,
      releaseOperatorLogin,
      repository,
      reviewAppSlug,
      reviewCheckName,
      statusContext: STATUS_CONTEXT,
    }),
  );
} catch (error) {
  console.error(`Review gate settings failed: ${error.message}`);
  process.exitCode = 1;
}
