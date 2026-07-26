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
const cleanReviewFooter = `<details> <summary>ℹ️ About Codex in GitHub</summary>
<br/>

[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
- Open a pull request for review
- Mark a draft as ready
- Comment "@codex review".

If Codex has suggestions, it will comment; otherwise it will react with 👍.




Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".

</details>`;

function fakeGhSource() {
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const cleanReviewFooter = ${JSON.stringify(cleanReviewFooter)};
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
            nodes: [{ id: "thread-1", isResolved: true }],
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
if (endpoint === "repos/example/repository/pulls/42/reviews?per_page=100") {
  state.reviewReads = (state.reviewReads || 0) + 1;
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  if (state.reviewsChangeBetweenSnapshots && state.reviewReads > 1) {
    pages([{
      commit_id: state.headSha,
      id: 300,
      state: "COMMENTED",
      submitted_at: "2026-07-15T10:02:00Z",
      user: { id: 1, login: "${reviewerLogin}", type: "Bot" },
    }]);
  }
  pages([]);
}
if (endpoint === "repos/example/repository/issues/42/comments?per_page=100") {
  state.commentReads = (state.commentReads || 0) + 1;
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  const comments = [
    {
      body: state.unrelatedExactHeadOperatorComment
        ? "Status note for exact head " + state.headSha
        : "@codex review " + state.headSha,
      created_at: state.sameSecondCleanReview
        ? "2026-07-15T10:02:00Z"
        : "2026-07-15T10:00:30Z",
      id: 100,
      performed_via_github_app: null,
      updated_at: state.sameSecondCleanReview
        ? "2026-07-15T10:02:00Z"
        : "2026-07-15T10:00:30Z",
      user: { id: 2, login: "${operatorLogin}", type: "User" },
    },
    {
      body: state.includeCleanReview
        ? (state.prefixedExactHeadCleanFormat ? "Untrusted preamble\\n\\n" : "") +
          "Codex Review: Didn't find any major issues. Nice work!\\n\\n**Reviewed commit:** \\\`" +
          (state.staleCleanPrefix ? "${"e".repeat(10)}" : state.headSha.slice(0, 10)) +
          "\\\`\\n\\n" +
          cleanReviewFooter +
          (state.trailingCleanContent ? "\\n\\n### Findings\\n\\n- P1: trailing content" : "")
        : "You have reached your Codex usage limits for code reviews.",
      created_at: "2026-07-15T10:02:00Z",
      id: 200,
      performed_via_github_app: {
        id: 3,
        slug: state.wrongCleanApp ? "different-app" : "chatgpt-codex-connector",
      },
      updated_at: state.cleanReviewEdited ? "2026-07-15T10:02:01Z" : "2026-07-15T10:02:00Z",
      user: { id: 1, login: "${reviewerLogin}", type: "Bot" },
    },
  ];
  if (state.commentsChangeBetweenSnapshots && state.commentReads > 1) {
    comments.push({
      body: "same-second late comment",
      created_at: "2026-07-15T10:02:00Z",
      id: 201,
      performed_via_github_app: null,
      updated_at: "2026-07-15T10:02:00Z",
      user: { id: 999, login: "late-writer", type: "User" },
    });
  }
  pages(comments);
}
if (endpoint === "repos/example/repository/issues/comments/100/reactions?per_page=100") {
  if (state.noRequestReaction) pages([]);
  pages([{
    content: "+1",
    created_at: state.staleReaction ? "2026-07-15T10:01:00Z" : "2026-07-15T10:03:00Z",
    id: 400,
    user: {
      id: 1,
      login: state.wrongReactionActor ? "different-reviewer[bot]" : "${reviewerLogin}",
      type: "Bot",
    },
  }]);
}
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
  it("collects a reaction only from the exact-head operator request before passing", () => {
    const run = runGate();
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.output, /^state=success$/m);
    assert.match(run.result.stdout, /Reviewer \+1 is bound/);
    assert.equal(
      run.state.log.some((args) =>
        args.includes("repos/example/repository/issues/comments/100/reactions?per_page=100"),
      ),
      true,
    );
  });

  it("accepts the connector's exact-head clean-review App comment without trusting a PR-level reaction", () => {
    const run = runGate({ includeCleanReview: true, noRequestReaction: true });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.output, /^state=success$/m);
    assert.match(run.result.stdout, /Trusted reviewer reported no major issues/);
    assert.equal(
      run.state.log.some((args) => args.includes("repos/example/repository/issues/42/reactions")),
      false,
    );
  });

  it("rejects stale, prefixed, edited, or wrong-App clean-review comments", () => {
    for (const overrides of [
      { includeCleanReview: true, noRequestReaction: true, prefixedExactHeadCleanFormat: true },
      { includeCleanReview: true, noRequestReaction: true, staleCleanPrefix: true },
      { cleanReviewEdited: true, includeCleanReview: true, noRequestReaction: true },
      { includeCleanReview: true, noRequestReaction: true, wrongCleanApp: true },
      { includeCleanReview: true, noRequestReaction: true, trailingCleanContent: true },
      { includeCleanReview: true, noRequestReaction: true, unrelatedExactHeadOperatorComment: true },
    ]) {
      const run = runGate(overrides);
      assert.notEqual(run.result.status, 0);
      assert.match(run.output, /^state=failure$/m);
    }
  });

  it("accepts a same-second clean response only when its issue-comment ID follows the request", () => {
    const run = runGate({
      includeCleanReview: true,
      noRequestReaction: true,
      sameSecondCleanReview: true,
    });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.output, /^state=success$/m);
    assert.match(run.result.stdout, /Trusted reviewer reported no major issues/);
  });

  it("fails closed on reaction provenance, timestamps, metadata, comment, or review races", () => {
    for (const overrides of [
      { wrongReactionActor: true },
      { staleReaction: true },
      { finalBaseChanges: true },
      { commentsChangeBetweenSnapshots: true },
      { reviewsChangeBetweenSnapshots: true },
    ]) {
      const run = runGate(overrides);
      assert.notEqual(run.result.status, 0);
      assert.match(run.output, /^state=failure$/m);
    }
  });

  it("reports a pending collection race when a same-second comment appears between snapshots", () => {
    const run = runGate({ commentsChangeBetweenSnapshots: true });
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /review evidence changed while it was collected/i);
  });
});
