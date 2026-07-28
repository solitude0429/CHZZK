import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateExactHeadReview,
  reviewRequestCoordinates,
  reviewRequestMatchesSnapshot,
  waitForExactHeadReview,
} from "../../scripts/verify-exact-head-review.js";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "89abcdef0123456789abcdef0123456789abcdef";
const requestId = "IC_kwDOsynthetic";
const createdAt = "2026-07-28T01:00:00Z";
const reactedAt = "2026-07-28T01:00:05Z";

function reviewBody({ base = baseSha, head = headSha } = {}) {
  return `@codex review\n\nExact head: \`${head}\`\nExact base: \`${base}\``;
}

function passingSnapshot() {
  return {
    author: { login: "repository-owner" },
    baseRefName: "main",
    baseRefOid: baseSha,
    eventBaseSha: baseSha,
    expectedBaseRef: "main",
    headRefOid: headSha,
    isDraft: true,
    number: 92,
    requestComment: {
      author: { login: "repository-owner" },
      body: reviewBody(),
      createdAt,
      id: requestId,
      lastEditedAt: null,
      pullRequest: { number: 92 },
      reactionGroups: [
        {
          content: "THUMBS_UP",
          reactors: {
            edges: [
              {
                node: { login: "chatgpt-codex-connector[bot]" },
                reactedAt,
              },
            ],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          },
        },
      ],
    },
    timelineItems: {
      nodes: [
        { __typename: "PullRequestCommit", commit: { oid: headSha } },
        { __typename: "IssueComment", id: requestId },
      ],
      pageInfo: { hasNextPage: false, hasPreviousPage: false },
    },
  };
}

function assertFailure(snapshot, pattern) {
  const result = evaluateExactHeadReview(snapshot);
  assert.equal(result.conclusion, "failure");
  assert.match(result.summary, pattern);
  return result;
}

describe("exact-head review verification", () => {
  it("requires one explicit full head and base SHA", () => {
    assert.deepEqual(reviewRequestCoordinates(reviewBody()), { baseSha, headSha });
    assert.equal(reviewRequestMatchesSnapshot(reviewBody(), headSha, baseSha), true);
    assert.equal(
      reviewRequestCoordinates(
        `@codex review\nExact head: \`${headSha.slice(0, 12)}\`\nExact base: \`${baseSha}\``,
      ),
      null,
    );
    assert.equal(reviewRequestCoordinates(`${reviewBody()}\nExact head: \`${headSha}\``), null);
    assert.equal(
      reviewRequestCoordinates(`review\nExact head: \`${headSha}\`\nExact base: \`${baseSha}\``),
      null,
    );
  });

  it("accepts an unedited author request whose current head existed before the request", () => {
    assert.deepEqual(evaluateExactHeadReview(passingSnapshot()), {
      baseSha,
      conclusion: "success",
      headSha,
      retryable: false,
      summary: `Exact-diff Codex review passed for head ${headSha.slice(0, 12)} on base ${baseSha.slice(0, 12)}.`,
    });
  });

  it("allows review evidence to succeed while the pull request remains draft", () => {
    const snapshot = passingSnapshot();
    snapshot.isDraft = true;
    assert.equal(evaluateExactHeadReview(snapshot).conclusion, "success");
  });

  it("rejects edited, foreign, detached, stale, or ambiguous request comments", () => {
    const edited = passingSnapshot();
    edited.requestComment.lastEditedAt = "2026-07-28T01:01:00Z";
    assertFailure(edited, /edited/i);

    const foreign = passingSnapshot();
    foreign.requestComment.author.login = "other-user";
    assertFailure(foreign, /author/i);

    const detached = passingSnapshot();
    detached.requestComment.pullRequest.number = 93;
    assertFailure(detached, /attached/i);

    const staleHead = passingSnapshot();
    staleHead.requestComment.body = reviewBody({ head: "a".repeat(40) });
    assertFailure(staleHead, /current head and base/i);

    const staleBase = passingSnapshot();
    staleBase.requestComment.body = reviewBody({ base: "b".repeat(40) });
    assertFailure(staleBase, /current head and base/i);
  });

  it("rejects a future head named before it became the pull-request head", () => {
    const snapshot = passingSnapshot();
    const oldHead = "1".repeat(40);
    snapshot.timelineItems.nodes = [
      { __typename: "PullRequestCommit", commit: { oid: oldHead } },
      { __typename: "IssueComment", id: requestId },
      { __typename: "PullRequestCommit", commit: { oid: headSha } },
    ];
    assertFailure(snapshot, /was not the pull-request head/i);
  });

  it("rejects a base that was not the default-branch tip when the request event was created", () => {
    const futureBase = passingSnapshot();
    futureBase.eventBaseSha = "4".repeat(40);
    assertFailure(futureBase, /captured when the review request was created/i);

    const otherBase = passingSnapshot();
    otherBase.baseRefName = "release";
    assertFailure(otherBase, /default-branch tip/i);
  });

  it("recovers the current head after a pre-request ref restore", () => {
    const snapshot = passingSnapshot();
    snapshot.timelineItems.nodes = [
      { __typename: "PullRequestCommit", commit: { oid: headSha } },
      { __typename: "HeadRefDeletedEvent" },
      { __typename: "HeadRefRestoredEvent", pullRequest: { headRefOid: headSha } },
      { __typename: "IssueComment", id: requestId },
    ];
    assert.equal(evaluateExactHeadReview(snapshot).conclusion, "success");
  });

  it("rejects every head or base mutation after the request", () => {
    for (const mutation of [
      { __typename: "PullRequestCommit", commit: { oid: "2".repeat(40) } },
      { __typename: "HeadRefForcePushedEvent", afterCommit: { oid: headSha } },
      { __typename: "HeadRefDeletedEvent" },
      { __typename: "HeadRefRestoredEvent" },
    ]) {
      const snapshot = passingSnapshot();
      snapshot.timelineItems.nodes.push(mutation);
      assertFailure(snapshot, /head changed/i);
    }

    for (const mutation of [
      { __typename: "BaseRefChangedEvent" },
      { __typename: "BaseRefDeletedEvent" },
      { __typename: "BaseRefForcePushedEvent" },
      { __typename: "AutomaticBaseChangeSucceededEvent" },
    ]) {
      const snapshot = passingSnapshot();
      snapshot.timelineItems.nodes.push(mutation);
      assertFailure(snapshot, /base changed/i);
    }
  });

  it("fails closed when the timeline or reactor list is incomplete", () => {
    const timelinePaginated = passingSnapshot();
    timelinePaginated.timelineItems.pageInfo.hasPreviousPage = true;
    assertFailure(timelinePaginated, /timeline pagination/i);

    const reactorsPaginated = passingSnapshot();
    reactorsPaginated.requestComment.reactionGroups[0].reactors.pageInfo.hasNextPage = true;
    assertFailure(reactorsPaginated, /reaction pagination/i);
  });

  it("requires a Codex reaction created after the immutable request", () => {
    const oldReaction = passingSnapshot();
    oldReaction.requestComment.reactionGroups[0].reactors.edges[0].reactedAt = "2026-07-28T00:59:59Z";
    const oldResult = assertFailure(oldReaction, /no successful Codex reaction/i);
    assert.equal(oldResult.retryable, true);

    const spoofed = passingSnapshot();
    spoofed.requestComment.reactionGroups[0].reactors.edges[0].node.login = "other-bot";
    assertFailure(spoofed, /no successful Codex reaction/i);
  });

  it("retries only missing reaction evidence and stops immediately on terminal mutation", async () => {
    let loads = 0;
    let sleeps = 0;
    const success = await waitForExactHeadReview({
      attempts: 3,
      loadSnapshot: async () => {
        loads += 1;
        const snapshot = passingSnapshot();
        if (loads === 1) snapshot.requestComment.reactionGroups = [];
        return snapshot;
      },
      sleep: async () => {
        sleeps += 1;
      },
    });
    assert.equal(success.conclusion, "success");
    assert.equal(loads, 2);
    assert.equal(sleeps, 1);

    loads = 0;
    sleeps = 0;
    const terminal = await waitForExactHeadReview({
      attempts: 40,
      loadSnapshot: async () => {
        loads += 1;
        const snapshot = passingSnapshot();
        snapshot.timelineItems.nodes.push({
          __typename: "PullRequestCommit",
          commit: { oid: "3".repeat(40) },
        });
        return snapshot;
      },
      sleep: async () => {
        sleeps += 1;
      },
    });
    assert.equal(terminal.conclusion, "failure");
    assert.equal(terminal.retryable, false);
    assert.equal(loads, 1);
    assert.equal(sleeps, 0);
  });
});
