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
const cleanReviewFooter = `<details> <summary>ℹ️ About Codex in GitHub</summary>
<br/>

[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
- Open a pull request for review
- Mark a draft as ready
- Comment "@codex review".

If Codex has suggestions, it will comment; otherwise it will react with 👍.




Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".

</details>`;

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
    user: { id: 2, login: operatorLogin, type: "User" },
    ...overrides,
  };
}

function cleanReviewComment(overrides = {}) {
  return {
    body:
      "Codex Review: Didn't find any major issues. Bravo.\n\n" +
      `**Reviewed commit:** \`${headSha.slice(0, 10)}\`\n\n` +
      cleanReviewFooter,
    created_at: "2026-07-15T10:02:00Z",
    id: 200,
    performed_via_github_app: { id: 3, slug: "chatgpt-codex-connector" },
    updated_at: "2026-07-15T10:02:00Z",
    user: { id: 1, login: reviewerLogin, type: "Bot" },
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
    pullRequestComments: [],
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
                body: `@codex review ${headSha}`,
                created_at: "2026-07-15T10:00:30Z",
                id: 100,
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
              body: `@codex review ${headSha}`,
              created_at: "2026-07-15T10:00:30Z",
              id: 100,
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
                body: `@codex review ${staleSha}`,
                created_at: "2026-07-15T10:00:30Z",
                id: 100,
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

  it("accepts only an unedited latest clean-review comment bound to the exact-head operator request", () => {
    const request = reviewRequest({ reactions: [] });
    assert.deepEqual(
      evaluateReviewCompletion(
        sensitiveEvaluation({
          pullRequest: {
            draft: false,
            head: { sha: headSha },
            number: 42,
            state: "open",
            updated_at: "2026-07-15T10:02:00Z",
          },
          pullRequestComments: [request, cleanReviewComment()],
          reviewRequestComments: [request],
          reviews: [],
        }),
      ),
      {
        description: "Trusted reviewer reported no major issues for the exact PR head; no unresolved threads",
        headSha,
        required: true,
        state: "success",
      },
    );

    const rejected = [
      {
        pullRequestComments: [
          request,
          cleanReviewComment({
            body:
              "Codex Review: Didn't find any major issues.\n\n" +
              `**Reviewed commit:** \`${staleSha.slice(0, 10)}\`\n\n` +
              cleanReviewFooter,
          }),
        ],
      },
      {
        pullRequestComments: [
          request,
          cleanReviewComment({
            body:
              "Untrusted preamble\n\nCodex Review: Didn't find any major issues.\n\n" +
              `**Reviewed commit:** \`${headSha.slice(0, 10)}\`\n\n` +
              cleanReviewFooter,
          }),
        ],
      },
      {
        pullRequestComments: [
          request,
          cleanReviewComment({
            body:
              "Codex Review: Didn't find any major issues. Unrecognized status.\n\n" +
              `**Reviewed commit:** \`${headSha.slice(0, 10)}\`\n\n` +
              cleanReviewFooter,
          }),
        ],
      },
      {
        pullRequestComments: [
          request,
          cleanReviewComment({
            body: `${cleanReviewComment().body}\n\n### Findings\n\n- P1: trailing content`,
          }),
        ],
      },
      {
        pullRequestComments: [
          request,
          cleanReviewComment({ performed_via_github_app: { id: 3, slug: "different-app" } }),
        ],
      },
      {
        pullRequestComments: [
          request,
          cleanReviewComment({ user: { id: 1, login: reviewerLogin, type: "User" } }),
        ],
      },
      {
        pullRequestComments: [request, cleanReviewComment({ updated_at: "2026-07-15T10:02:01Z" })],
      },
      {
        pullRequestComments: [
          request,
          cleanReviewComment(),
          {
            body: "later activity",
            created_at: "2026-07-15T10:03:00Z",
            id: 201,
            performed_via_github_app: null,
            updated_at: "2026-07-15T10:03:00Z",
            user: { id: 4, login: "later-writer", type: "User" },
          },
        ],
      },
      {
        pullRequestComments: [cleanReviewComment()],
        reviewRequestComments: [],
      },
      {
        pullRequestComments: [reviewRequest({ updated_at: "2026-07-15T10:00:31Z" }), cleanReviewComment()],
        reviewRequestComments: [reviewRequest({ updated_at: "2026-07-15T10:00:31Z" })],
      },
      {
        pullRequestComments: [request, cleanReviewComment()],
        reviews: [exactReview({ state: "COMMENTED", submitted_at: "2026-07-15T10:02:01Z" })],
      },
    ];
    for (const overrides of rejected) {
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
              pullRequestComments: [request, cleanReviewComment()],
              reviewRequestComments: [request],
              reviews: [],
              ...overrides,
            }),
          ),
        /no exact-head|clean-review|missing|mismatch|edited|actor metadata/i,
      );
    }
  });

  it("requires an explicit exact-head operator review command before accepting a clean response", () => {
    const unrelated = reviewRequest({
      body: `Status note for exact head ${headSha}`,
      reactions: [],
    });
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
            pullRequestComments: [unrelated, cleanReviewComment()],
            reviewRequestComments: [unrelated],
            reviews: [],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("uses issue-comment IDs to order an exact-head request and clean response in the same second", () => {
    const sameSecondRequest = reviewRequest({
      created_at: "2026-07-15T10:02:00Z",
      id: 199,
      reactions: [],
      updated_at: "2026-07-15T10:02:00Z",
    });
    const sameSecondClean = cleanReviewComment({ created_at: "2026-07-15T10:02:00Z", id: 200 });
    const input = {
      pullRequest: {
        draft: false,
        head: { sha: headSha },
        number: 42,
        state: "open",
        updated_at: "2026-07-15T10:02:00Z",
      },
      pullRequestComments: [sameSecondRequest, sameSecondClean],
      reviewRequestComments: [sameSecondRequest],
      reviews: [exactReview({ state: "COMMENTED", submitted_at: "2026-07-15T10:02:00Z" })],
    };
    assert.equal(evaluateReviewCompletion(sensitiveEvaluation(input)).state, "success");

    const laterRequest = { ...sameSecondRequest, id: 201 };
    assert.throws(
      () =>
        evaluateReviewCompletion(
          sensitiveEvaluation({
            ...input,
            pullRequestComments: [sameSecondClean, laterRequest],
            reviewRequestComments: [laterRequest],
          }),
        ),
      /no exact-head approval|exact-head operator request/i,
    );
  });

  it("requires a clean reaction to postdate an exact-head findings review", () => {
    const request = {
      body: `@codex review ${headSha}`,
      created_at: "2026-07-15T10:00:30Z",
      id: 100,
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
            body: `@codex review ${headSha}`,
            created_at: "2026-07-15T10:00:30Z",
            id: 100,
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
          pullRequestComments: null,
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
