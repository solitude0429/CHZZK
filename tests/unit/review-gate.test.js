import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  changedFilePaths,
  cleanReviewCommitMarker,
  evaluateReviewCompletion,
  requiresAutomatedSecurityReview,
} from "../../scripts/lib/review-gate.js";

const headSha = "d".repeat(40);
const staleSha = "e".repeat(40);
const reviewerLogin = "chatgpt-codex-connector[bot]";
const reviewerApp = { id: 1_144_995, slug: "chatgpt-codex-connector" };
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

function cleanReviewComment(overrides = {}) {
  return {
    body:
      "Codex Review: Didn't find any major issues. Nice work!\n\n" +
      `**Reviewed commit:** \`${headSha.slice(0, 10)}\`\n\n` +
      "<details><summary>About Codex in GitHub</summary></details>",
    created_at: "2026-07-15T10:02:00Z",
    id: 200,
    performed_via_github_app: reviewerApp,
    resolved_commit_sha: headSha,
    updated_at: "2026-07-15T10:02:00Z",
    user: { login: reviewerLogin, type: "Bot" },
    ...overrides,
  };
}

function exactHeadCleanReviewBody(sha = headSha) {
  return (
    `## Review Result\n\nNo major issues found in exact head \`${sha}\`.\n\n` +
    "- Verified exact-head implementation and tests."
  );
}

function sensitiveEvaluation(overrides = {}) {
  return {
    automatedReviewApp: null,
    automatedReviewLogin: reviewerLogin,
    cleanReviewComments: [],
    expectedHeadSha: headSha,
    files: ["scripts/lib/release-artifacts.js"],
    issueReactions: [],
    latestIssueCommentId: 0,
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
  it("recognizes only the two observed exact-head clean-review formats", () => {
    assert.equal(cleanReviewCommitMarker(cleanReviewComment().body), headSha.slice(0, 10));
    assert.equal(cleanReviewCommitMarker(exactHeadCleanReviewBody()), headSha);
    for (const body of [
      `Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
      `Codex Review: Found an issue.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
      `Codex Review: Didn't find any major issues.\n\nReviewed commit: ${headSha.slice(0, 10)}`,
      `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 9)}\``,
      `Review Result\n\nNo major issues found in exact head \`${headSha}\`.`,
      `## Review Result\n\nNo major issues found in head \`${headSha}\`.`,
      `## Review Result\n\nNo major issues found in exact head \`${headSha.slice(0, 39)}\`.`,
    ]) {
      assert.equal(cleanReviewCommitMarker(body), null, body);
    }
  });

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

  it("accepts an unedited latest Codex App clean comment bound to an earlier full-SHA request", () => {
    for (const body of [cleanReviewComment().body, exactHeadCleanReviewBody()]) {
      assert.deepEqual(
        evaluateReviewCompletion(
          sensitiveEvaluation({
            automatedReviewApp: reviewerApp,
            cleanReviewComments: [cleanReviewComment({ body })],
            latestIssueCommentId: 200,
            pullRequest: {
              draft: false,
              head: { sha: headSha },
              number: 42,
              state: "open",
              updated_at: "2026-07-15T10:02:00Z",
            },
            reviewRequestComments: [reviewRequest()],
            reviews: [],
          }),
        ),
        {
          description:
            "Verified reviewer-app clean comment is bound to the exact PR head; no unresolved threads",
          headSha,
          required: true,
          state: "success",
        },
      );
    }
  });

  it("rejects clean comments without exact app, commit, ordering, and activity bindings", () => {
    const base = {
      automatedReviewApp: reviewerApp,
      cleanReviewComments: [cleanReviewComment()],
      latestIssueCommentId: 200,
      pullRequest: {
        draft: false,
        head: { sha: headSha },
        number: 42,
        state: "open",
        updated_at: "2026-07-15T10:02:00Z",
      },
      reviewRequestComments: [reviewRequest()],
      reviews: [],
    };
    const cases = [
      {
        cleanReviewComments: [
          cleanReviewComment({ performed_via_github_app: { ...reviewerApp, id: reviewerApp.id + 1 } }),
        ],
      },
      {
        cleanReviewComments: [
          cleanReviewComment({
            performed_via_github_app: { ...reviewerApp, slug: "different-app" },
          }),
        ],
      },
      { cleanReviewComments: [cleanReviewComment({ resolved_commit_sha: staleSha })] },
      { cleanReviewComments: [cleanReviewComment({ updated_at: "2026-07-15T10:02:01Z" })] },
      { cleanReviewComments: [cleanReviewComment({ user: { login: reviewerLogin, type: "User" } })] },
      { latestIssueCommentId: 201 },
      {
        pullRequest: {
          ...base.pullRequest,
          updated_at: "2026-07-15T10:02:01Z",
        },
      },
      { reviewRequestComments: [reviewRequest({ body: `Review ${staleSha}` })] },
      { reviewRequestComments: [reviewRequest({ body: `Unrelated note for ${headSha}` })] },
      { reviewRequestComments: [reviewRequest({ id: 201 })] },
      {
        reviewRequestComments: [
          reviewRequest({
            created_at: "2026-07-15T10:02:00Z",
            updated_at: "2026-07-15T10:02:00Z",
          }),
        ],
      },
    ];
    for (const override of cases) {
      assert.throws(
        () => evaluateReviewCompletion(sensitiveEvaluation({ ...base, ...override })),
        /no exact-head|missing|malformed|actor type/i,
      );
    }
  });

  it("requires a clean comment to postdate any exact-head findings review", () => {
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            automatedReviewApp: reviewerApp,
            cleanReviewComments: [cleanReviewComment()],
            latestIssueCommentId: 200,
            pullRequest: {
              draft: false,
              head: { sha: headSha },
              number: 42,
              state: "open",
              updated_at: "2026-07-15T10:02:00Z",
            },
            reviewRequestComments: [reviewRequest()],
            reviews: [exactReview({ state: "COMMENTED", submitted_at: "2026-07-15T10:02:00Z" })],
          }),
        ),
      /no exact-head|verified exact-head clean comment/i,
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
