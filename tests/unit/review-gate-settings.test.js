import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const reviewerLogin = "chatgpt-codex-connector[bot]";
const operatorLogin = "sole-owner";
const githubActionsAppId = 15368;

function fakeGhSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const endpoint = args[args.length - 1];
const input = fs.readFileSync(0, "utf8").trim();
const body = input ? JSON.parse(input) : null;
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
state.log.push({ body, endpoint, method });
function save() { fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state)); }
function output(value) { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); }
function fail() { save(); process.stderr.write("unexpected fake gh request: " + method + " " + endpoint); process.exit(1); }

if (method === "GET" && endpoint === "repos/example/repository") output({ default_branch: "main" });
if (method === "GET" && endpoint === "apps/github-actions") {
  output({ id: state.githubActionsAppId, slug: "github-actions" });
}
if (method === "GET" && endpoint === "repos/example/repository/actions/variables?per_page=100") {
  output([{ total_count: state.variables.length, variables: state.variables }]);
}
if (method === "GET" && endpoint === "repos/example/repository/labels?per_page=100") {
  output([state.labels]);
}
if (method === "GET" && endpoint.endsWith("/required_status_checks")) output(state.statusProtection);
if (method === "GET" && endpoint.endsWith("/required_conversation_resolution")) {
  output({ enabled: state.conversationResolution });
}
if (method === "GET" && endpoint.endsWith("/enforce_admins")) {
  output({ enabled: state.adminEnforcement });
}

if (method === "POST" && endpoint === "repos/example/repository/actions/variables") {
  state.variables.push({ name: body.name, value: body.value });
  output({});
}
if (method === "PATCH" && endpoint.startsWith("repos/example/repository/actions/variables/")) {
  const name = decodeURIComponent(endpoint.split("/").at(-1));
  const variable = state.variables.find((entry) => entry.name === name);
  if (!variable) fail();
  variable.name = body.name;
  variable.value = body.value;
  output({});
}
if (method === "POST" && endpoint === "repos/example/repository/labels") {
  state.labels.push({ color: body.color, description: body.description, name: body.name });
  output({});
}
if (method === "PATCH" && endpoint.startsWith("repos/example/repository/labels/")) {
  const name = decodeURIComponent(endpoint.split("/").at(-1));
  const label = state.labels.find((entry) => entry.name === name);
  if (!label) fail();
  label.color = body.color;
  label.description = body.description;
  label.name = body.new_name;
  output({});
}
if (method === "PATCH" && endpoint.endsWith("/required_status_checks")) {
  state.statusProtection = body;
  output({});
}
if (method === "PUT" && endpoint.endsWith("/required_conversation_resolution")) {
  state.conversationResolution = true;
  output({});
}
if (method === "POST" && endpoint.endsWith("/enforce_admins")) {
  state.adminEnforcement = true;
  output({});
}
fail();
`;
}

function runConfigure(directory, statePath, args = []) {
  return spawnSync(process.execPath, ["scripts/configure-review-gate.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CHZZK_AUTOMATED_REVIEW_LOGIN: reviewerLogin,
      CHZZK_GH_COMMAND: process.execPath,
      CHZZK_GH_COMMAND_PREFIX: join(directory, "gh"),
      CHZZK_GITHUB_REPOSITORY: "example/repository",
      CHZZK_RELEASE_OPERATOR_LOGIN: operatorLogin,
      FAKE_GH_STATE: statePath,
      GITHUB_ACTIONS: "false",
      PATH: `${directory}:${process.env.PATH}`,
    },
  });
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function mutationCount(state) {
  return state.log.filter((entry) => entry.method !== "GET").length;
}

describe("sole-owner review-gate repository configuration", () => {
  it("plans without mutation, applies exactly, preserves checks, and is idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "chzzk-review-gate-settings-"));
    const statePath = join(directory, "state.json");
    const ghPath = join(directory, "gh");
    writeFileSync(ghPath, fakeGhSource());
    chmodSync(ghPath, 0o755);
    writeFileSync(
      statePath,
      JSON.stringify({
        adminEnforcement: false,
        conversationResolution: false,
        githubActionsAppId,
        labels: [
          {
            color: "ffffff",
            description: "stale description",
            name: "security-review-required",
          },
          { color: "ededed", description: "preserved", name: "unrelated" },
        ],
        log: [],
        statusProtection: {
          checks: [{ app_id: 7, context: "Existing CI" }],
          strict: false,
        },
        variables: [
          { name: "RELEASE_OPERATOR_LOGIN", value: "old-owner" },
          { name: "UNRELATED", value: "preserved" },
        ],
      }),
    );

    try {
      const dryRun = runConfigure(directory, statePath);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      const dryResult = JSON.parse(dryRun.stdout);
      assert.equal(dryResult.applied, false);
      assert.equal(dryResult.exact, false);
      assert.deepEqual(
        new Set(dryResult.plannedChanges.map((change) => change.kind)),
        new Set(["variable", "label", "status-checks", "conversation-resolution", "admin-enforcement"]),
      );
      assert.equal(mutationCount(readState(statePath)), 0);

      const applied = runConfigure(directory, statePath, ["--apply"]);
      assert.equal(applied.status, 0, applied.stderr);
      const appliedResult = JSON.parse(applied.stdout);
      assert.equal(appliedResult.applied, true);
      assert.equal(appliedResult.exact, true);
      const configured = readState(statePath);
      assert.deepEqual(
        configured.variables.find((variable) => variable.name === "AUTOMATED_REVIEW_LOGIN"),
        { name: "AUTOMATED_REVIEW_LOGIN", value: reviewerLogin },
      );
      assert.deepEqual(
        configured.variables.find((variable) => variable.name === "RELEASE_OPERATOR_LOGIN"),
        { name: "RELEASE_OPERATOR_LOGIN", value: operatorLogin },
      );
      assert.deepEqual(
        configured.variables.find((variable) => variable.name === "UNRELATED"),
        { name: "UNRELATED", value: "preserved" },
      );
      assert.deepEqual(configured.statusProtection, {
        checks: [
          { app_id: 7, context: "Existing CI" },
          { app_id: githubActionsAppId, context: "CHZZK review completion" },
        ],
        strict: true,
      });
      assert.equal(configured.conversationResolution, true);
      assert.equal(configured.adminEnforcement, true);
      assert.equal(
        configured.log.some((entry) => entry.endpoint.includes("required_pull_request_reviews")),
        false,
      );

      const mutationsAfterFirstApply = mutationCount(configured);
      const reapplied = runConfigure(directory, statePath, ["--apply"]);
      assert.equal(reapplied.status, 0, reapplied.stderr);
      const reappliedResult = JSON.parse(reapplied.stdout);
      assert.deepEqual(reappliedResult.plannedChanges, []);
      assert.equal(mutationCount(readState(statePath)), mutationsAfterFirstApply);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
