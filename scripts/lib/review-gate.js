const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const ABBREVIATED_GIT_SHA_RE = /^[a-f0-9]{10,40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const GITHUB_APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const GITHUB_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const STANDARD_CLEAN_REVIEW_RE =
  /^Codex Review: Didn't find any major issues\.[^\r\n]*\r?\n\r?\n\*\*Reviewed commit:\*\* `([a-f0-9]{10,40})`(?:\r?\n|$)/;
const EXACT_HEAD_CLEAN_REVIEW_RE =
  /^## Review Result\r?\n\r?\nNo major issues found in exact head `([a-f0-9]{40})`\.(?:\r?\n|$)/;
const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
const KNOWN_REVIEW_STATES = new Set([...DECISIVE_REVIEW_STATES, "DISMISSED", "PENDING"]);
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

function normalizeAppIdentity(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.slug !== "string" ||
    value.slug !== value.slug.toLowerCase() ||
    !GITHUB_APP_SLUG_RE.test(value.slug)
  ) {
    throw new Error(`${label} is missing or malformed`);
  }
  return { id: value.id, slug: value.slug };
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

function isCodexReviewRequest(body, headSha) {
  return (
    typeof body === "string" &&
    /^\s*@codex\s+review(?:\s|$)/i.test(body) &&
    fullShaAppearsInComment(body, headSha)
  );
}

export function cleanReviewCommitMarker(body) {
  if (typeof body !== "string") return null;
  const match = STANDARD_CLEAN_REVIEW_RE.exec(body) ?? EXACT_HEAD_CLEAN_REVIEW_RE.exec(body);
  return match?.[1] ?? null;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is missing or malformed`);
  }
  return value;
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
      if (reactionTimestamp !== null && reactionTimestamp > commentUpdatedTimestamp) return true;
    }
  }
  return false;
}

function hasBoundCleanReviewComment({
  automatedReviewApp,
  cleanReviewComments,
  headSha,
  latestIssueCommentId,
  latestReviewerFindingTimestamp,
  pullRequestTimestamp,
  releaseOperatorLogin,
  reviewRequestComments,
  reviewerLogin,
}) {
  if (!Array.isArray(cleanReviewComments)) {
    throw new Error("Automated reviewer clean-comment response is missing");
  }
  if (cleanReviewComments.length === 0) return false;
  const reviewerApp = normalizeAppIdentity(automatedReviewApp, "Automated reviewer app identity");
  const operatorLogin = normalizeLogin(releaseOperatorLogin, "Release operator login");
  const latestCommentId = positiveInteger(latestIssueCommentId, "Latest issue-comment identity");

  for (const comment of cleanReviewComments) {
    const actorLogin = normalizeLogin(comment?.user?.login, "Clean-review comment actor identity");
    const marker = cleanReviewCommitMarker(comment?.body);
    if (actorLogin !== reviewerLogin || marker === null) continue;
    if (comment.user.type !== "Bot") {
      throw new Error("Clean-review comment actor type is missing or malformed");
    }
    const performedViaApp = normalizeAppIdentity(
      comment.performed_via_github_app,
      "Clean-review comment GitHub App identity",
    );
    if (performedViaApp.id !== reviewerApp.id || performedViaApp.slug !== reviewerApp.slug) continue;

    const commentId = positiveInteger(comment.id, "Clean-review comment identity");
    const createdTimestamp = timestampMilliseconds(
      comment.created_at,
      "Clean-review comment creation timestamp",
    );
    const updatedTimestamp = timestampMilliseconds(
      comment.updated_at,
      "Clean-review comment update timestamp",
    );
    if (updatedTimestamp !== createdTimestamp) continue;
    if (commentId !== latestCommentId || createdTimestamp !== pullRequestTimestamp) continue;
    if (createdTimestamp <= latestReviewerFindingTimestamp) continue;

    const resolvedCommitSha = String(comment.resolved_commit_sha ?? "").toLowerCase();
    if (
      !ABBREVIATED_GIT_SHA_RE.test(marker) ||
      !FULL_GIT_SHA_RE.test(resolvedCommitSha) ||
      !resolvedCommitSha.startsWith(marker) ||
      resolvedCommitSha !== headSha
    ) {
      continue;
    }

    for (const request of reviewRequestComments) {
      const requestAuthor = normalizeLogin(request?.user?.login, "Review-request comment author identity");
      if (requestAuthor !== operatorLogin || !isCodexReviewRequest(request.body, headSha)) continue;
      const requestId = positiveInteger(request.id, "Review-request comment identity");
      const requestCreatedTimestamp = timestampMilliseconds(
        request.created_at,
        "Review-request comment creation timestamp",
      );
      const requestUpdatedTimestamp = timestampMilliseconds(
        request.updated_at,
        "Review-request comment update timestamp",
      );
      if (requestUpdatedTimestamp < requestCreatedTimestamp) {
        throw new Error("Review-request comment timestamps are malformed");
      }
      if (
        requestId < commentId &&
        requestUpdatedTimestamp < createdTimestamp &&
        requestCreatedTimestamp < createdTimestamp
      ) {
        return true;
      }
    }
  }
  return false;
}

export function evaluateReviewCompletion({
  automatedReviewApp,
  automatedReviewLogin,
  cleanReviewComments,
  expectedHeadSha = "",
  files,
  forceReview = false,
  latestIssueCommentId,
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

  const reviewEvidence = exactHeadReviewerEvidence({ automatedReviewLogin, headSha, reviews });
  if (reviewEvidence?.state === "APPROVED") {
    return {
      description: "Automated reviewer approved the exact PR head; no unresolved review threads",
      headSha,
      required: true,
      state: "success",
    };
  }

  const evidenceTimestamp = Math.max(
    pullRequestActivityTimestamp(pullRequest),
    reviewEvidence?.submittedAt ?? 0,
  );
  if (
    hasBoundRequestReaction({
      headSha,
      headTimestamp: evidenceTimestamp,
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
  if (
    hasBoundCleanReviewComment({
      automatedReviewApp,
      cleanReviewComments,
      headSha,
      latestIssueCommentId,
      latestReviewerFindingTimestamp: reviewEvidence?.submittedAt ?? 0,
      pullRequestTimestamp: pullRequestActivityTimestamp(pullRequest),
      releaseOperatorLogin,
      reviewRequestComments,
      reviewerLogin,
    })
  ) {
    return {
      description: "Verified reviewer-app clean comment is bound to the exact PR head; no unresolved threads",
      headSha,
      required: true,
      state: "success",
    };
  }
  pending(
    "Automated reviewer has no exact-head approval, bound +1 reaction, or verified exact-head clean comment",
  );
}
