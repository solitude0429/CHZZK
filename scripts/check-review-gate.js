#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  changedFilePaths,
  cleanReviewCommitMarker,
  evaluateReviewCompletion,
  hasExactHeadReviewerApproval,
  isPendingReviewGateError,
  requiresAutomatedSecurityReview,
} from "./lib/review-gate.js";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const API_HEADERS = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"];

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function getJson(endpoint, label) {
  return parseJson(gh(["api", "--method", "GET", ...API_HEADERS, endpoint]), label);
}

function paginatedArrays(endpoint, label) {
  const pages = parseJson(
    gh(["api", "--method", "GET", ...API_HEADERS, "--paginate", "--slurp", endpoint]),
    label,
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} did not return paginated arrays`);
  }
  return pages.flat();
}

function listReviewThreads(repository, pullNumber, expectedHeadSha) {
  const [owner, name] = repository.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          headRefOid
          reviewThreads(first: 100, after: $after) {
            nodes { id isResolved }
            pageInfo { endCursor hasNextPage }
          }
        }
      }
    }
  `;
  const threads = [];
  let after = null;
  for (let page = 0; page < 100; page += 1) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${pullNumber}`,
    ];
    if (after !== null) args.push("-f", `after=${after}`);
    const response = parseJson(gh(args), "Review-thread query");
    const pullRequest = response?.data?.repository?.pullRequest;
    const connection = pullRequest?.reviewThreads;
    if (String(pullRequest?.headRefOid ?? "").toLowerCase() !== expectedHeadSha) {
      throw new Error("Review-thread query is stale for the current pull request head");
    }
    if (!Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("Review-thread query exposes no usable completion state");
    }
    threads.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return threads;
    if (typeof connection.pageInfo.endCursor !== "string" || !connection.pageInfo.endCursor) {
      throw new Error("Review-thread query pagination cursor is missing");
    }
    after = connection.pageInfo.endCursor;
  }
  throw new Error("Review-thread query exceeded the pagination limit");
}

function containsFullSha(body, headSha) {
  if (typeof body !== "string") return false;
  const lowerBody = body.toLowerCase();
  const index = lowerBody.indexOf(headSha);
  if (index < 0) return false;
  return (
    !/[a-f0-9]/.test(lowerBody[index - 1] ?? "") && !/[a-f0-9]/.test(lowerBody[index + headSha.length] ?? "")
  );
}

function reviewerAppIdentity(automatedReviewLogin) {
  const login = String(automatedReviewLogin ?? "").toLowerCase();
  if (!login.endsWith("[bot]")) return null;
  const slug = login.slice(0, -"[bot]".length);
  if (!GITHUB_APP_SLUG_RE.test(slug)) {
    throw new Error("Automated reviewer GitHub App slug is missing or malformed");
  }
  const app = getJson(`apps/${encodeURIComponent(slug)}`, "Automated reviewer GitHub App lookup");
  if (app?.slug !== slug || !Number.isSafeInteger(app.id) || app.id < 1) {
    throw new Error("Automated reviewer GitHub App identity is missing or malformed");
  }
  return { id: app.id, slug: app.slug };
}

function listCommentEvidence(repository, pullNumber, headSha, releaseOperatorLogin, automatedReviewLogin) {
  const comments = paginatedArrays(
    `repos/${repository}/issues/${pullNumber}/comments?per_page=100`,
    "Pull request comment listing",
  );
  const operatorLogin = String(releaseOperatorLogin ?? "").toLowerCase();
  const reviewerLogin = String(automatedReviewLogin ?? "").toLowerCase();
  let latestIssueCommentId = 0;
  for (const comment of comments) {
    if (!Number.isSafeInteger(comment?.id) || comment.id < 1) {
      throw new Error("Pull request comment identity is missing or malformed");
    }
    latestIssueCommentId = Math.max(latestIssueCommentId, comment.id);
  }
  const requests = comments
    .filter(
      (comment) =>
        String(comment?.user?.login ?? "").toLowerCase() === operatorLogin &&
        containsFullSha(comment?.body, headSha),
    )
    .map((comment) => ({
      ...comment,
      reactions: paginatedArrays(
        `repos/${repository}/issues/comments/${comment.id}/reactions?per_page=100`,
        "Review-request comment reaction listing",
      ),
    }));
  const cleanReviewComments = [];
  for (const comment of comments) {
    if (String(comment?.user?.login ?? "").toLowerCase() !== reviewerLogin) continue;
    const marker = cleanReviewCommitMarker(comment.body);
    if (marker === null || !headSha.startsWith(marker)) continue;
    const commit = getJson(`repos/${repository}/commits/${marker}`, "Clean-review commit resolution");
    const resolvedCommitSha = String(commit?.sha ?? "").toLowerCase();
    if (!FULL_GIT_SHA_RE.test(resolvedCommitSha)) {
      throw new Error("Clean-review commit resolution is missing or malformed");
    }
    cleanReviewComments.push({ ...comment, resolved_commit_sha: resolvedCommitSha });
  }
  return {
    automatedReviewApp: cleanReviewComments.length > 0 ? reviewerAppIdentity(automatedReviewLogin) : null,
    cleanReviewComments,
    commentSnapshot: comments
      .map((comment) => ({
        body: comment.body,
        created_at: comment.created_at,
        id: comment.id,
        performed_via_github_app:
          comment.performed_via_github_app == null
            ? null
            : {
                id: comment.performed_via_github_app.id,
                slug: comment.performed_via_github_app.slug,
              },
        updated_at: comment.updated_at,
        user: {
          id: comment.user?.id,
          login: comment.user?.login,
          type: comment.user?.type,
        },
      }))
      .sort((left, right) => left.id - right.id),
    latestIssueCommentId,
    reviewRequestComments: requests,
  };
}

function normalizedReactions(comments) {
  return comments
    .map((comment) => ({
      id: comment.id,
      reactions: comment.reactions
        .map((reaction) => ({
          content: reaction.content,
          created_at: reaction.created_at,
          id: reaction.id,
          user: {
            id: reaction.user?.id,
            login: reaction.user?.login,
            type: reaction.user?.type,
          },
        }))
        .sort((left, right) => left.id - right.id),
    }))
    .sort((left, right) => left.id - right.id);
}

function reviewEvidenceFingerprint(evidence) {
  return JSON.stringify({
    automatedReviewApp: evidence.automatedReviewApp,
    cleanReviewComments: evidence.cleanReviewComments.map((comment) => ({
      id: comment.id,
      resolved_commit_sha: comment.resolved_commit_sha,
    })),
    commentSnapshot: evidence.commentSnapshot,
    latestIssueCommentId: evidence.latestIssueCommentId,
    reactions: normalizedReactions(evidence.reviewRequestComments),
    reviews: evidence.reviews
      .map((review) => ({
        commit_id: review.commit_id,
        id: review.id,
        state: review.state,
        submitted_at: review.submitted_at,
        user: {
          id: review.user?.id,
          login: review.user?.login,
          type: review.user?.type,
        },
      }))
      .sort((left, right) => left.id - right.id),
    reviewThreads: evidence.reviewThreads
      .map((thread) => ({ id: thread.id, isResolved: thread.isResolved }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
  });
}

function pullRequestFingerprint(pullRequest) {
  return JSON.stringify({
    baseSha: String(pullRequest?.base?.sha ?? "").toLowerCase(),
    draft: pullRequest?.draft,
    headSha: String(pullRequest?.head?.sha ?? "").toLowerCase(),
    labels: Array.isArray(pullRequest?.labels) ? pullRequest.labels.map((label) => label?.name).sort() : null,
    state: pullRequest?.state,
    updatedAt: pullRequest?.updated_at,
  });
}

function pendingCollectionRace(message) {
  const error = new Error(message);
  error.code = "REVIEW_GATE_PENDING";
  throw error;
}

function collectReviewEvidence(repository, pullNumber, headSha) {
  const reviews = paginatedArrays(
    `repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`,
    "Pull request review listing",
  );
  const reviewThreads = listReviewThreads(repository, pullNumber, headSha);
  const exactApproval = hasExactHeadReviewerApproval({
    automatedReviewLogin: process.env.CHZZK_AUTOMATED_REVIEW_LOGIN,
    headSha,
    reviews,
  });
  const commentEvidence = exactApproval
    ? {
        automatedReviewApp: null,
        cleanReviewComments: [],
        commentSnapshot: [],
        latestIssueCommentId: 0,
        reviewRequestComments: [],
      }
    : listCommentEvidence(
        repository,
        pullNumber,
        headSha,
        process.env.CHZZK_RELEASE_OPERATOR_LOGIN,
        process.env.CHZZK_AUTOMATED_REVIEW_LOGIN,
      );
  return { ...commentEvidence, reviews, reviewThreads };
}

function integerEnvironment(name, { defaultValue, maximum, minimum }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function writeOutputs({ description, headSha, required, state }) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const safeHeadSha = FULL_GIT_SHA_RE.test(String(headSha ?? "")) ? headSha : "";
  const safeRequired = required === false ? false : true;
  const safeState = state === "success" ? "success" : "failure";
  const safeDescription = String(description ?? "review completion gate failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `description=${safeDescription}`,
      `head_sha=${safeHeadSha}`,
      `required=${safeRequired}`,
      `state=${safeState}`,
      "",
    ].join("\n"),
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const pullNumber = Number(process.env.CHZZK_PR_NUMBER);
  const expectedHeadSha = String(process.env.CHZZK_EXPECTED_HEAD_SHA ?? "").toLowerCase();
  if (!REPOSITORY_RE.test(String(repository ?? ""))) throw new Error("GITHUB_REPOSITORY is invalid");
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error("Pull request number is invalid");
  if (expectedHeadSha && !FULL_GIT_SHA_RE.test(expectedHeadSha)) {
    throw new Error("Expected pull request head SHA is invalid");
  }
  const pollSeconds = integerEnvironment("CHZZK_POLL_SECONDS", {
    defaultValue: 0,
    maximum: 300,
    minimum: 0,
  });
  const pollIntervalSeconds = integerEnvironment("CHZZK_POLL_INTERVAL_SECONDS", {
    defaultValue: 15,
    maximum: 60,
    minimum: 5,
  });
  const deadline = Date.now() + pollSeconds * 1000;

  let currentHeadSha = "";
  let lastError;
  do {
    try {
      let pullRequest = getJson(`repos/${repository}/pulls/${pullNumber}`, "Pull request lookup");
      currentHeadSha = String(pullRequest?.head?.sha ?? "").toLowerCase();
      const currentBaseSha = String(pullRequest?.base?.sha ?? "").toLowerCase();
      if (!FULL_GIT_SHA_RE.test(currentBaseSha)) {
        throw new Error("Pull request base SHA is missing or malformed");
      }
      const files = changedFilePaths(
        paginatedArrays(
          `repos/${repository}/pulls/${pullNumber}/files?per_page=100`,
          "Pull request changed-file listing",
        ),
      );
      let labels = Array.isArray(pullRequest.labels) ? pullRequest.labels.map((label) => label?.name) : null;
      const forceReview = process.env.CHZZK_FORCE_REVIEW === "true";
      const required = requiresAutomatedSecurityReview({ files, forceReview, labels });
      let evidence = {
        automatedReviewApp: undefined,
        cleanReviewComments: undefined,
        latestIssueCommentId: undefined,
        reviewRequestComments: undefined,
        reviews: [],
        reviewThreads: [],
      };
      if (required) {
        const firstEvidence = collectReviewEvidence(repository, pullNumber, currentHeadSha);
        const middlePullRequest = getJson(
          `repos/${repository}/pulls/${pullNumber}`,
          "Intermediate pull request lookup",
        );
        evidence = collectReviewEvidence(repository, pullNumber, currentHeadSha);
        const finalPullRequest = getJson(
          `repos/${repository}/pulls/${pullNumber}`,
          "Final pull request lookup",
        );
        if (
          String(finalPullRequest?.head?.sha ?? "").toLowerCase() !== currentHeadSha ||
          String(finalPullRequest?.base?.sha ?? "").toLowerCase() !== currentBaseSha ||
          pullRequestFingerprint(middlePullRequest) !== pullRequestFingerprint(finalPullRequest) ||
          reviewEvidenceFingerprint(firstEvidence) !== reviewEvidenceFingerprint(evidence)
        ) {
          pendingCollectionRace("Pull request review evidence changed while it was collected");
        }
        pullRequest = finalPullRequest;
        labels = Array.isArray(pullRequest.labels) ? pullRequest.labels.map((label) => label?.name) : null;
      } else {
        const finalPullRequest = getJson(
          `repos/${repository}/pulls/${pullNumber}`,
          "Final pull request lookup",
        );
        if (
          String(finalPullRequest?.head?.sha ?? "").toLowerCase() !== currentHeadSha ||
          String(finalPullRequest?.base?.sha ?? "").toLowerCase() !== currentBaseSha
        ) {
          pendingCollectionRace("Pull request changed while it was collected");
        }
        pullRequest = finalPullRequest;
        labels = Array.isArray(pullRequest.labels) ? pullRequest.labels.map((label) => label?.name) : null;
      }
      const result = evaluateReviewCompletion({
        automatedReviewApp: evidence.automatedReviewApp,
        automatedReviewLogin: process.env.CHZZK_AUTOMATED_REVIEW_LOGIN,
        cleanReviewComments: evidence.cleanReviewComments,
        expectedHeadSha,
        files,
        forceReview,
        latestIssueCommentId: evidence.latestIssueCommentId,
        labels,
        pullRequest,
        releaseOperatorLogin: process.env.CHZZK_RELEASE_OPERATOR_LOGIN,
        reviews: evidence.reviews,
        reviewRequestComments: evidence.reviewRequestComments,
        reviewThreads: evidence.reviewThreads,
      });
      writeOutputs(result);
      console.log(JSON.stringify(result));
      return { currentHeadSha };
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (!isPendingReviewGateError(error) || remaining <= 0) break;
      console.log(`Review evidence is pending; re-evaluating in ${pollIntervalSeconds} seconds`);
      await wait(Math.min(pollIntervalSeconds * 1000, remaining));
    }
  } while (Date.now() <= deadline);
  const error = lastError ?? new Error("Review completion gate failed without a result");
  error.currentHeadSha = currentHeadSha;
  throw error;
}

try {
  await main();
} catch (error) {
  try {
    writeOutputs({
      description: error.message,
      headSha: error.currentHeadSha ?? "",
      required: true,
      state: "failure",
    });
  } catch (outputError) {
    console.error(`Review completion gate output failed: ${outputError.message}`);
  }
  console.error(`Review completion gate failed: ${error.message}`);
  process.exitCode = 1;
}
