import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evidenceMatchesHead,
  evaluateExactHeadReview,
  reviewedCommit,
} from "../../scripts/verify-exact-head-review.js";

const headSha = "0123456789abcdef0123456789abcdef01234567";

function passingSnapshot() {
  return {
    comments: {
      nodes: [
        {
          author: { login: "chatgpt-codex-connector[bot]" },
          body: `Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
        },
      ],
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
    },
    headRefOid: headSha,
    isDraft: false,
    reviews: {
      nodes: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
    },
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
  };
}

describe("exact-head review verification", () => {
  it("extracts and matches reviewed commit evidence", () => {
    const body = `Codex Review: Didn't find any major issues.\nReviewed commit: \`${headSha.slice(0, 12)}\``;
    assert.equal(reviewedCommit(body), headSha.slice(0, 12));
    assert.equal(evidenceMatchesHead(body, headSha), true);
    assert.equal(evidenceMatchesHead(body, `f${headSha.slice(1)}`), false);
  });

  it("accepts only successful bot evidence for the current head with no unresolved threads", () => {
    assert.deepEqual(evaluateExactHeadReview(passingSnapshot()), {
      conclusion: "success",
      headSha,
      summary: `Exact-head Codex review passed for ${headSha.slice(0, 12)} with zero unresolved threads.`,
    });
  });

  it("rejects stale, user-authored, draft, unresolved, and incomplete evidence", () => {
    const stale = passingSnapshot();
    stale.comments.nodes[0].body = stale.comments.nodes[0].body.replace(
      headSha.slice(0, 10),
      "aaaaaaaaaa",
    );
    assert.equal(evaluateExactHeadReview(stale).conclusion, "failure");

    const spoofed = passingSnapshot();
    spoofed.comments.nodes[0].author.login = "repository-owner";
    assert.equal(evaluateExactHeadReview(spoofed).conclusion, "failure");

    const draft = passingSnapshot();
    draft.isDraft = true;
    assert.match(evaluateExactHeadReview(draft).summary, /draft/i);

    const unresolved = passingSnapshot();
    unresolved.reviewThreads.nodes.push({ isResolved: false });
    assert.match(evaluateExactHeadReview(unresolved).summary, /unresolved/i);

    const paginated = passingSnapshot();
    paginated.comments.pageInfo.hasPreviousPage = true;
    assert.match(evaluateExactHeadReview(paginated).summary, /pagination/i);
  });
});
