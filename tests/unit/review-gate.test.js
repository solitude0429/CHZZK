import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertStablePullRequestSnapshot,
  assertStableReviewEvidenceSnapshots,
  changedFilePaths,
  evaluateReviewCompletion,
  isPendingReviewGateError,
  requiresAutomatedSecurityReview,
} from "../../scripts/lib/review-gate.js";

const headSha = "d".repeat(40);
const staleSha = "e".repeat(40);
const reviewerLogin = "chatgpt-codex-connector[bot]";
const operatorLogin = "sole-owner";
const headTimestamp = "2026-07-15T10:00:00Z";
const cleanReviewInfoFooter = [
  "<details> <summary>ℹ️ About Codex in GitHub</summary>",
  "<br/>",
  "",
  "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
  "- Open a pull request for review",
  "- Mark a draft as ready",
  '- Comment "@codex review".',
  "",
  "If Codex has suggestions, it will comment; otherwise it will react with 👍.",
  "",
  "",
  "",
  "",
  'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".',
  "            ",
  "</details>",
].join("\n");

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
    body: `Codex review request for ${headSha}`,
    created_at: "2026-07-15T10:00:30Z",
    reactions: [plusOne()],
    updated_at: "2026-07-15T10:00:30Z",
    user: { login: operatorLogin },
    ...overrides,
  };
}

function cleanReviewComment(overrides = {}) {
  return {
    body: `Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
    created_at: "2026-07-15T10:02:00Z",
    id: 100,
    updated_at: "2026-07-15T10:02:00Z",
    user: { login: reviewerLogin },
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
    reviewerCompletionComments: [],
    reviewThreads: [{ isResolved: true }],
    ...overrides,
  };
}

function reviewEvidenceSnapshot(overrides = {}) {
  const pullRequest = {
    draft: false,
    head: { sha: headSha },
    labels: [],
    number: 42,
    state: "open",
    updated_at: headTimestamp,
  };
  return {
    issueComments: [],
    pullRequestAfter: { ...pullRequest },
    pullRequestBefore: { ...pullRequest },
    reviewerCompletionComments: [],
    reviewRequestComments: [
      reviewRequest({
        id: 10,
        reactions: [plusOne({ id: 20 })],
      }),
    ],
    reviews: [exactReview({ id: 30 })],
    reviewThreads: [{ id: "thread-40", isResolved: true }],
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

  it("accepts the reviewer's canonical clean-result comment only when bound to the exact head", () => {
    const base = {
      pullRequest: {
        draft: false,
        head: { sha: headSha },
        number: 42,
        state: "open",
        updated_at: "2026-07-15T10:02:00Z",
      },
      reviewRequestComments: [reviewRequest({ reactions: [] })],
      reviews: [exactReview({ state: "COMMENTED", submitted_at: "2026-07-15T10:01:00Z" })],
    };
    for (const body of [
      cleanReviewComment().body,
      `${cleanReviewComment().body}\n\n${cleanReviewInfoFooter}`,
      `${cleanReviewComment().body}\n`,
    ]) {
      assert.deepEqual(
        evaluateReviewCompletion(
          sensitiveEvaluation({
            ...base,
            reviewerCompletionComments: [cleanReviewComment({ body })],
          }),
        ),
        {
          description:
            "Reviewer clean-result comment is bound to the exact-head request; no unresolved threads",
          headSha,
          required: true,
          state: "success",
        },
      );
    }
  });

  it("rejects clean-result comments that are stale, ambiguous, edited, late-invalidated, or unbound", () => {
    const base = {
      pullRequest: {
        draft: false,
        head: { sha: headSha },
        number: 42,
        state: "open",
        updated_at: "2026-07-15T10:02:00Z",
      },
      reviewerCompletionComments: [cleanReviewComment()],
      reviewRequestComments: [reviewRequest({ reactions: [] })],
      reviews: [],
    };
    const cases = [
      {
        reviewerCompletionComments: [
          cleanReviewComment({
            body: `Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** \`${staleSha.slice(0, 10)}\``,
          }),
        ],
      },
      {
        reviewerCompletionComments: [
          cleanReviewComment({
            body: `Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** \`${headSha.slice(0, 9)}\``,
          }),
        ],
      },
      {
        reviewerCompletionComments: [
          cleanReviewComment({
            body: `Codex Review: Found a major issue.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
          }),
        ],
      },
      {
        reviewerCompletionComments: [
          cleanReviewComment({
            body: `Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\`\n**Reviewed commit:** \`${headSha}\``,
          }),
        ],
      },
      {
        reviewerCompletionComments: [
          cleanReviewComment({
            body: `${cleanReviewComment().body}\n\n[P1] Critical issue found`,
          }),
        ],
      },
      {
        reviewerCompletionComments: [
          cleanReviewComment({
            body: `${cleanReviewComment().body}\n\n${cleanReviewInfoFooter}\nUnexpected caveat`,
          }),
        ],
      },
      {
        reviewerCompletionComments: [cleanReviewComment({ user: { login: "different-reviewer[bot]" } })],
      },
      {
        pullRequest: { ...base.pullRequest, updated_at: "2026-07-15T10:03:00Z" },
        reviewerCompletionComments: [cleanReviewComment({ updated_at: "2026-07-15T10:03:00Z" })],
      },
      {
        pullRequest: { ...base.pullRequest, updated_at: "2026-07-15T10:03:00Z" },
      },
      {
        reviewerCompletionComments: [
          cleanReviewComment({
            created_at: "2026-07-15T10:00:30Z",
            updated_at: "2026-07-15T10:00:30Z",
          }),
        ],
        pullRequest: { ...base.pullRequest, updated_at: "2026-07-15T10:00:30Z" },
      },
      {
        reviews: [exactReview({ state: "COMMENTED", submitted_at: "2026-07-15T10:03:00Z" })],
      },
      {
        pullRequest: { ...base.pullRequest, updated_at: "2026-07-15T10:03:00Z" },
        reviewerCompletionComments: [
          cleanReviewComment(),
          cleanReviewComment({
            body: "Automated review could not complete",
            created_at: "2026-07-15T10:03:00Z",
            id: 101,
            updated_at: "2026-07-15T10:03:00Z",
          }),
        ],
      },
      {
        reviewRequestComments: [
          reviewRequest({ body: `Codex review request for ${staleSha}`, reactions: [] }),
        ],
      },
    ];
    for (const overrides of cases) {
      assert.throws(
        () => evaluateReviewCompletion(sensitiveEvaluation({ ...base, ...overrides })),
        /no exact-head approval|bound clean-result|missing|malformed/i,
      );
    }
  });

  it("rejects a PR snapshot whose head or activity changes during evidence collection", () => {
    const before = {
      draft: false,
      head: { sha: headSha },
      number: 42,
      state: "open",
      updated_at: headTimestamp,
    };
    assert.equal(
      assertStablePullRequestSnapshot({ after: { ...before }, before, expectedHeadSha: headSha }),
      headSha,
    );

    for (const after of [
      { ...before, head: { sha: staleSha } },
      { ...before, updated_at: "2026-07-15T10:00:01Z" },
    ]) {
      assert.throws(
        () => assertStablePullRequestSnapshot({ after, before, expectedHeadSha: headSha }),
        (error) =>
          isPendingReviewGateError(error) && /changed during evidence collection/i.test(error.message),
      );
    }
  });

  it("rejects same-second review, thread, or reaction changes across repeated evidence collection", () => {
    const before = reviewEvidenceSnapshot();
    assert.equal(
      assertStableReviewEvidenceSnapshots({
        after: reviewEvidenceSnapshot(),
        before,
        expectedHeadSha: headSha,
      }),
      headSha,
    );

    const changedSnapshots = [
      reviewEvidenceSnapshot({
        reviews: [
          exactReview({ id: 30 }),
          exactReview({ id: 31, state: "COMMENTED", submitted_at: headTimestamp }),
        ],
      }),
      reviewEvidenceSnapshot({
        reviewThreads: [{ id: "thread-40", isResolved: false }],
      }),
      reviewEvidenceSnapshot({
        reviewRequestComments: [reviewRequest({ id: 10, reactions: [] })],
      }),
    ];
    for (const after of changedSnapshots) {
      assert.throws(
        () => assertStableReviewEvidenceSnapshots({ after, before, expectedHeadSha: headSha }),
        (error) =>
          isPendingReviewGateError(error) && /changed during repeated collection/i.test(error.message),
      );
    }
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
      {
        reviewerCompletionComments: [cleanReviewComment({ id: 0 })],
        reviewRequestComments: [reviewRequest({ reactions: [] })],
        reviews: [],
      },
      {
        reviewerCompletionComments: [cleanReviewComment({ created_at: "not-a-date" })],
        reviewRequestComments: [reviewRequest({ reactions: [] })],
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
          reviewerCompletionComments: null,
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
