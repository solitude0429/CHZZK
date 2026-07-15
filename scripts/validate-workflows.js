#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = resolve(rootDir, ".github/workflows");
const PINNED_ACTION_RE = /^[^\s@]+@[a-f0-9]{40}$/i;
const HIGH_RISK_WRITE_PERMISSIONS = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "statuses",
]);
const PROJECT_EXECUTION_RE =
  /(?:^|[;&|\n]\s*)(?:npm\s+(?:ci|install|run)|npx\b|pnpm\b|yarn\b|node\s+scripts\/)/i;
const SECRET_EXPRESSION_RE = /\$\{\{\s*secrets\./i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function permissionWrites(permissions, name) {
  return permissions?.[name] === "write";
}

function highRiskWritePermissions(permissions) {
  return Object.entries(permissions ?? {})
    .filter(([name, level]) => level === "write" && HIGH_RISK_WRITE_PERMISSIONS.has(name))
    .map(([name]) => name);
}

function validatePermissions(permissions, location, errors) {
  if (!isObject(permissions) || Object.keys(permissions).length === 0) {
    errors.push(`${location} must declare explicit permissions`);
    return;
  }
  for (const [name, level] of Object.entries(permissions)) {
    if (!new Set(["none", "read", "write"]).has(level)) {
      errors.push(`${location}.${name} has invalid permission level ${String(level)}`);
    }
  }
}

function validateAction(step, location, errors) {
  if (typeof step.uses !== "string") return;
  if (!step.uses.startsWith("./") && !PINNED_ACTION_RE.test(step.uses)) {
    errors.push(`${location} action must be pinned to a full commit SHA: ${step.uses}`);
  }
  if (step.uses.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false) {
    errors.push(`${location} checkout must set persist-credentials: false`);
  }
}

export function validateWorkflowDocument(workflow, source = "workflow") {
  const errors = [];
  if (!isObject(workflow)) throw new Error(`${source}: workflow root must be an object`);
  if (!workflow.concurrency || !workflow.concurrency.group) {
    errors.push("workflow must declare concurrency with a stable group");
  }
  validatePermissions(workflow.permissions, "workflow permissions", errors);
  if (isObject(workflow.permissions)) {
    for (const [name, level] of Object.entries(workflow.permissions)) {
      if (level === "write") errors.push(`top-level workflow permission ${name}: write is forbidden`);
    }
  }
  if (!isObject(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
    errors.push("workflow must declare at least one job");
  }

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const location = `job ${jobName}`;
    if (!isObject(job)) {
      errors.push(`${location} must be an object`);
      continue;
    }
    validatePermissions(job.permissions, `${location} permissions`, errors);
    if (!Number.isFinite(job["timeout-minutes"]) || job["timeout-minutes"] <= 0) {
      errors.push(`${location} must declare a positive timeout-minutes`);
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      errors.push(`${location} must declare steps`);
      continue;
    }

    const serializedJob = JSON.stringify(job);
    const usesSecrets = SECRET_EXPRESSION_RE.test(serializedJob);
    const highRiskWrites = highRiskWritePermissions(job.permissions);
    if (usesSecrets && highRiskWrites.length > 0) {
      errors.push(
        `${location} cannot combine secrets with high-risk write privilege: ${highRiskWrites.join(", ")}`,
      );
    }
    if (usesSecrets && SECRET_EXPRESSION_RE.test(JSON.stringify(job.env ?? {}))) {
      errors.push(`${location} secrets must be scoped to the single signing step, not job env`);
    }

    job.steps.forEach((step, index) => {
      const stepLocation = `${location} step ${index + 1}`;
      if (!isObject(step)) {
        errors.push(`${stepLocation} must be an object`);
        return;
      }
      validateAction(step, stepLocation, errors);
      const run = typeof step.run === "string" ? step.run : "";
      if (highRiskWrites.length > 0 && PROJECT_EXECUTION_RE.test(run)) {
        errors.push(
          `${stepLocation} cannot run package installation or project scripts in a privileged write job`,
        );
      }
      if (usesSecrets && step.uses?.startsWith("actions/checkout@")) {
        errors.push(`${stepLocation} secret-bearing jobs must consume verified artifacts without checkout`);
      }
      if (usesSecrets && /(?:npm\s+(?:ci|install|run)|npx\b|pnpm\b|yarn\b)/i.test(run)) {
        errors.push(`${stepLocation} secret-bearing jobs cannot install packages or run project builds`);
      }
    });

    if (
      permissionWrites(job.permissions, "contents") &&
      job.steps.some((step) => step.uses?.startsWith("actions/checkout@"))
    ) {
      errors.push(
        `${location} contents: write jobs must publish downloaded verified artifacts without checkout`,
      );
    }
  }

  if (errors.length > 0) throw new Error(`${source}: ${errors.join("; ")}`);
  return true;
}

export function validateWorkflowFile(path) {
  const document = parseDocument(readFileSync(path, "utf8"), { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${path}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return validateWorkflowDocument(document.toJS(), path);
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const workflowPaths = readdirSync(workflowsDir)
      .filter((name) => new Set([".yaml", ".yml"]).has(extname(name)))
      .sort()
      .map((name) => resolve(workflowsDir, name));
    for (const path of workflowPaths) validateWorkflowFile(path);
    console.log(`Validated ${workflowPaths.length} workflow files semantically.`);
  } catch (error) {
    console.error(`Workflow validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
