#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { evaluateReviewCompletion, requiresAutomatedSecurityReview } from "./lib/review-gate.js";

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;

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

function paginatedArrays(endpoint, label) {
  const pages = parseJson(gh(["api", "--method", "GET", "--paginate", "--slurp", endpoint]), label);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} did not return paginated arrays`);
  }
  return pages.flat();
}

function listCheckRuns(repository, headSha) {
  const pages = parseJson(
    gh([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      `repos/${repository}/commits/${headSha}/check-runs?per_page=100&filter=latest`,
    ]),
    "Check-run listing",
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.check_runs))) {
    throw new Error("Check-run listing did not return complete paginated results");
  }
  return pages.flatMap((page) => page.check_runs);
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
    if (pullRequest?.headRefOid !== expectedHeadSha) {
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

let currentHeadSha = "";
try {
  const repository = process.env.GITHUB_REPOSITORY;
  const pullNumber = Number(process.env.CHZZK_PR_NUMBER);
  const expectedHeadSha = String(process.env.CHZZK_EXPECTED_HEAD_SHA ?? "").toLowerCase();
  if (!REPOSITORY_RE.test(String(repository ?? ""))) throw new Error("GITHUB_REPOSITORY is invalid");
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error("Pull request number is invalid");
  if (expectedHeadSha && !FULL_GIT_SHA_RE.test(expectedHeadSha)) {
    throw new Error("Expected pull request head SHA is invalid");
  }

  const pullRequest = parseJson(
    gh(["api", "--method", "GET", `repos/${repository}/pulls/${pullNumber}`]),
    "Pull request lookup",
  );
  currentHeadSha = String(pullRequest?.head?.sha ?? "").toLowerCase();
  const files = paginatedArrays(
    `repos/${repository}/pulls/${pullNumber}/files?per_page=100`,
    "Pull request changed-file listing",
  ).map((file) => file?.filename);
  const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels.map((label) => label?.name) : null;
  const forceReview = process.env.CHZZK_FORCE_REVIEW === "true";
  const required = requiresAutomatedSecurityReview({ files, forceReview, labels });
  const checkRuns = required ? listCheckRuns(repository, currentHeadSha) : [];
  const reviewThreads = required ? listReviewThreads(repository, pullNumber, currentHeadSha) : [];
  const result = evaluateReviewCompletion({
    checkRuns,
    expectedHeadSha,
    files,
    forceReview,
    labels,
    pullRequest,
    reviewAppSlug: process.env.CHZZK_REVIEW_APP_SLUG,
    reviewCheckName: process.env.CHZZK_REVIEW_CHECK_NAME,
    reviewThreads,
  });
  writeOutputs(result);
  console.log(JSON.stringify(result));
} catch (error) {
  try {
    writeOutputs({
      description: error.message,
      headSha: currentHeadSha,
      required: true,
      state: "failure",
    });
  } catch (outputError) {
    console.error(`Review completion gate output failed: ${outputError.message}`);
  }
  console.error(`Review completion gate failed: ${error.message}`);
  process.exitCode = 1;
}
