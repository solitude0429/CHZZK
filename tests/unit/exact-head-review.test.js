import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evidenceMatchesHead,
  evaluateExactHeadReview,
  reviewedCommit,
  reviewRequestMatchesHead,
} from "../../scripts/verify-exact-head-review.js";

const headSha = "0123456789abcdef0123456789abcdef01234567";

function passingReactionSnapshot() {
  return {
    author: { login: "repository-owner" },
    comments: {
      nodes: [
        {
          author: { login: "repository-owner" },
          body: `@codex review\n\nPlease review the exact current head \`${headSha}\`.`,
          reactionGroups: [
            {
              content: "THUMBS_UP",
              users: {
                nodes: [{ login: "chatgpt-codex-connector[bot]" }],
                pageInfo: { hasNextPage: false },
              },
            },
          ],
        },
      ],
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
    },
    headRefOid: headSha,
    isDraft: false,
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
  };
}

function passingCommentSnapshot() {
  const snapshot = passingReactionSnapshot();
  snapshot.comments.nodes = [
    {
      author: { login: "chatgpt-codex-connector[bot]" },
      body: `Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** \`${headSha}\``,
      reactionGroups: [],
    },
  ];
  return snapshot;
}

describe("exact-head review verification", () => {
  it("extracts and matches only a full reviewed commit SHA", () => {
    const body = `Codex Review: Didn't find any major issues.\nReviewed commit: \`${headSha}\``;
    assert.equal(reviewedCommit(body), headSha);
    assert.equal(evidenceMatchesHead(body, headSha), true);
    assert.equal(evidenceMatchesHead(body, `f${headSha.slice(1)}`), false);
    assert.equal(
      evidenceMatchesHead(
        `Codex Review: Didn't find any major issues.\nReviewed commit: \`${headSha.slice(0, 12)}\``,
        headSha,
      ),
      false,
    );
  });

  it("matches an explicit review request only to the exact full head SHA", () => {
    const body = `@codex review\nReview exact head \`${headSha}\``;
    assert.equal(reviewRequestMatchesHead(body, headSha), true);
    assert.equal(reviewRequestMatchesHead(body, `f${headSha.slice(1)}`), false);
    assert.equal(reviewRequestMatchesHead(`review ${headSha}`, headSha), false);
  });

  it("accepts a Codex thumbs-up on the owner's exact-head review request", () => {
    assert.deepEqual(evaluateExactHeadReview(passingReactionSnapshot()), {
      conclusion: "success",
      headSha,
      summary: `Exact-head Codex review passed for ${headSha.slice(0, 12)} with zero unresolved threads.`,
    });
  });

  it("retains successful bot issue-comment evidence for the exact head", () => {
    assert.equal(evaluateExactHeadReview(passingCommentSnapshot()).conclusion, "success");
  });

  it("rejects stale, spoofed, paginated, draft, and unresolved evidence", () => {
    const stale = passingReactionSnapshot();
    stale.comments.nodes[0].body = stale.comments.nodes[0].body.replace(headSha, "a".repeat(40));
    assert.equal(evaluateExactHeadReview(stale).conclusion, "failure");

    const spoofedRequest = passingReactionSnapshot();
    spoofedRequest.comments.nodes[0].author.login = "other-user";
    assert.equal(evaluateExactHeadReview(spoofedRequest).conclusion, "failure");

    const spoofedReaction = passingReactionSnapshot();
    spoofedReaction.comments.nodes[0].reactionGroups[0].users.nodes[0].login = "other-bot";
    assert.equal(evaluateExactHeadReview(spoofedReaction).conclusion, "failure");

    const reactionPaginated = passingReactionSnapshot();
    reactionPaginated.comments.nodes[0].reactionGroups[0].users.pageInfo.hasNextPage = true;
    assert.match(evaluateExactHeadReview(reactionPaginated).summary, /pagination/i);

    const draft = passingReactionSnapshot();
    draft.isDraft = true;
    assert.match(evaluateExactHeadReview(draft).summary, /draft/i);

    const unresolved = passingReactionSnapshot();
    unresolved.reviewThreads.nodes.push({ isResolved: false });
    assert.match(evaluateExactHeadReview(unresolved).summary, /unresolved/i);

    const commentsPaginated = passingReactionSnapshot();
    commentsPaginated.comments.pageInfo.hasPreviousPage = true;
    assert.match(evaluateExactHeadReview(commentsPaginated).summary, /pagination/i);
  });
});
