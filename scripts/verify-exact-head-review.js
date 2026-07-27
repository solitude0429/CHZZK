#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REVIEW_BOT_LOGINS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);
const REVIEW_REQUEST_RE = /(?:^|\s)@codex\s+review(?:\s|$)/i;
const REVIEW_HEAD_LINE_RE = /^\s*head:\s*`?([a-f0-9]{40})`?\s*$/im;
const REVIEW_BASE_LINE_RE = /^\s*base:\s*`?([^\s`@]+)@([a-f0-9]{40})`?\s*$/im;
const FULL_SHA_RE = /\b[a-f0-9]{40}\b/gi;
const INVALIDATING_TIMELINE_TYPES = new Set([
  "BaseRefChangedEvent",
  "BaseRefDeletedEvent",
  "BaseRefRestoredEvent",
  "HeadRefDeletedEvent",
  "HeadRefForcePushedEvent",
  "HeadRefRestoredEvent",
  "PullRequestCommit",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizedSha(value) {
  const sha = String(value ?? "").toLowerCase();
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

function normalizedBaseRef(value) {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  return ref && !/[\s`@]/.test(ref) ? ref : null;
}

function pullRequestIdentity(snapshot) {
  return {
    baseRefName: normalizedBaseRef(snapshot?.baseRefName),
    baseSha: normalizedSha(snapshot?.baseRefOid),
    headSha: normalizedSha(snapshot?.headRefOid),
  };
}

function evaluationResult(
  snapshot,
  { conclusion = "failure", retryable = false, shouldPublish = true, summary },
) {
  const { baseRefName, baseSha, headSha } = pullRequestIdentity(snapshot);
  return {
    baseRefName,
    baseSha,
    conclusion,
    headSha,
    retryable,
    shouldPublish,
    summary,
  };
}

function skippedResult(snapshot, summary) {
  return evaluationResult(snapshot, {
    shouldPublish: false,
    summary,
  });
}

export function parseReviewRequest(body) {
  if (typeof body !== "string" || !REVIEW_REQUEST_RE.test(body)) return null;
  const head = body.match(REVIEW_HEAD_LINE_RE)?.[1]?.toLowerCase() ?? null;
  const baseRefName = normalizedBaseRef(body.match(REVIEW_BASE_LINE_RE)?.[1]);
  const baseSha = body.match(REVIEW_BASE_LINE_RE)?.[2]?.toLowerCase() ?? null;
  const fullShas = body.match(FULL_SHA_RE)?.map((value) => value.toLowerCase()) ?? [];
  if (!head || !baseRefName || !baseSha || fullShas.length !== 2) return null;
  return { baseRefName, baseSha, headSha: head };
}

export function reviewRequestMatchesSnapshot(body, snapshot) {
  const request = parseReviewRequest(body);
  const identity = pullRequestIdentity(snapshot);
  return Boolean(
    request &&
      identity.headSha &&
      identity.baseRefName &&
      identity.baseSha &&
      request.headSha === identity.headSha &&
      request.baseRefName === identity.baseRefName &&
      request.baseSha === identity.baseSha,
  );
}

function reactionUsers(group) {
  const users = group?.users;
  if (users?.pageInfo?.hasNextPage) return null;
  return asArray(users?.nodes);
}

function hasSuccessfulBotReaction(entry) {
  const thumbsUp = asArray(entry?.reactionGroups).find((group) => group?.content === "THUMBS_UP");
  const users = reactionUsers(thumbsUp);
  if (users === null) return null;
  return users.some((user) => REVIEW_BOT_LOGINS.has(user?.login));
}

function timelineRequest(snapshot, commentId) {
  const timeline = snapshot?.timelineItems;
  if (timeline?.pageInfo?.hasPreviousPage || timeline?.pageInfo?.hasNextPage) {
    return { error: "Pull-request timeline pagination exceeded the verifier limit." };
  }
  const nodes = asArray(timeline?.nodes);
  const commentIndex = nodes.findIndex(
    (node) => node?.__typename === "IssueComment" && node?.databaseId === commentId,
  );
  if (commentIndex < 0) {
    return {
      error: "The triggering review-request comment is not visible in the bounded timeline yet.",
      retryable: true,
    };
  }
  const headSha = normalizedSha(snapshot?.headRefOid);
  const headCommitIndex = nodes.findIndex(
    (node) => node?.__typename === "PullRequestCommit" && normalizedSha(node?.commit?.oid) === headSha,
  );
  if (headCommitIndex < 0) {
    return {
      error: "The exact current head is not visible in the bounded timeline yet.",
      retryable: true,
    };
  }
  if (headCommitIndex >= commentIndex) {
    return { error: "The review request was not created after the exact current head entered the PR." };
  }
  const invalidatingNode = nodes
    .slice(commentIndex + 1)
    .find((node) => INVALIDATING_TIMELINE_TYPES.has(node?.__typename));
  if (invalidatingNode) {
    return {
      error: `The PR head or base changed after the review request (${invalidatingNode.__typename}).`,
    };
  }
  return { comment: nodes[commentIndex] };
}

function eventBodyContainsReviewRequest(context) {
  return [context?.eventCommentBody, context?.eventPreviousBody].some(
    (body) => typeof body === "string" && REVIEW_REQUEST_RE.test(body),
  );
}

export function evaluateExactHeadReview(snapshot, context = {}) {
  const identity = pullRequestIdentity(snapshot);
  if (!identity.headSha || !identity.baseRefName || !identity.baseSha) {
    return evaluationResult(snapshot, {
      summary: "Pull request head or base identity is invalid.",
    });
  }

  if (context.eventName !== "issue_comment") {
    return evaluationResult(snapshot, {
      summary: "Pull request state changed; submit a new exact-diff Codex review request.",
    });
  }

  const pullRequestAuthor = snapshot?.author?.login;
  const trustedRequester = context.eventTrustedRequester;
  const requesterAuthorized =
    typeof context.eventCommentAuthor === "string" &&
    (context.eventCommentAuthor === pullRequestAuthor ||
      (typeof trustedRequester === "string" &&
        trustedRequester !== "" &&
        context.eventCommentAuthor === trustedRequester));
  if (
    typeof pullRequestAuthor !== "string" ||
    !requesterAuthorized ||
    !eventBodyContainsReviewRequest(context)
  ) {
    return skippedResult(
      snapshot,
      "The comment is not an exact-diff request from the PR author or trusted operator.",
    );
  }

  if (context.eventAction !== "created") {
    return evaluationResult(snapshot, {
      summary: "The exact-diff review request was edited or deleted; submit a new unedited request.",
    });
  }

  const commentId = Number(context.eventCommentId);
  if (!Number.isSafeInteger(commentId) || commentId < 1) {
    return evaluationResult(snapshot, {
      summary: "The exact-diff review request comment ID is invalid.",
    });
  }

  const request = timelineRequest(snapshot, commentId);
  if (request.error) {
    return evaluationResult(snapshot, { retryable: request.retryable === true, summary: request.error });
  }
  const comment = request.comment;
  if (comment?.author?.login !== context.eventCommentAuthor) {
    return evaluationResult(snapshot, {
      summary: "The review-request comment author does not match the triggering actor.",
    });
  }
  if (
    typeof comment?.createdAt !== "string" ||
    typeof comment?.updatedAt !== "string" ||
    comment.createdAt !== comment.updatedAt
  ) {
    return evaluationResult(snapshot, {
      summary: "The review-request comment was edited after creation.",
    });
  }
  if (!reviewRequestMatchesSnapshot(comment?.body, snapshot)) {
    return evaluationResult(snapshot, {
      summary: `The review request must bind head ${identity.headSha.slice(0, 12)} to base ${identity.baseRefName}@${identity.baseSha.slice(0, 12)}.`,
    });
  }

  const threadConnection = snapshot?.reviewThreads;
  if (threadConnection?.pageInfo?.hasNextPage) {
    return evaluationResult(snapshot, {
      summary: "Review thread pagination exceeded the verifier limit; refusing an incomplete result.",
    });
  }
  const unresolved = asArray(threadConnection?.nodes).filter((thread) => thread?.isResolved !== true);

  const reacted = hasSuccessfulBotReaction(comment);
  if (reacted === null) {
    return evaluationResult(snapshot, {
      summary: "Codex reaction pagination exceeded the verifier limit; refusing an incomplete result.",
    });
  }
  if (!reacted) {
    return evaluationResult(snapshot, {
      retryable: true,
      summary: `Waiting for Codex to complete the exact diff ${identity.baseRefName}@${identity.baseSha.slice(0, 12)}...${identity.headSha.slice(0, 12)}.`,
    });
  }
  if (unresolved.length > 0) {
    return evaluationResult(snapshot, {
      summary: `${unresolved.length} unresolved review thread(s) remain; resolve them and submit a new exact-diff request.`,
    });
  }

  return evaluationResult(snapshot, {
    conclusion: "success",
    summary: `Exact-diff Codex review passed for ${identity.baseRefName}@${identity.baseSha.slice(0, 12)}...${identity.headSha.slice(0, 12)} with zero unresolved threads.`,
  });
}

function positiveBoundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function waitForExactHeadReview({
  attempts = 1,
  context,
  intervalMs = 0,
  loadSnapshot,
  sleepImpl = sleep,
}) {
  const boundedAttempts = positiveBoundedInteger(attempts, 1, 40);
  const boundedIntervalMs = positiveBoundedInteger(intervalMs, 15_000, 60_000);
  let result = null;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    result = evaluateExactHeadReview(await loadSnapshot(), context);
    if (!result.retryable) return result;
    if (attempt < boundedAttempts) await sleepImpl(boundedIntervalMs);
  }
  return {
    ...result,
    retryable: false,
    summary: "Codex did not provide a bound thumbs-up before the polling window expired.",
  };
}

async function githubGraphql(token, query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    body: JSON.stringify({ query, variables }),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "chzzk-exact-head-review",
      "x-github-api-version": "2022-11-28",
    },
    method: "POST",
    redirect: "error",
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

export async function loadPullRequestSnapshot({ owner, pullRequestNumber, repository, token }) {
  const query = `
    query($owner: String!, $repository: String!, $number: Int!) {
      repository(owner: $owner, name: $repository) {
        pullRequest(number: $number) {
          author { login }
          baseRefName
          baseRefOid
          headRefOid
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes { isResolved }
          }
          timelineItems(last: 100) {
            pageInfo { hasNextPage hasPreviousPage }
            nodes {
              __typename
              ... on IssueComment {
                author { login }
                body
                createdAt
                databaseId
                reactionGroups {
                  content
                  users(first: 100) {
                    pageInfo { hasNextPage }
                    nodes { login }
                  }
                }
                updatedAt
              }
              ... on PullRequestCommit {
                commit { oid }
              }
            }
          }
        }
      }
    }
  `;
  const data = await githubGraphql(token, query, {
    number: pullRequestNumber,
    owner,
    repository,
  });
  const snapshot = data?.repository?.pullRequest;
  if (!snapshot) throw new Error("Pull request was not found.");
  return snapshot;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function optionalEnvironment(name) {
  const value = process.env[name];
  return typeof value === "string" ? value : "";
}

function writeOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const summaryBase64 = Buffer.from(result.summary, "utf8").toString("base64");
  appendFileSync(
    outputPath,
    [
      `base_ref=${result.baseRefName ?? ""}`,
      `base_sha=${result.baseSha ?? ""}`,
      `conclusion=${result.conclusion}`,
      `head_sha=${result.headSha ?? ""}`,
      `should_publish=${result.shouldPublish === true}`,
      `summary_base64=${summaryBase64}`,
      "",
    ].join("\n"),
  );
}

function eventContextFromEnvironment() {
  return {
    eventAction: requiredEnvironment("CHZZK_EVENT_ACTION"),
    eventCommentAuthor: optionalEnvironment("CHZZK_EVENT_COMMENT_AUTHOR"),
    eventCommentBody: optionalEnvironment("CHZZK_EVENT_COMMENT_BODY"),
    eventCommentId: optionalEnvironment("CHZZK_EVENT_COMMENT_ID"),
    eventName: requiredEnvironment("CHZZK_EVENT_NAME"),
    eventPreviousBody: optionalEnvironment("CHZZK_EVENT_PREVIOUS_BODY"),
    eventTrustedRequester: optionalEnvironment("CHZZK_TRUSTED_REVIEW_REQUESTER"),
  };
}

async function main() {
  const [owner, repository] = requiredEnvironment("GITHUB_REPOSITORY").split("/");
  if (!owner || !repository) throw new Error("GITHUB_REPOSITORY must be owner/name");
  const pullRequestNumber = Number(requiredEnvironment("CHZZK_PR_NUMBER"));
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("CHZZK_PR_NUMBER must be a positive integer");
  }
  const token = requiredEnvironment("GITHUB_TOKEN");
  const context = eventContextFromEnvironment();
  const result = await waitForExactHeadReview({
    attempts:
      context.eventName === "issue_comment" && context.eventAction === "created"
        ? process.env.CHZZK_WAIT_ATTEMPTS
        : 1,
    context,
    intervalMs: process.env.CHZZK_WAIT_INTERVAL_MS,
    loadSnapshot: () =>
      loadPullRequestSnapshot({ owner, pullRequestNumber, repository, token }),
  });
  writeOutputs(result);
  console.log(JSON.stringify(result));
  if (!process.env.GITHUB_OUTPUT && result.shouldPublish && result.conclusion !== "success") {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    const result = {
      baseRefName: null,
      baseSha: null,
      conclusion: "failure",
      headSha: null,
      retryable: false,
      shouldPublish: true,
      summary: `Exact-diff review verification failed closed: ${error.message}`,
    };
    writeOutputs(result);
    console.error(result.summary);
    if (!process.env.GITHUB_OUTPUT) process.exitCode = 1;
  });
}
