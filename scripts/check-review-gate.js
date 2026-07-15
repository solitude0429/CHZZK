#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  evaluateReviewCompletion,
  hasExactHeadReviewerReview,
  isPendingReviewGateError,
  requiresAutomatedSecurityReview,
} from "./lib/review-gate.js";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
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
            nodes { isResolved }
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

function listReviewRequestComments(repository, pullNumber, headSha, releaseOperatorLogin) {
  const comments = paginatedArrays(
    `repos/${repository}/issues/${pullNumber}/comments?per_page=100`,
    "Pull request comment listing",
  );
  const operatorLogin = String(releaseOperatorLogin ?? "").toLowerCase();
  const requests = comments.filter(
    (comment) =>
      String(comment?.user?.login ?? "").toLowerCase() === operatorLogin &&
      containsFullSha(comment?.body, headSha),
  );
  return requests.map((comment) => {
    if (!Number.isSafeInteger(comment.id) || comment.id < 1) {
      throw new Error("Review-request comment identity is missing or malformed");
    }
    return {
      ...comment,
      reactions: paginatedArrays(
        `repos/${repository}/issues/comments/${comment.id}/reactions?per_page=100`,
        "Review-request comment reaction listing",
      ),
    };
  });
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
      const pullRequest = getJson(`repos/${repository}/pulls/${pullNumber}`, "Pull request lookup");
      currentHeadSha = String(pullRequest?.head?.sha ?? "").toLowerCase();
      const files = paginatedArrays(
        `repos/${repository}/pulls/${pullNumber}/files?per_page=100`,
        "Pull request changed-file listing",
      ).map((file) => file?.filename);
      const labels = Array.isArray(pullRequest.labels)
        ? pullRequest.labels.map((label) => label?.name)
        : null;
      const forceReview = process.env.CHZZK_FORCE_REVIEW === "true";
      const required = requiresAutomatedSecurityReview({ files, forceReview, labels });
      let reviews = [];
      let reviewThreads = [];
      let headCommit;
      let reviewRequestComments;
      if (required) {
        reviews = paginatedArrays(
          `repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`,
          "Pull request review listing",
        );
        reviewThreads = listReviewThreads(repository, pullNumber, currentHeadSha);
        const exactReview = hasExactHeadReviewerReview({
          automatedReviewLogin: process.env.CHZZK_AUTOMATED_REVIEW_LOGIN,
          headSha: currentHeadSha,
          reviews,
        });
        if (!exactReview) {
          headCommit = getJson(`repos/${repository}/commits/${currentHeadSha}`, "Head commit lookup");
          reviewRequestComments = listReviewRequestComments(
            repository,
            pullNumber,
            currentHeadSha,
            process.env.CHZZK_RELEASE_OPERATOR_LOGIN,
          );
        }
      }
      const result = evaluateReviewCompletion({
        automatedReviewLogin: process.env.CHZZK_AUTOMATED_REVIEW_LOGIN,
        expectedHeadSha,
        files,
        forceReview,
        headCommit,
        labels,
        pullRequest,
        releaseOperatorLogin: process.env.CHZZK_RELEASE_OPERATOR_LOGIN,
        reviews,
        reviewRequestComments,
        reviewThreads,
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
