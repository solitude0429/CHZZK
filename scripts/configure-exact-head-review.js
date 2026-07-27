#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const GH_COMMAND = process.env.CHZZK_GH_COMMAND || "gh";
const GH_COMMAND_PREFIX = process.env.CHZZK_GH_COMMAND_PREFIX
  ? [process.env.CHZZK_GH_COMMAND_PREFIX]
  : [];
const API_HEADERS = [
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2022-11-28",
];
const REQUIRED_CONTEXT = "exact-head-review";

function command(args, { input } = {}) {
  const result = spawnSync(GH_COMMAND, [...GH_COMMAND_PREFIX, ...args], {
    encoding: "utf8",
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${GH_COMMAND} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function ghApi(method, endpoint, body = null) {
  const args = ["api", "--method", method, ...API_HEADERS];
  if (body !== null) args.push("--input", "-");
  args.push(endpoint);
  return command(args, {
    input: body === null ? undefined : `${JSON.stringify(body)}\n`,
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function requiredRepository() {
  const repository = process.env.CHZZK_GITHUB_REPOSITORY;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("CHZZK_GITHUB_REPOSITORY must be owner/name");
  }
  return repository;
}

function normalizedChecks(value) {
  const checks = Array.isArray(value?.checks)
    ? value.checks
    : Array.isArray(value?.contexts)
      ? value.contexts.map((context) => ({ app_id: -1, context }))
      : null;
  if (!checks) throw new Error("Required status checks are malformed");
  return checks.map((check) => {
    if (typeof check?.context !== "string" || !check.context) {
      throw new Error("Required status check context is malformed");
    }
    const appId = check.app_id == null ? -1 : check.app_id;
    if (!Number.isSafeInteger(appId) || appId < -1 || appId === 0) {
      throw new Error("Required status check app identity is malformed");
    }
    return { app_id: appId, context: check.context };
  });
}

export function planExactHeadReviewCheck(statusProtection) {
  const checks = normalizedChecks(statusProtection);
  const existing = checks.find((check) => check.context === REQUIRED_CONTEXT);
  if (existing) return { changed: false, checks, strict: statusProtection.strict === true };

  const source = checks.find(
    (check) => check.context === "verify" && Number.isSafeInteger(check.app_id) && check.app_id > 0,
  );
  if (!source) {
    throw new Error("Cannot bind exact-head-review to the GitHub Actions app without the verify check");
  }
  return {
    changed: true,
    checks: [...checks, { app_id: source.app_id, context: REQUIRED_CONTEXT }].sort((left, right) =>
      left.context.localeCompare(right.context, "en"),
    ),
    strict: true,
  };
}

function main() {
  const apply = process.argv.slice(2).includes("--apply");
  const repository = requiredRepository();
  const repositoryState = parseJson(ghApi("GET", `repos/${repository}`), "Repository lookup");
  const branch = repositoryState.default_branch;
  if (typeof branch !== "string" || !branch) throw new Error("Repository default branch is invalid");

  const endpoint = `repos/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`;
  const statusProtection = parseJson(ghApi("GET", endpoint), "Required status checks");
  const plan = planExactHeadReviewCheck(statusProtection);
  console.log(JSON.stringify({ apply, branch, repository, ...plan }, null, 2));
  if (!apply || !plan.changed) return;
  ghApi("PATCH", endpoint, { checks: plan.checks, strict: plan.strict });
}

if (process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`Exact-head review protection configuration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
