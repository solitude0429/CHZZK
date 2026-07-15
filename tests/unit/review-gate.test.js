import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateReviewCompletion, requiresAutomatedSecurityReview } from "../../scripts/lib/review-gate.js";

const headSha = "d".repeat(40);

function sensitiveEvaluation(overrides = {}) {
  return {
    checkRuns: [
      {
        app: { slug: "synthetic-reviewer" },
        conclusion: "success",
        head_sha: headSha,
        id: 123,
        name: "Automated security review",
        status: "completed",
      },
    ],
    expectedHeadSha: headSha,
    files: ["scripts/lib/release-artifacts.js"],
    labels: [],
    pullRequest: { draft: false, head: { sha: headSha }, number: 42, state: "open" },
    reviewAppSlug: "synthetic-reviewer",
    reviewCheckName: "Automated security review",
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

  it("passes only a configured successful reviewer completion on the current head with no open thread", () => {
    assert.deepEqual(evaluateReviewCompletion(sensitiveEvaluation()), {
      description: "Automated review completed on the exact PR head; no unresolved review threads",
      headSha,
      required: true,
      state: "success",
    });
  });

  it("fails closed for missing configuration, absent signals, stale-head checks, and unresolved threads", () => {
    const cases = [
      { reviewAppSlug: "", expected: /configured|app|slug/i },
      { reviewCheckName: "", expected: /configured|check/i },
      {
        checkRuns: [
          {
            app: { slug: "github-actions" },
            conclusion: "success",
            head_sha: headSha,
            id: 125,
            name: "CHZZK review completion",
            status: "completed",
          },
        ],
        reviewAppSlug: "github-actions",
        reviewCheckName: "CHZZK review completion",
        expected: /self|gate|reviewer|configured/i,
      },
      { checkRuns: [], expected: /completion|check|signal/i },
      {
        checkRuns: [
          {
            app: { slug: "synthetic-reviewer" },
            conclusion: "success",
            head_sha: "e".repeat(40),
            id: 124,
            name: "Automated security review",
            status: "completed",
          },
        ],
        expected: /current|head|completion/i,
      },
      { reviewThreads: [{ isResolved: false }], expected: /unresolved|thread/i },
    ];
    for (const { expected, ...override } of cases) {
      assert.throws(() => evaluateReviewCompletion(sensitiveEvaluation(override)), expected);
    }
  });

  it("does not require the external reviewer for an ordinary PR, but still binds the reported head", () => {
    assert.deepEqual(
      evaluateReviewCompletion(
        sensitiveEvaluation({
          checkRuns: [],
          files: ["README.md"],
          reviewAppSlug: "",
          reviewCheckName: "",
          reviewThreads: [],
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
