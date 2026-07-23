import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const headSha = "d".repeat(40);
const baseSha = "b".repeat(40);
const reviewerLogin = "chatgpt-codex-connector[bot]";
const operatorLogin = "sole-owner";
const reviewerApp = { id: 1_144_995, slug: "chatgpt-codex-connector" };

function fakeGhSource() {
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const endpoint = args.at(-1);
state.log.push(args);
fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
function output(value) { process.stdout.write(JSON.stringify(value)); process.exit(0); }
function pages(value) { output([value]); }
if (args[0] !== "api") process.exit(2);
if (args[1] === "graphql") {
  output({
    data: {
      repository: {
        pullRequest: {
          headRefOid: state.headSha,
          reviewThreads: {
            nodes: [{ isResolved: true }],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    },
  });
}
if (endpoint === "repos/example/repository/pulls/42") {
  state.pullReads = (state.pullReads || 0) + 1;
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  output({
    base: { sha: state.finalBaseChanges && state.pullReads > 1 ? "${"c".repeat(40)}" : state.baseSha },
    draft: false,
    head: { sha: state.headSha },
    labels: [],
    number: 42,
    state: "open",
    updated_at: "2026-07-15T10:02:00Z",
  });
}
if (endpoint === "repos/example/repository/pulls/42/files?per_page=100") {
  pages([{ filename: "scripts/lib/review-gate.js", status: "modified" }]);
}
if (endpoint === "repos/example/repository/pulls/42/reviews?per_page=100") pages([]);
if (endpoint === "repos/example/repository/issues/42/comments?per_page=100") {
  pages([
    {
      body: "@codex review " + state.headSha,
      created_at: "2026-07-15T10:00:30Z",
      id: 100,
      updated_at: "2026-07-15T10:00:30Z",
      user: { login: "${operatorLogin}", type: "User" },
    },
    {
      body: "Codex Review: Didn't find any major issues. Nice work!\\n\\n**Reviewed commit:** \\\`" +
        state.headSha.slice(0, 10) + "\\\`\\n",
      created_at: "2026-07-15T10:02:00Z",
      id: 200,
      performed_via_github_app: {
        id: state.wrongApp ? ${reviewerApp.id + 1} : ${reviewerApp.id},
        slug: "${reviewerApp.slug}",
      },
      updated_at: "2026-07-15T10:02:00Z",
      user: { login: "${reviewerLogin}", type: "Bot" },
    },
  ]);
}
if (endpoint === "repos/example/repository/issues/comments/100/reactions?per_page=100") pages([]);
if (endpoint === "repos/example/repository/commits/" + state.headSha.slice(0, 10)) {
  if (state.commitResolutionFails) {
    process.stderr.write("ambiguous commit reference");
    process.exit(1);
  }
  output({ sha: state.headSha });
}
if (endpoint === "apps/${reviewerApp.slug}") output(${JSON.stringify(reviewerApp)});
process.stderr.write("unexpected fake gh request: " + args.join(" "));
process.exit(2);
`;
}

function runGate(overrides = {}) {
  const directory = mkdtempSync(join(dirname(repoRoot), "chzzk-review-gate-cli-"));
  const statePath = join(directory, "state.json");
  const outputPath = join(directory, "output");
  const ghPath = join(directory, "gh");
  writeFileSync(ghPath, fakeGhSource());
  chmodSync(ghPath, 0o755);
  writeFileSync(
    statePath,
    JSON.stringify({
      baseSha,
      headSha,
      log: [],
      ...overrides,
    }),
  );
  try {
    const result = spawnSync(process.execPath, ["scripts/check-review-gate.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CHZZK_AUTOMATED_REVIEW_LOGIN: reviewerLogin,
        CHZZK_EXPECTED_HEAD_SHA: headSha,
        CHZZK_POLL_SECONDS: "0",
        CHZZK_PR_NUMBER: "42",
        CHZZK_RELEASE_OPERATOR_LOGIN: operatorLogin,
        FAKE_GH_STATE: statePath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "example/repository",
        PATH: directory,
      },
    });
    return {
      output: readFileSync(outputPath, "utf8"),
      result,
      state: JSON.parse(readFileSync(statePath, "utf8")),
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("review-gate GitHub evidence collection", () => {
  it("resolves the clean marker and verifies the exact GitHub App before passing", () => {
    const run = runGate();
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.output, /^state=success$/m);
    assert.match(run.result.stdout, /Verified reviewer-app clean comment/);
    assert.equal(
      run.state.log.some((args) => args.includes(`repos/example/repository/commits/${headSha.slice(0, 10)}`)),
      true,
    );
    assert.equal(
      run.state.log.some((args) => args.includes(`apps/${reviewerApp.slug}`)),
      true,
    );
  });

  it("fails closed on mismatched App provenance, ambiguous refs, or a collection race", () => {
    for (const overrides of [
      { wrongApp: true },
      { commitResolutionFails: true },
      { finalBaseChanges: true },
    ]) {
      const run = runGate(overrides);
      assert.notEqual(run.result.status, 0);
      assert.match(run.output, /^state=failure$/m);
    }
  });
});
