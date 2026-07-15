import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateReviewCompletion, requiresAutomatedSecurityReview } from "../../scripts/lib/review-gate.js";

const headSha = "d".repeat(40);
const staleSha = "e".repeat(40);
const reviewerLogin = "chatgpt-codex-connector[bot]";
const operatorLogin = "sole-owner";
const headTimestamp = "2026-07-15T10:00:00Z";

function exactReview(overrides = {}) {
  return {
    commit_id: headSha,
    state: "COMMENTED",
    submitted_at: "2026-07-15T10:01:00Z",
    user: { login: reviewerLogin },
    ...overrides,
  };
}

function plusOne(overrides = {}) {
  return {
    content: "+1",
    created_at: "2026-07-15T10:01:00Z",
    user: { login: reviewerLogin },
    ...overrides,
  };
}

function sensitiveEvaluation(overrides = {}) {
  return {
    automatedReviewLogin: reviewerLogin,
    expectedHeadSha: headSha,
    files: ["scripts/lib/release-artifacts.js"],
    headCommit: {
      commit: { committer: { date: headTimestamp } },
      sha: headSha,
    },
    issueReactions: [],
    labels: [],
    pullRequest: { draft: false, head: { sha: headSha }, number: 42, state: "open" },
    releaseOperatorLogin: operatorLogin,
    reviews: [exactReview()],
    reviewRequestComments: [],
    reviewThreads: [{ isResolved: true }],
    ...overrides,
  };
}

describe("exact-head release and security review completion", () => {
  it("classifies broad security/release paths plus explicit labels or force input", () => {
    for (const path of [
      ".github/workflows/sign-unlisted.yml",
      "scripts/deploy-internal-updates.js",
      "site-observer.js",
      "tests/unit/diagnostics.test.js",
      "src/runtime/site-observer.js",
      "src/shared/request-policy.js",
      "policy/quality-policy.json",
      "manifest.json",
    ]) {
      assert.equal(requiresAutomatedSecurityReview({ files: [path], labels: [] }), true, path);
    }
    assert.equal(requiresAutomatedSecurityReview({ files: ["README.md"], labels: [] }), false);
    assert.equal(
      requiresAutomatedSecurityReview({ files: ["README.md"], labels: ["security-review-required"] }),
      true,
    );
    assert.equal(
      requiresAutomatedSecurityReview({ files: ["README.md"], forceReview: true, labels: [] }),
      true,
    );
  });

  it("accepts the connector's COMMENTED review only when commit_id is the exact current head", () => {
    assert.deepEqual(evaluateReviewCompletion(sensitiveEvaluation()), {
      description: "Automated reviewer reviewed the exact PR head; no unresolved review threads",
      headSha,
      required: true,
      state: "success",
    });

    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            reviews: [exactReview({ commit_id: staleSha })],
          }),
        ),
      /no exact-head review|exact-head operator request/i,
    );
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            reviews: [exactReview({ state: "DISMISSED" })],
          }),
        ),
      /no exact-head review|exact-head operator request/i,
    );
  });

  it("rejects an unbound issue-level +1 even when a later head is backdated", () => {
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            headCommit: {
              commit: { committer: { date: "2026-07-15T09:00:00Z" } },
              sha: headSha,
            },
            issueReactions: [plusOne()],
            reviews: [],
          }),
        ),
      /no exact-head review|exact-head operator request/i,
    );
  });

  it("prefers a +1 bound to an operator comment containing the full exact head SHA", () => {
    assert.deepEqual(
      evaluateReviewCompletion(
        sensitiveEvaluation({
          issueReactions: [],
          reviewRequestComments: [
            {
              body: `Codex review request for ${headSha}`,
              created_at: "2026-07-15T10:00:30Z",
              reactions: [plusOne()],
              updated_at: "2026-07-15T10:00:30Z",
              user: { login: operatorLogin },
            },
          ],
          reviews: [],
        }),
      ),
      {
        description: "Reviewer +1 is bound to the exact-head operator request; no unresolved threads",
        headSha,
        required: true,
        state: "success",
      },
    );

    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            reviewRequestComments: [
              {
                body: `Codex review request for ${staleSha}`,
                created_at: "2026-07-15T10:00:30Z",
                reactions: [plusOne()],
                updated_at: "2026-07-15T10:00:30Z",
                user: { login: operatorLogin },
              },
            ],
            reviews: [],
          }),
        ),
      /no exact-head review|exact-head operator request/i,
    );
  });

  it("rejects otherwise valid evidence from the wrong actor", () => {
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            issueReactions: [plusOne({ user: { login: "different-reviewer[bot]" } })],
            reviews: [exactReview({ user: { login: "different-reviewer[bot]" } })],
          }),
        ),
      /no exact-head review|exact-head operator request/i,
    );
  });

  it("fails closed on malformed or missing evidence dates and identities", () => {
    const cases = [
      {
        headCommit: { commit: { committer: { date: "not-a-date" } }, sha: headSha },
        reviews: [],
      },
      { reviews: [exactReview({ submitted_at: "not-a-date" })] },
      {
        reviewRequestComments: [
          {
            body: `Codex review request for ${headSha}`,
            created_at: "2026-07-15T10:00:30Z",
            reactions: [plusOne()],
            updated_at: "not-a-date",
            user: { login: operatorLogin },
          },
        ],
        reviews: [],
      },
      { automatedReviewLogin: "" },
      { releaseOperatorLogin: "" },
    ];
    for (const override of cases) {
      assert.throws(
        () => evaluateReviewCompletion(sensitiveEvaluation(override)),
        /missing|malformed|login|identity|timestamp/i,
      );
    }
  });

  it("requires zero unresolved review threads even with exact-head reviewer evidence", () => {
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({ reviewThreads: [{ isResolved: true }, { isResolved: false }] }),
        ),
      /unresolved|thread/i,
    );
    assert.throws(
      () => evaluateReviewCompletion(sensitiveEvaluation({ reviewThreads: [{}] })),
      /unknown|thread/i,
    );
  });

  it("does not require reviewer evidence for an ordinary PR, but still binds the reported head", () => {
    assert.deepEqual(
      evaluateReviewCompletion(
        sensitiveEvaluation({
          automatedReviewLogin: "",
          files: ["README.md"],
          headCommit: null,
          issueReactions: null,
          releaseOperatorLogin: "",
          reviews: null,
          reviewRequestComments: null,
          reviewThreads: null,
        }),
      ),
      {
        description: "No release/security-sensitive path, label, or force input",
        headSha,
        required: false,
        state: "success",
      },
    );
  });
});
