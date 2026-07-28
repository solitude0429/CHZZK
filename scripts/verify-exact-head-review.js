#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REVIEW_BOT_LOGINS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);
const REVIEW_REQUEST_RE = /(?:^|\s)@codex\s+review(?:\s|$)/i;
const EXACT_HEAD_RE = /^\s*Exact head:\s*`([a-f0-9]{40})`\s*$/gim;
const EXACT_BASE_RE = /^\s*Exact base:\s*`([a-f0-9]{40})`\s*$/gim;
const SHA_RE = /^[a-f0-9]{40}$/;
const HEAD_MUTATION_TYPES = new Set([
  "HeadRefDeletedEvent",
  "HeadRefForcePushedEvent",
  "HeadRefRestoredEvent",
  "PullRequestCommit",
]);
const BASE_MUTATION_TYPES = new Set([
  "AutomaticBaseChangeSucceededEvent",
  "BaseRefChangedEvent",
  "BaseRefDeletedEvent",
  "BaseRefForcePushedEvent",
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSha(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return SHA_RE.test(normalized) ? normalized : null;
}

function resultFor(snapshot, conclusion, summary, { retryable = false } = {}) {
  return {
    baseSha: normalizeSha(snapshot?.baseRefOid),
    conclusion,
    headSha: normalizeSha(snapshot?.headRefOid),
    retryable,
    summary,
  };
}

export function reviewRequestCoordinates(body) {
  if (typeof body !== "string" || !REVIEW_REQUEST_RE.test(body)) return null;
  const heads = [...body.matchAll(EXACT_HEAD_RE)].map((match) => match[1].toLowerCase());
  const bases = [...body.matchAll(EXACT_BASE_RE)].map((match) => match[1].toLowerCase());
  if (heads.length !== 1 || bases.length !== 1) return null;
  return { baseSha: bases[0], headSha: heads[0] };
}

export function reviewRequestMatchesSnapshot(body, headSha, baseSha) {
  const coordinates = reviewRequestCoordinates(body);
  const normalizedHead = normalizeSha(headSha);
  const normalizedBase = normalizeSha(baseSha);
  return Boolean(
    coordinates &&
    normalizedHead &&
    normalizedBase &&
    coordinates.headSha === normalizedHead &&
    coordinates.baseSha === normalizedBase,
  );
}

function timelineHeadAfter(item) {
  if (item?.__typename === "PullRequestCommit") return normalizeSha(item?.commit?.oid);
  if (item?.__typename === "HeadRefForcePushedEvent") {
    return normalizeSha(item?.afterCommit?.oid);
  }
  if (item?.__typename === "HeadRefDeletedEvent") return null;
  return undefined;
}

function evaluateRequestTimeline(snapshot, requestCommentId, expectedHeadSha) {
  const timeline = snapshot?.timelineItems;
  if (timeline?.pageInfo?.hasPreviousPage || timeline?.pageInfo?.hasNextPage) {
    return "Pull-request timeline pagination exceeded the verifier limit; refusing an incomplete result.";
  }

  const items = asArray(timeline?.nodes);
  let headAtRequest = null;
  let observedHead = null;
  let requestIndex = -1;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const nextHead = timelineHeadAfter(item);
    if (nextHead !== undefined) observedHead = nextHead;
    if (item?.__typename === "IssueComment" && item?.id === requestCommentId) {
      requestIndex = index;
      headAtRequest = observedHead;
      break;
    }
  }

  if (requestIndex < 0) {
    return "The triggering review request is not present in the pull-request timeline.";
  }
  if (headAtRequest !== expectedHeadSha) {
    return "The requested head was not the pull-request head when the review request was created.";
  }

  for (const item of items.slice(requestIndex + 1)) {
    if (HEAD_MUTATION_TYPES.has(item?.__typename)) {
      return "The pull-request head changed after the review request was created.";
    }
    if (BASE_MUTATION_TYPES.has(item?.__typename)) {
      return "The pull-request base changed after the review request was created.";
    }
  }
  return null;
}

function successfulBotReaction(comment) {
  const thumbsUp = asArray(comment?.reactionGroups).find((group) => group?.content === "THUMBS_UP");
  if (!thumbsUp) return { matched: false, paginated: false };
  const reactors = thumbsUp.reactors;
  if (reactors?.pageInfo?.hasPreviousPage || reactors?.pageInfo?.hasNextPage) {
    return { matched: false, paginated: true };
  }

  const createdAt = Date.parse(comment?.createdAt ?? "");
  if (!Number.isFinite(createdAt)) return { matched: false, paginated: false };
  const matched = asArray(reactors?.edges).some((edge) => {
    const reactedAt = Date.parse(edge?.reactedAt ?? "");
    return REVIEW_BOT_LOGINS.has(edge?.node?.login) && Number.isFinite(reactedAt) && reactedAt >= createdAt;
  });
  return { matched, paginated: false };
}

export function evaluateExactHeadReview(snapshot) {
  const headSha = normalizeSha(snapshot?.headRefOid);
  const baseSha = normalizeSha(snapshot?.baseRefOid);
  if (!headSha || !baseSha) {
    return resultFor(snapshot, "failure", "Pull request head or base SHA is invalid.");
  }

  const request = snapshot?.requestComment;
  if (!request?.id || request?.pullRequest?.number !== snapshot?.number) {
    return resultFor(snapshot, "failure", "The triggering comment is not attached to this pull request.");
  }
  if (typeof snapshot?.author?.login !== "string" || request?.author?.login !== snapshot.author.login) {
    return resultFor(snapshot, "failure", "Only the pull-request author may create review evidence.");
  }
  if (request.lastEditedAt != null) {
    return resultFor(snapshot, "failure", "The review request was edited; create a new immutable request.");
  }
  if (!reviewRequestMatchesSnapshot(request.body, headSha, baseSha)) {
    return resultFor(
      snapshot,
      "failure",
      "The review request does not name the exact current head and base SHAs.",
    );
  }

  const timelineFailure = evaluateRequestTimeline(snapshot, request.id, headSha);
  if (timelineFailure) return resultFor(snapshot, "failure", timelineFailure);

  const reaction = successfulBotReaction(request);
  if (reaction.paginated) {
    return resultFor(
      snapshot,
      "failure",
      "Codex reaction pagination exceeded the verifier limit; refusing an incomplete result.",
    );
  }
  if (!reaction.matched) {
    return resultFor(
      snapshot,
      "failure",
      `No successful Codex reaction is bound to the immutable request for ${headSha.slice(0, 12)} on ${baseSha.slice(0, 12)}.`,
      { retryable: true },
    );
  }

  return resultFor(
    snapshot,
    "success",
    `Exact-diff Codex review passed for head ${headSha.slice(0, 12)} on base ${baseSha.slice(0, 12)}.`,
  );
}

export async function waitForExactHeadReview({
  attempts = 1,
  delayMs = 15_000,
  loadSnapshot,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
} = {}) {
  if (typeof loadSnapshot !== "function") throw new TypeError("loadSnapshot must be a function");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 40) {
    throw new RangeError("attempts must be an integer from 1 through 40");
  }

  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`Exact-head review evidence attempt ${attempt}/${attempts}`);
    result = evaluateExactHeadReview(await loadSnapshot());
    if (result.conclusion === "success" || !result.retryable || attempt === attempts) return result;
    await sleep(delayMs);
  }
  return result;
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

export async function loadPullRequestSnapshot({
  commentNodeId,
  owner,
  pullRequestNumber,
  repository,
  token,
}) {
  const query = `
    query($owner: String!, $repository: String!, $number: Int!, $commentNodeId: ID!) {
      repository(owner: $owner, name: $repository) {
        pullRequest(number: $number) {
          author { login }
          baseRefOid
          headRefOid
          number
          timelineItems(
            last: 100
            itemTypes: [
              AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT
              BASE_REF_CHANGED_EVENT
              BASE_REF_DELETED_EVENT
              BASE_REF_FORCE_PUSHED_EVENT
              HEAD_REF_DELETED_EVENT
              HEAD_REF_FORCE_PUSHED_EVENT
              HEAD_REF_RESTORED_EVENT
              ISSUE_COMMENT
              PULL_REQUEST_COMMIT
            ]
          ) {
            pageInfo { hasNextPage hasPreviousPage }
            nodes {
              __typename
              ... on HeadRefForcePushedEvent { afterCommit { oid } }
              ... on IssueComment { id }
              ... on PullRequestCommit { commit { oid } }
            }
          }
        }
      }
      requestComment: node(id: $commentNodeId) {
        ... on IssueComment {
          author { login }
          body
          createdAt
          id
          lastEditedAt
          pullRequest { number }
          reactionGroups {
            content
            reactors(first: 100) {
              edges {
                reactedAt
                node {
                  ... on Bot { login }
                  ... on User { login }
                }
              }
              pageInfo { hasNextPage hasPreviousPage }
            }
          }
        }
      }
    }
  `;
  const data = await githubGraphql(token, query, {
    commentNodeId,
    number: pullRequestNumber,
    owner,
    repository,
  });
  const pullRequest = data?.repository?.pullRequest;
  if (!pullRequest) throw new Error("Pull request was not found.");
  return { ...pullRequest, requestComment: data?.requestComment ?? null };
}

export async function loadPullRequestIdentity({ owner, pullRequestNumber, repository, token }) {
  const query = `
    query($owner: String!, $repository: String!, $number: Int!) {
      repository(owner: $owner, name: $repository) {
        pullRequest(number: $number) { baseRefOid headRefOid number }
      }
    }
  `;
  const data = await githubGraphql(token, query, {
    number: pullRequestNumber,
    owner,
    repository,
  });
  const pullRequest = data?.repository?.pullRequest;
  if (!pullRequest) throw new Error("Pull request was not found.");
  return pullRequest;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function booleanEnvironment(name) {
  return (
    String(process.env[name] ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

function writeOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const summaryBase64 = Buffer.from(result.summary, "utf8").toString("base64");
  appendFileSync(
    outputPath,
    `head_sha=${result.headSha ?? ""}\nbase_sha=${result.baseSha ?? ""}\nconclusion=${result.conclusion}\nsummary_base64=${summaryBase64}\n`,
  );
}

async function main() {
  const [owner, repository] = requiredEnvironment("GITHUB_REPOSITORY").split("/");
  if (!owner || !repository) throw new Error("GITHUB_REPOSITORY must be owner/name");
  const pullRequestNumber = Number(requiredEnvironment("CHZZK_PR_NUMBER"));
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("CHZZK_PR_NUMBER must be a positive integer");
  }
  const token = requiredEnvironment("GITHUB_TOKEN");
  let result;

  if (booleanEnvironment("CHZZK_INVALIDATE")) {
    const identity = await loadPullRequestIdentity({
      owner,
      pullRequestNumber,
      repository,
      token,
    });
    const reason = String(process.env.CHZZK_INVALIDATE_REASON ?? "pull-request state changed")
      .trim()
      .slice(0, 160);
    result = resultFor(
      identity,
      "failure",
      `Exact-head review evidence was invalidated because ${reason || "pull-request state changed"}. Create a new immutable review request.`,
    );
  } else {
    const commentNodeId = requiredEnvironment("CHZZK_COMMENT_NODE_ID");
    const attempts = booleanEnvironment("CHZZK_WAIT_FOR_CODEX") ? 40 : 1;
    result = await waitForExactHeadReview({
      attempts,
      loadSnapshot: () =>
        loadPullRequestSnapshot({
          commentNodeId,
          owner,
          pullRequestNumber,
          repository,
          token,
        }),
    });
  }

  writeOutputs(result);
  console.log(JSON.stringify(result));
  if (result.conclusion !== "success") process.exitCode = 1;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`Exact-head review verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
