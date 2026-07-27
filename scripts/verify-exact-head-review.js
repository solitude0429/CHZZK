#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REVIEW_BOT_LOGINS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);
const SUCCESS_RE = /Codex Review:\s*Didn['’]t find any major issues/i;
const REVIEWED_COMMIT_RE = /Reviewed commit:\*?\*?\s*`?([a-f0-9]{7,40})`?/i;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function reviewedCommit(body) {
  if (typeof body !== "string") return null;
  return body.match(REVIEWED_COMMIT_RE)?.[1]?.toLowerCase() ?? null;
}

export function evidenceMatchesHead(body, headSha) {
  if (typeof body !== "string" || typeof headSha !== "string") return false;
  if (!SUCCESS_RE.test(body)) return false;
  const reviewed = reviewedCommit(body);
  return Boolean(reviewed && headSha.toLowerCase().startsWith(reviewed));
}

export function evaluateExactHeadReview(snapshot) {
  const headSha = String(snapshot?.headRefOid ?? "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(headSha)) {
    return {
      conclusion: "failure",
      headSha: null,
      summary: "Pull request head SHA is invalid.",
    };
  }
  if (snapshot?.isDraft === true) {
    return {
      conclusion: "failure",
      headSha,
      summary: "Pull request is still a draft.",
    };
  }

  const threadConnection = snapshot?.reviewThreads;
  if (threadConnection?.pageInfo?.hasNextPage) {
    return {
      conclusion: "failure",
      headSha,
      summary: "Review thread pagination exceeded the verifier limit; refusing an incomplete result.",
    };
  }
  const unresolved = asArray(threadConnection?.nodes).filter((thread) => thread?.isResolved !== true);
  if (unresolved.length > 0) {
    return {
      conclusion: "failure",
      headSha,
      summary: `${unresolved.length} unresolved review thread(s) remain.`,
    };
  }

  for (const connection of [snapshot?.comments, snapshot?.reviews]) {
    const pageInfo = connection?.pageInfo;
    if (pageInfo?.hasPreviousPage || pageInfo?.hasNextPage) {
      return {
        conclusion: "failure",
        headSha,
        summary: "Review evidence pagination exceeded the verifier limit; refusing an incomplete result.",
      };
    }
  }

  const candidates = [...asArray(snapshot?.comments?.nodes), ...asArray(snapshot?.reviews?.nodes)];
  const exactEvidence = candidates.find(
    (entry) => REVIEW_BOT_LOGINS.has(entry?.author?.login) && evidenceMatchesHead(entry?.body, headSha),
  );
  if (!exactEvidence) {
    return {
      conclusion: "failure",
      headSha,
      summary: `No successful Codex review evidence names the exact current head ${headSha.slice(0, 12)}.`,
    };
  }

  return {
    conclusion: "success",
    headSha,
    summary: `Exact-head Codex review passed for ${headSha.slice(0, 12)} with zero unresolved threads.`,
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
          headRefOid
          isDraft
          comments(last: 100) {
            pageInfo { hasNextPage hasPreviousPage }
            nodes { author { login } body createdAt }
          }
          reviews(last: 100) {
            pageInfo { hasNextPage hasPreviousPage }
            nodes { author { login } body submittedAt }
          }
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes { isResolved }
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

function writeOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const summaryBase64 = Buffer.from(result.summary, "utf8").toString("base64");
  appendFileSync(
    outputPath,
    `head_sha=${result.headSha ?? ""}\nconclusion=${result.conclusion}\nsummary_base64=${summaryBase64}\n`,
  );
}

async function main() {
  const [owner, repository] = requiredEnvironment("GITHUB_REPOSITORY").split("/");
  if (!owner || !repository) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  const pullRequestNumber = Number(requiredEnvironment("CHZZK_PR_NUMBER"));
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("CHZZK_PR_NUMBER must be a positive integer");
  }
  const token = requiredEnvironment("GITHUB_TOKEN");
  const snapshot = await loadPullRequestSnapshot({
    owner,
    pullRequestNumber,
    repository,
    token,
  });
  const result = evaluateExactHeadReview(snapshot);
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
