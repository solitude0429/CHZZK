const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const GITHUB_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SUBMITTED_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
const KNOWN_REVIEW_STATES = new Set([...SUBMITTED_REVIEW_STATES, "DISMISSED", "PENDING"]);
const EXPLICIT_REVIEW_LABELS = new Set(["release-review-required", "security-review-required"]);
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
    path === "package.json" ||
    path === "package-lock.json" ||
    /^docs\/(?:HARDENING|OPERATIONS|SECURITY|SIGNING|UPDATES)\.md$/.test(path)
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

export function hasExactHeadReviewerReview({ automatedReviewLogin, headSha, reviews }) {
  const reviewerLogin = normalizeLogin(automatedReviewLogin, "Automated reviewer login");
  if (!FULL_GIT_SHA_RE.test(String(headSha ?? "").toLowerCase())) {
    throw new Error("Review comparison head SHA is missing or malformed");
  }
  if (!Array.isArray(reviews)) throw new Error("Automated reviewer review response is missing");

  let exactReview = false;
  for (const review of reviews) {
    const actorLogin = normalizeLogin(review?.user?.login, "Review actor identity");
    if (actorLogin !== reviewerLogin) continue;
    if (typeof review.state !== "string" || !KNOWN_REVIEW_STATES.has(review.state)) {
      throw new Error("Automated reviewer review state is missing or malformed");
    }
    if (!SUBMITTED_REVIEW_STATES.has(review.state)) continue;
    const reviewCommitId = String(review.commit_id ?? "").toLowerCase();
    if (!FULL_GIT_SHA_RE.test(reviewCommitId)) {
      throw new Error("Automated reviewer review commit identity is missing or malformed");
    }
    timestampMilliseconds(review.submitted_at, "Automated reviewer review timestamp");
    if (reviewCommitId === headSha) exactReview = true;
  }
  return exactReview;
}

function headCommitTimestamp(headCommit, headSha) {
  const commitSha = String(headCommit?.sha ?? "").toLowerCase();
  if (commitSha !== headSha) throw new Error("Head commit timestamp response is stale or malformed");
  return timestampMilliseconds(headCommit?.commit?.committer?.date, "Head commit timestamp");
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

function validReviewerReaction(reaction, reviewerLogin, headTimestamp, label) {
  const actorLogin = normalizeLogin(reaction?.user?.login, `${label} actor identity`);
  if (actorLogin !== reviewerLogin || reaction.content !== "+1") return null;
  const reactionTimestamp = timestampMilliseconds(reaction.created_at, `${label} timestamp`);
  return reactionTimestamp > headTimestamp ? reactionTimestamp : null;
}

function hasBoundRequestReaction({
  headSha,
  headTimestamp,
  releaseOperatorLogin,
  reviewRequestComments,
  reviewerLogin,
}) {
  const operatorLogin = normalizeLogin(releaseOperatorLogin, "Release operator login");
  if (!Array.isArray(reviewRequestComments)) {
    throw new Error("Operator review-request comment response is missing");
  }

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
    if (!Array.isArray(comment.reactions)) {
      throw new Error("Review-request comment reaction response is missing");
    }
    for (const reaction of comment.reactions) {
      const reactionTimestamp = validReviewerReaction(
        reaction,
        reviewerLogin,
        headTimestamp,
        "Review-request comment reaction",
      );
      if (reactionTimestamp !== null && reactionTimestamp >= commentUpdatedTimestamp) return true;
    }
  }
  return false;
}

export function evaluateReviewCompletion({
  automatedReviewLogin,
  expectedHeadSha = "",
  files,
  forceReview = false,
  headCommit,
  labels,
  pullRequest,
  releaseOperatorLogin,
  reviews,
  reviewRequestComments,
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

  if (hasExactHeadReviewerReview({ automatedReviewLogin, headSha, reviews })) {
    return {
      description: "Automated reviewer reviewed the exact PR head; no unresolved review threads",
      headSha,
      required: true,
      state: "success",
    };
  }

  const headTimestamp = headCommitTimestamp(headCommit, headSha);
  if (
    hasBoundRequestReaction({
      headSha,
      headTimestamp,
      releaseOperatorLogin,
      reviewRequestComments,
      reviewerLogin,
    })
  ) {
    return {
      description: "Reviewer +1 is bound to the exact-head operator request; no unresolved threads",
      headSha,
      required: true,
      state: "success",
    };
  }
  pending("Automated reviewer has no exact-head review or exact-head operator-request +1 reaction");
}
