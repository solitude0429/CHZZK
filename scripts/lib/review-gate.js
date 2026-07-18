const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const REVIEWED_COMMIT_PREFIX_RE = /^[a-f0-9]{10,40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const GITHUB_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
const KNOWN_REVIEW_STATES = new Set([...DECISIVE_REVIEW_STATES, "DISMISSED", "PENDING"]);
const EXPLICIT_REVIEW_LABELS = new Set(["release-review-required", "security-review-required"]);
const CLEAN_REVIEW_HEADING = "Codex Review: Didn't find any major issues. :rocket:";
const CLEAN_REVIEW_INFO_FOOTER = [
  "<details> <summary>ℹ️ About Codex in GitHub</summary>",
  "<br/>",
  "",
  "[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you",
  "- Open a pull request for review",
  "- Mark a draft as ready",
  '- Comment "@codex review".',
  "",
  "If Codex has suggestions, it will comment; otherwise it will react with 👍.",
  "",
  "",
  "",
  "",
  'Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".',
  "            ",
  "</details>",
].join("\n");
const PACKAGED_RUNTIME_PATHS = new Set([
  "background.js",
  "diagnostics.html",
  "diagnostics.js",
  "icon-32.png",
  "icon-48.png",
  "icon-96.png",
  "icon.png",
  "manifest.json",
  "site-observer.js",
]);

function isSensitivePath(path) {
  return (
    path.startsWith(".github/") ||
    path.startsWith("scripts/") ||
    path.startsWith("policy/") ||
    path.startsWith("src/") ||
    path.startsWith("tests/") ||
    PACKAGED_RUNTIME_PATHS.has(path) ||
    path === ".npmrc" ||
    path === "README.md" ||
    path.startsWith("docs/") ||
    path === "package.json" ||
    path === "package-lock.json"
  );
}

function normalizeLogin(value, label) {
  if (typeof value !== "string" || value !== value.trim() || !GITHUB_LOGIN_RE.test(value)) {
    throw new Error(`${label} is missing or malformed`);
  }
  return value.toLowerCase();
}

function timestampMilliseconds(value, label) {
  if (typeof value !== "string" || !GITHUB_TIMESTAMP_RE.test(value)) {
    throw new Error(`${label} is missing or malformed`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`
  ) {
    throw new Error(`${label} is missing or malformed`);
  }
  return milliseconds;
}

function pending(message) {
  const error = new Error(message);
  error.code = "REVIEW_GATE_PENDING";
  throw error;
}

export function isPendingReviewGateError(error) {
  return error?.code === "REVIEW_GATE_PENDING";
}

export function changedFilePaths(changedFiles) {
  if (!Array.isArray(changedFiles)) throw new Error("Pull request changed-file response is missing");
  const paths = [];
  const seen = new Set();
  for (const file of changedFiles) {
    if (!file || typeof file !== "object" || typeof file.filename !== "string" || !file.filename) {
      throw new Error("Pull request changed-file entry is missing or malformed");
    }
    const previousPath = file.previous_filename;
    if (previousPath !== undefined && (typeof previousPath !== "string" || !previousPath)) {
      throw new Error("Pull request previous filename is malformed");
    }
    if (file.status === "renamed" && !previousPath) {
      throw new Error("Renamed pull request file is missing its previous filename");
    }
    for (const path of [file.filename, previousPath]) {
      if (path && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

export function requiresAutomatedSecurityReview({ files, forceReview = false, labels }) {
  if (!Array.isArray(files) || files.some((path) => typeof path !== "string" || !path)) {
    throw new Error("Pull request changed-file list is missing or malformed");
  }
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || !label)) {
    throw new Error("Pull request label list is missing or malformed");
  }
  return (
    forceReview === true ||
    labels.some((label) => EXPLICIT_REVIEW_LABELS.has(label.toLowerCase())) ||
    files.some(isSensitivePath)
  );
}

function assertCurrentPullRequest(pullRequest, expectedHeadSha) {
  if (!pullRequest || typeof pullRequest !== "object" || !Number.isSafeInteger(pullRequest.number)) {
    throw new Error("Pull request identity is missing or malformed");
  }
  if (pullRequest.state !== "open") throw new Error("Review completion gate requires an open pull request");
  if (pullRequest.draft !== false)
    throw new Error("Review completion gate cannot pass for a draft pull request");
  const headSha = String(pullRequest.head?.sha ?? "").toLowerCase();
  if (!FULL_GIT_SHA_RE.test(headSha)) throw new Error("Pull request head SHA is missing or malformed");
  if (expectedHeadSha && expectedHeadSha.toLowerCase() !== headSha) {
    throw new Error("Review gate event is stale for the current pull request head");
  }
  return headSha;
}

export function assertStablePullRequestSnapshot({ before, after, expectedHeadSha = "" }) {
  const normalizedExpectedHeadSha = String(expectedHeadSha ?? "").toLowerCase();
  if (normalizedExpectedHeadSha && !FULL_GIT_SHA_RE.test(normalizedExpectedHeadSha)) {
    throw new Error("Expected stable pull request head SHA is malformed");
  }
  const beforeHeadSha = assertCurrentPullRequest(before, "");
  const afterHeadSha = assertCurrentPullRequest(after, "");
  const beforeActivityTimestamp = pullRequestActivityTimestamp(before);
  const afterActivityTimestamp = pullRequestActivityTimestamp(after);
  if (
    beforeHeadSha !== afterHeadSha ||
    (normalizedExpectedHeadSha && beforeHeadSha !== normalizedExpectedHeadSha) ||
    beforeActivityTimestamp !== afterActivityTimestamp
  ) {
    pending("Pull request review state changed during evidence collection");
  }
  return afterHeadSha;
}

function canonicalSnapshotJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSnapshotJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSnapshotJson(value[key])}`)
    .join(",")}}`;
}

function pullRequestSnapshotIdentity(pullRequest) {
  const headSha = assertCurrentPullRequest(pullRequest, "");
  const labels = pullRequest.labels;
  if (!Array.isArray(labels) || labels.some((label) => typeof label?.name !== "string" || !label.name)) {
    throw new Error("Pull request snapshot label state is missing or malformed");
  }
  return {
    draft: pullRequest.draft,
    headSha,
    labels: labels.map((label) => label.name).sort(),
    number: pullRequest.number,
    state: pullRequest.state,
    updatedAt: pullRequestActivityTimestamp(pullRequest),
  };
}

function reviewEvidenceSnapshotIdentity(snapshot, label, expectedHeadSha) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`${label} review evidence snapshot is missing or malformed`);
  }
  const headSha = assertStablePullRequestSnapshot({
    after: snapshot.pullRequestAfter,
    before: snapshot.pullRequestBefore,
    expectedHeadSha,
  });
  for (const [field, fieldLabel] of [
    ["issueComments", "issue-comment"],
    ["reviewRequestComments", "review-request comment"],
    ["reviewerCompletionComments", "reviewer completion-comment"],
    ["reviews", "review"],
    ["reviewThreads", "review-thread"],
  ]) {
    if (!Array.isArray(snapshot[field])) {
      throw new Error(`${label} ${fieldLabel} snapshot is missing or malformed`);
    }
  }
  return {
    headSha,
    identity: canonicalSnapshotJson({
      issueComments: snapshot.issueComments,
      pullRequest: pullRequestSnapshotIdentity(snapshot.pullRequestAfter),
      reviewRequestComments: snapshot.reviewRequestComments,
      reviewerCompletionComments: snapshot.reviewerCompletionComments,
      reviews: snapshot.reviews,
      reviewThreads: snapshot.reviewThreads,
    }),
  };
}

export function assertStableReviewEvidenceSnapshots({ before, after, expectedHeadSha = "" }) {
  const normalizedExpectedHeadSha = String(expectedHeadSha ?? "").toLowerCase();
  if (normalizedExpectedHeadSha && !FULL_GIT_SHA_RE.test(normalizedExpectedHeadSha)) {
    throw new Error("Expected stable review-evidence head SHA is malformed");
  }
  const beforeIdentity = reviewEvidenceSnapshotIdentity(before, "Initial", normalizedExpectedHeadSha);
  const afterIdentity = reviewEvidenceSnapshotIdentity(after, "Repeated", normalizedExpectedHeadSha);
  if (
    beforeIdentity.headSha !== afterIdentity.headSha ||
    beforeIdentity.identity !== afterIdentity.identity
  ) {
    pending("Pull request review evidence changed during repeated collection");
  }
  return afterIdentity.headSha;
}

function assertNoUnresolvedThreads(reviewThreads) {
  if (!Array.isArray(reviewThreads)) throw new Error("Pull request review-thread response is missing");
  if (reviewThreads.some((thread) => typeof thread?.isResolved !== "boolean")) {
    throw new Error("Pull request review-thread completion state is unknown");
  }
  const unresolved = reviewThreads.filter((thread) => !thread.isResolved);
  if (unresolved.length > 0) {
    pending(`Pull request has ${unresolved.length} unresolved actionable review thread(s)`);
  }
}

function exactHeadReviewerEvidence({ automatedReviewLogin, headSha, reviews }) {
  const reviewerLogin = normalizeLogin(automatedReviewLogin, "Automated reviewer login");
  const normalizedHeadSha = String(headSha ?? "").toLowerCase();
  if (!FULL_GIT_SHA_RE.test(normalizedHeadSha)) {
    throw new Error("Review comparison head SHA is missing or malformed");
  }
  if (!Array.isArray(reviews)) throw new Error("Automated reviewer review response is missing");

  let latest = null;
  for (const review of reviews) {
    const actorLogin = normalizeLogin(review?.user?.login, "Review actor identity");
    if (actorLogin !== reviewerLogin) continue;
    if (typeof review.state !== "string" || !KNOWN_REVIEW_STATES.has(review.state)) {
      throw new Error("Automated reviewer review state is missing or malformed");
    }
    if (!DECISIVE_REVIEW_STATES.has(review.state)) continue;
    const reviewCommitId = String(review.commit_id ?? "").toLowerCase();
    if (!FULL_GIT_SHA_RE.test(reviewCommitId)) {
      throw new Error("Automated reviewer review commit identity is missing or malformed");
    }
    const submittedAt = timestampMilliseconds(review.submitted_at, "Automated reviewer review timestamp");
    if (reviewCommitId !== normalizedHeadSha) continue;
    if (
      latest === null ||
      submittedAt > latest.submittedAt ||
      (submittedAt === latest.submittedAt && review.state !== "APPROVED")
    ) {
      latest = { state: review.state, submittedAt };
    }
  }
  return latest;
}

export function hasExactHeadReviewerApproval(input) {
  return exactHeadReviewerEvidence(input)?.state === "APPROVED";
}

function pullRequestActivityTimestamp(pullRequest) {
  return timestampMilliseconds(pullRequest?.updated_at, "Pull request activity timestamp");
}

function fullShaAppearsInComment(body, headSha) {
  if (typeof body !== "string") return false;
  const lowerBody = body.toLowerCase();
  const index = lowerBody.indexOf(headSha);
  if (index < 0) return false;
  const before = lowerBody[index - 1] ?? "";
  const after = lowerBody[index + headSha.length] ?? "";
  return !/[a-f0-9]/.test(before) && !/[a-f0-9]/.test(after);
}

function boundReviewRequests({ headSha, releaseOperatorLogin, reviewRequestComments }) {
  const operatorLogin = normalizeLogin(releaseOperatorLogin, "Release operator login");
  if (!Array.isArray(reviewRequestComments)) {
    throw new Error("Operator review-request comment response is missing");
  }

  const requests = [];
  for (const comment of reviewRequestComments) {
    const authorLogin = normalizeLogin(comment?.user?.login, "Review-request comment author identity");
    if (authorLogin !== operatorLogin || !fullShaAppearsInComment(comment.body, headSha)) continue;
    const commentCreatedTimestamp = timestampMilliseconds(
      comment.created_at,
      "Review-request comment creation timestamp",
    );
    const commentUpdatedTimestamp = timestampMilliseconds(
      comment.updated_at,
      "Review-request comment update timestamp",
    );
    if (commentUpdatedTimestamp < commentCreatedTimestamp) {
      throw new Error("Review-request comment timestamps are malformed");
    }
    requests.push({ comment, updatedTimestamp: commentUpdatedTimestamp });
  }
  return requests;
}

function cleanReviewCommitPrefix(body) {
  if (typeof body !== "string") return null;
  const normalizedBody = body.endsWith("\n") ? body.slice(0, -1) : body;
  const prefixMatch = normalizedBody.match(
    /^Codex Review: Didn't find any major issues\. :rocket:\n\n\*\*Reviewed commit:\*\* `([a-f0-9]{10,40})`/,
  );
  if (!prefixMatch || !REVIEWED_COMMIT_PREFIX_RE.test(prefixMatch[1])) return null;
  const core = `${CLEAN_REVIEW_HEADING}\n\n**Reviewed commit:** \`${prefixMatch[1]}\``;
  if (normalizedBody !== core && normalizedBody !== `${core}\n\n${CLEAN_REVIEW_INFO_FOOTER}`) {
    return null;
  }
  return prefixMatch[1];
}

function hasBoundCleanReviewComment({
  boundRequests,
  headSha,
  headTimestamp,
  reviewEvidenceTimestamp,
  reviewerCompletionComments,
  reviewerLogin,
}) {
  if (!Array.isArray(reviewerCompletionComments)) {
    throw new Error("Automated reviewer completion-comment response is missing");
  }
  if (boundRequests.length === 0) return false;

  const latestRequestTimestamp = Math.max(...boundRequests.map(({ updatedTimestamp }) => updatedTimestamp));
  let latestReviewerComment = null;
  for (const comment of reviewerCompletionComments) {
    const actorLogin = normalizeLogin(comment?.user?.login, "Reviewer completion-comment actor identity");
    if (actorLogin !== reviewerLogin) continue;
    if (!Number.isSafeInteger(comment.id) || comment.id < 1) {
      throw new Error("Reviewer completion-comment identity is missing or malformed");
    }
    const createdTimestamp = timestampMilliseconds(
      comment.created_at,
      "Reviewer completion-comment creation timestamp",
    );
    const updatedTimestamp = timestampMilliseconds(
      comment.updated_at,
      "Reviewer completion-comment update timestamp",
    );
    if (updatedTimestamp < createdTimestamp) {
      throw new Error("Reviewer completion-comment timestamps are malformed");
    }
    if (
      latestReviewerComment === null ||
      updatedTimestamp > latestReviewerComment.updatedTimestamp ||
      (updatedTimestamp === latestReviewerComment.updatedTimestamp && comment.id > latestReviewerComment.id)
    ) {
      latestReviewerComment = {
        body: comment.body,
        createdTimestamp,
        id: comment.id,
        updatedTimestamp,
      };
    }
  }
  if (latestReviewerComment === null) return false;

  const reviewedPrefix = cleanReviewCommitPrefix(latestReviewerComment.body);
  return (
    reviewedPrefix !== null &&
    headSha.startsWith(reviewedPrefix) &&
    latestReviewerComment.createdTimestamp === latestReviewerComment.updatedTimestamp &&
    latestReviewerComment.createdTimestamp === headTimestamp &&
    latestReviewerComment.createdTimestamp > latestRequestTimestamp &&
    latestReviewerComment.createdTimestamp > reviewEvidenceTimestamp
  );
}

export function evaluateReviewCompletion({
  automatedReviewLogin,
  expectedHeadSha = "",
  files,
  forceReview = false,
  labels,
  pullRequest,
  releaseOperatorLogin,
  reviews,
  reviewRequestComments,
  reviewerCompletionComments,
  reviewThreads,
}) {
  const headSha = assertCurrentPullRequest(pullRequest, expectedHeadSha);
  const required = requiresAutomatedSecurityReview({ files, forceReview, labels });
  if (!required) {
    return {
      description: "No release/security-sensitive path, label, or force input",
      headSha,
      required: false,
      state: "success",
    };
  }

  const reviewerLogin = normalizeLogin(automatedReviewLogin, "Automated reviewer login");
  normalizeLogin(releaseOperatorLogin, "Release operator login");
  assertNoUnresolvedThreads(reviewThreads);

  const reviewEvidence = exactHeadReviewerEvidence({ automatedReviewLogin, headSha, reviews });
  if (reviewEvidence?.state === "APPROVED") {
    return {
      description: "Automated reviewer approved the exact PR head; no unresolved review threads",
      headSha,
      required: true,
      state: "success",
    };
  }

  const boundRequests = boundReviewRequests({
    headSha,
    releaseOperatorLogin,
    reviewRequestComments,
  });
  if (
    hasBoundCleanReviewComment({
      boundRequests,
      headSha,
      headTimestamp: pullRequestActivityTimestamp(pullRequest),
      reviewEvidenceTimestamp: reviewEvidence?.submittedAt ?? 0,
      reviewerCompletionComments,
      reviewerLogin,
    })
  ) {
    return {
      description: "Reviewer clean-result comment is bound to the exact-head request; no unresolved threads",
      headSha,
      required: true,
      state: "success",
    };
  }
  pending("Automated reviewer has no exact-head approval or bound clean-result comment");
}
