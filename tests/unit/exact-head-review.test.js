import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateExactHeadReview,
  parseReviewRequest,
  reviewRequestMatchesSnapshot,
  waitForExactHeadReview,
} from "../../scripts/verify-exact-head-review.js";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const requestCommentId = 42;
const reactionId = 777;
const requestCreatedAt = "2026-07-28T00:00:00Z";
const requestBody = `@codex review\n\nhead: \`${headSha}\`\nbase: \`main@${baseSha}\``;

function context(overrides = {}) {
  return {
    eventAction: "created",
    eventCommentAuthor: "repository-owner",
    eventCommentBody: requestBody,
    eventCommentId: String(requestCommentId),
    eventName: "issue_comment",
    eventPreviousBody: "",
    ...overrides,
  };
}

function requestComment(overrides = {}) {
  return {
    __typename: "IssueComment",
    author: { login: "repository-owner" },
    body: requestBody,
    createdAt: requestCreatedAt,
    databaseId: requestCommentId,
    reactions: {
      nodes: [
        {
          content: "THUMBS_UP",
          createdAt: "2026-07-28T00:00:05Z",
          databaseId: reactionId,
          user: { login: "chatgpt-codex-connector[bot]" },
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    updatedAt: requestCreatedAt,
    ...overrides,
  };
}

function passingSnapshot() {
  return {
    author: { login: "repository-owner" },
    baseRefName: "main",
    baseRefOid: baseSha,
    headRefOid: headSha,
    isDraft: true,
    lastEditedAt: "2026-07-27T23:59:00Z",
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
    timelineItems: {
      nodes: [{ __typename: "PullRequestCommit", commit: { oid: headSha } }, requestComment()],
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
    },
  };
}

describe("exact-diff review verification", () => {
  it("parses one exact head and one exact base binding", () => {
    assert.deepEqual(parseReviewRequest(requestBody), {
      baseRefName: "main",
      baseSha,
      headSha,
    });
    assert.equal(reviewRequestMatchesSnapshot(requestBody, passingSnapshot()), true);
    assert.equal(parseReviewRequest(`${requestBody}\nextra: ${"a".repeat(40)}`), null);
    assert.equal(parseReviewRequest(`review ${headSha}`), null);
  });

  it("accepts a bound Codex reaction only while the PR remains draft", () => {
    assert.deepEqual(evaluateExactHeadReview(passingSnapshot(), context()), {
      baseRefName: "main",
      baseSha,
      conclusion: "success",
      evidenceCreatedAt: "2026-07-28T00:00:05Z",
      evidenceId: reactionId,
      headSha,
      requestCommentId,
      retryable: false,
      shouldPublish: true,
      summary: `Durable exact-diff review attestation passed for main@${baseSha.slice(0, 12)}...${headSha.slice(0, 12)} using request ${requestCommentId} and Codex reaction ${reactionId}.`,
    });

    const ready = passingSnapshot();
    ready.isDraft = false;
    assert.match(evaluateExactHeadReview(ready, context()).summary, /remain draft/i);
  });

  it("rejects edited requests and pull-request edits after the request", () => {
    const editedRequest = passingSnapshot();
    editedRequest.timelineItems.nodes[1].updatedAt = "2026-07-28T00:01:00Z";
    assert.match(evaluateExactHeadReview(editedRequest, context()).summary, /edited after creation/i);

    const editedPullRequest = passingSnapshot();
    editedPullRequest.lastEditedAt = "2026-07-28T00:01:00Z";
    assert.match(evaluateExactHeadReview(editedPullRequest, context()).summary, /title or body/i);
  });

  it("rejects requests created before the current head entered the PR", () => {
    const futureHead = passingSnapshot();
    futureHead.timelineItems.nodes = [
      requestComment(),
      { __typename: "PullRequestCommit", commit: { oid: headSha } },
    ];
    assert.match(evaluateExactHeadReview(futureHead, context()).summary, /after the exact current head/i);
  });

  it("rejects any head or base transition after the request", () => {
    for (const typename of [
      "PullRequestCommit",
      "HeadRefForcePushedEvent",
      "BaseRefChangedEvent",
      "BaseRefForcePushedEvent",
    ]) {
      const snapshot = passingSnapshot();
      snapshot.timelineItems.nodes.push(
        typename === "PullRequestCommit"
          ? { __typename: typename, commit: { oid: "f".repeat(40) } }
          : { __typename: typename },
      );
      assert.match(evaluateExactHeadReview(snapshot, context()).summary, /changed after/i);
    }
  });

  it("rejects stale base identity, pagination, malformed reactions, and unresolved threads", () => {
    const staleBase = passingSnapshot();
    staleBase.timelineItems.nodes[1].body = requestBody.replace(baseSha, "a".repeat(40));
    assert.match(evaluateExactHeadReview(staleBase, context()).summary, /must bind head/i);

    const timelinePaginated = passingSnapshot();
    timelinePaginated.timelineItems.pageInfo.hasPreviousPage = true;
    assert.match(evaluateExactHeadReview(timelinePaginated, context()).summary, /pagination/i);

    const reactionPaginated = passingSnapshot();
    reactionPaginated.timelineItems.nodes[1].reactions.pageInfo.hasNextPage = true;
    assert.match(evaluateExactHeadReview(reactionPaginated, context()).summary, /reaction evidence/i);

    const malformedReaction = passingSnapshot();
    malformedReaction.timelineItems.nodes[1].reactions.nodes[0].databaseId = null;
    assert.match(evaluateExactHeadReview(malformedReaction, context()).summary, /reaction evidence/i);

    const spoofed = passingSnapshot();
    spoofed.timelineItems.nodes[1].reactions.nodes[0].user.login = "other-bot";
    assert.equal(evaluateExactHeadReview(spoofed, context()).retryable, true);

    const unresolved = passingSnapshot();
    unresolved.reviewThreads.nodes.push({ isResolved: false });
    assert.match(evaluateExactHeadReview(unresolved, context()).summary, /unresolved/i);
  });

  it("requires the PR author and skips unrelated actors without polling", async () => {
    let loads = 0;
    let sleeps = 0;
    const result = await waitForExactHeadReview({
      attempts: 40,
      context: context({ eventCommentAuthor: "other-user" }),
      intervalMs: 1,
      loadSnapshot: async () => {
        loads += 1;
        return passingSnapshot();
      },
      sleepImpl: async () => {
        sleeps += 1;
      },
    });
    assert.equal(result.shouldPublish, false);
    assert.equal(loads, 1);
    assert.equal(sleeps, 0);
  });

  it("invalidates prior evidence whenever pull-request state changes", () => {
    const result = evaluateExactHeadReview(
      passingSnapshot(),
      context({ eventAction: "synchronize", eventName: "pull_request_target" }),
    );
    assert.equal(result.conclusion, "failure");
    assert.match(result.summary, /state changed/i);
  });

  it("polls only the immutable draft request and fails closed when the window expires", async () => {
    let loads = 0;
    const pending = passingSnapshot();
    pending.timelineItems.nodes[1].reactions.nodes = [];
    const result = await waitForExactHeadReview({
      attempts: 3,
      context: context(),
      intervalMs: 1,
      loadSnapshot: async () => {
        loads += 1;
        return pending;
      },
      sleepImpl: async () => {},
    });
    assert.equal(loads, 3);
    assert.equal(result.conclusion, "failure");
    assert.equal(result.retryable, false);
    assert.match(result.summary, /polling window expired/i);
  });

  it("stops polling if the PR leaves draft or its body changes", async () => {
    let loads = 0;
    const pending = passingSnapshot();
    pending.timelineItems.nodes[1].reactions.nodes = [];
    const ready = passingSnapshot();
    ready.isDraft = false;
    const result = await waitForExactHeadReview({
      attempts: 3,
      context: context(),
      intervalMs: 1,
      loadSnapshot: async () => {
        loads += 1;
        return loads === 1 ? pending : ready;
      },
      sleepImpl: async () => {},
    });
    assert.equal(loads, 2);
    assert.match(result.summary, /remain draft/i);
  });

  it("invalidates an edited or deleted review request", () => {
    for (const eventAction of ["edited", "deleted"]) {
      const result = evaluateExactHeadReview(
        passingSnapshot(),
        context({ eventAction, eventPreviousBody: requestBody }),
      );
      assert.equal(result.conclusion, "failure");
      assert.match(result.summary, /edited or deleted/i);
    }
  });
});
