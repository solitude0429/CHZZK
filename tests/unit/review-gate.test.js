import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  changedFilePaths,
  evaluateReviewCompletion,
  requiresAutomatedSecurityReview,
} from "../../scripts/lib/review-gate.js";

const headSha = "d".repeat(40);
const staleSha = "e".repeat(40);
const reviewerLogin = "chatgpt-codex-connector[bot]";
const operatorLogin = "sole-owner";
const headTimestamp = "2026-07-15T10:00:00Z";

function exactReview(overrides = {}) {
  return {
    commit_id: headSha,
    state: "APPROVED",
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

function reviewRequest(overrides = {}) {
  return {
    body: `@codex review ${headSha}`,
    created_at: "2026-07-15T10:00:30Z",
    id: 100,
    reactions: [plusOne()],
    updated_at: "2026-07-15T10:00:30Z",
    user: { login: operatorLogin },
    ...overrides,
  };
}

function sensitiveEvaluation(overrides = {}) {
  return {
    automatedReviewLogin: reviewerLogin,
    expectedHeadSha: headSha,
    files: ["scripts/lib/release-artifacts.js"],
    issueReactions: [],
    labels: [],
    pullRequest: {
      draft: false,
      head: { sha: headSha },
      number: 42,
      state: "open",
      updated_at: headTimestamp,
    },
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
      ".npmrc",
      "README.md",
      "docs/TESTING.md",
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
    assert.equal(requiresAutomatedSecurityReview({ files: ["notes/ordinary.txt"], labels: [] }), false);
    assert.equal(
      requiresAutomatedSecurityReview({ files: ["README.md"], labels: ["security-review-required"] }),
      true,
    );
    assert.equal(
      requiresAutomatedSecurityReview({ files: ["README.md"], forceReview: true, labels: [] }),
      true,
    );
  });

  it("includes a renamed file's previous path in sensitive-path classification", () => {
    const paths = changedFilePaths([
      {
        filename: "docs/retired-release-workflow.yml",
        previous_filename: ".github/workflows/sign-unlisted.yml",
        status: "renamed",
      },
    ]);
    assert.deepEqual(paths, ["docs/retired-release-workflow.yml", ".github/workflows/sign-unlisted.yml"]);
    assert.equal(requiresAutomatedSecurityReview({ files: paths, labels: [] }), true);
  });

  it("accepts only an exact-head APPROVED review as direct completion evidence", () => {
    assert.deepEqual(evaluateReviewCompletion(sensitiveEvaluation()), {
      description: "Automated reviewer approved the exact PR head; no unresolved review threads",
      headSha,
      required: true,
      state: "success",
    });

    for (const state of ["COMMENTED", "CHANGES_REQUESTED"]) {
      assert.throws(
        () =>
          evaluateReviewCompletion(
            sensitiveEvaluation({
              reviews: [exactReview({ state })],
            }),
          ),
        /no exact-head approval|exact-head operator request/i,
        state,
      );
    }

    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            reviews: [exactReview({ commit_id: staleSha })],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            reviews: [exactReview({ state: "DISMISSED" })],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("rejects an unbound issue-level +1", () => {
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            issueReactions: [plusOne()],
            reviews: [],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("rejects a pre-bound reaction when GitHub observed the exact head later", () => {
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            pullRequest: {
              draft: false,
              head: { sha: headSha },
              number: 42,
              state: "open",
              updated_at: "2026-07-15T10:02:00Z",
            },
            reviewRequestComments: [
              {
                body: `Codex review request for ${headSha}`,
                created_at: "2026-07-15T10:00:30Z",
                reactions: [plusOne({ created_at: "2026-07-15T10:01:00Z" })],
                updated_at: "2026-07-15T10:00:30Z",
                user: { login: operatorLogin },
              },
            ],
            reviews: [],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("requires a reaction to be strictly later than both PR activity and request-comment edits", () => {
    for (const overrides of [
      {
        pullRequest: {
          draft: false,
          head: { sha: headSha },
          number: 42,
          state: "open",
          updated_at: "2026-07-15T10:01:00Z",
        },
        reviewRequestComments: [
          reviewRequest({
            created_at: "2026-07-15T09:59:00Z",
            updated_at: "2026-07-15T09:59:00Z",
          }),
        ],
      },
      {
        reviewRequestComments: [
          reviewRequest({
            created_at: "2026-07-15T10:01:00Z",
            updated_at: "2026-07-15T10:01:00Z",
          }),
        ],
      },
    ]) {
      assert.throws(
        () => evaluateReviewCompletion(sensitiveEvaluation({ reviews: [], ...overrides })),
        /no exact-head|missing/i,
      );
    }
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
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("does not treat an issue-level clean-review comment as completion evidence", () => {
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            cleanReviewComments: [
              {
                body:
                  "Codex Review: Didn't find any major issues.\n\n" +
                  `**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
                user: { login: reviewerLogin, type: "Bot" },
              },
            ],
            reviews: [],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("requires a clean reaction to postdate an exact-head findings review", () => {
    const request = {
      body: `Codex review request for ${headSha}`,
      created_at: "2026-07-15T10:00:30Z",
      reactions: [plusOne({ created_at: "2026-07-15T10:01:00Z" })],
      updated_at: "2026-07-15T10:00:30Z",
      user: { login: operatorLogin },
    };
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            reviewRequestComments: [request],
            reviews: [exactReview({ state: "COMMENTED", submitted_at: "2026-07-15T10:02:00Z" })],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );

    assert.equal(
      evaluateReviewCompletion(
        sensitiveEvaluation({
          reviewRequestComments: [
            {
              ...request,
              reactions: [plusOne({ created_at: "2026-07-15T10:03:00Z" })],
            },
          ],
          reviews: [exactReview({ state: "COMMENTED", submitted_at: "2026-07-15T10:02:00Z" })],
        }),
      ).state,
      "success",
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
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("fails closed on malformed or missing evidence dates and identities", () => {
    const cases = [
      {
        pullRequest: {
          draft: false,
          head: { sha: headSha },
          number: 42,
          state: "open",
          updated_at: "not-a-date",
        },
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
          files: ["notes/ordinary.txt"],
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
