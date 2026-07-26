const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const GITHUB_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
const KNOWN_REVIEW_STATES = new Set([...DECISIVE_REVIEW_STATES, "DISMISSED", "PENDING"]);
const EXPLICIT_REVIEW_LABELS = new Set(["release-review-required", "security-review-required"]);
const CLEAN_REVIEW_TAGLINES = new Set([
  "",
  ":+1:",
  ":tada:",
  "Already looking forward to the next diff.",
  "Bravo.",
  "Breezy!",
  "Chef's kiss.",
  "Hooray!",
  "More of your lovely PRs please.",
  "Nice work!",
  "Swish!",
  "You're on a roll.",
]);
const CLEAN_REVIEW_FOOTER = `<details> <summary>ℹ️ About Codex in GitHub</summary>
<br/>

[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you
- Open a pull request for review
- Mark a draft as ready
- Comment "@codex review".

If Codex has suggestions, it will comment; otherwise it will react with 👍.




Codex can also answer questions or update the PR. Try commenting "@codex address that feedback".

</details>`;
const CLEAN_REVIEW_COMMENT_RE =
  /^Codex Review: Didn't find any major issues\.(?: ([^\n]+))?\n\n\*\*Reviewed commit:\*\* `([a-f0-9]{10,40})`(?:\n\n([\s\S]+))?$/;
const PACKAGED_RUNTIME_PATHS = new Set([
  "LICENSE",
  "NOTICE",
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

function trustedCleanReviewCommitPrefix(body) {
  if (typeof body !== "string") return null;
  const normalized = body.replace(/\r\n/g, "\n");
  if (normalized.includes("\r")) return null;
  const canonical = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n$/, "");
  const match = CLEAN_REVIEW_COMMENT_RE.exec(canonical);
  if (!match || !CLEAN_REVIEW_TAGLINES.has(match[1] ?? "")) return null;
  if (match[3] !== undefined && match[3] !== CLEAN_REVIEW_FOOTER) return null;
  return match[2];
}

export function isExactHeadReviewRequest(body, headSha) {
  return (
    typeof body === "string" &&
    /^@codex[ \t]+review(?=[ \t\r\n]|$)/i.test(body) &&
    fullShaAppearsInComment(body, headSha)
  );
}

function hasTrustedExactHeadCleanReview({
  automatedReviewLogin,
  headSha,
  pullRequest,
  pullRequestComments,
  releaseOperatorLogin,
  reviewEvidence,
  reviewRequestComments,
}) {
  const reviewerLogin = normalizeLogin(automatedReviewLogin, "Automated reviewer login");
  const operatorLogin = normalizeLogin(releaseOperatorLogin, "Release operator login");
  if (!reviewerLogin.endsWith("[bot]")) return false;
  if (!Array.isArray(pullRequestComments)) {
    throw new Error("Pull request comment response is missing");
  }
  if (!Array.isArray(reviewRequestComments)) {
    throw new Error("Operator review-request comment response is missing");
  }

  let latestRequest = null;
  for (const comment of reviewRequestComments) {
    const authorLogin = normalizeLogin(comment?.user?.login, "Review-request comment author identity");
    if (authorLogin !== operatorLogin || !isExactHeadReviewRequest(comment.body, headSha)) continue;
    if (!Number.isSafeInteger(comment?.id) || comment.id < 1) {
      throw new Error("Review-request comment identity is missing or malformed");
    }
    const createdAt = timestampMilliseconds(comment.created_at, "Review-request comment creation timestamp");
    const updatedAt = timestampMilliseconds(comment.updated_at, "Review-request comment update timestamp");
    if (updatedAt < createdAt) throw new Error("Review-request comment timestamps are malformed");
    if (updatedAt !== createdAt) continue;
    if (
      latestRequest === null ||
      createdAt > latestRequest.createdAt ||
      (createdAt === latestRequest.createdAt && comment.id > latestRequest.id)
    ) {
      latestRequest = { createdAt, id: comment.id };
    }
  }
  if (latestRequest === null) return false;

  let maximumCommentId = 0;
  let cleanReview = null;
  for (const comment of pullRequestComments) {
    if (!Number.isSafeInteger(comment?.id) || comment.id < 1) {
      throw new Error("Pull request comment identity is missing or malformed");
    }
    maximumCommentId = Math.max(maximumCommentId, comment.id);
    if (String(comment?.user?.login ?? "").toLowerCase() !== reviewerLogin) continue;
    normalizeLogin(comment.user.login, "Clean-review comment author identity");
    const reviewedCommitPrefix = trustedCleanReviewCommitPrefix(comment.body);
    if (reviewedCommitPrefix === null) continue;
    if (comment.user?.type !== "Bot" || !Number.isSafeInteger(comment.user?.id) || comment.user.id < 1) {
      throw new Error("Clean-review comment actor metadata is missing or malformed");
    }
    const expectedAppSlug = reviewerLogin.slice(0, -"[bot]".length);
    const app = comment.performed_via_github_app;
    if (!Number.isSafeInteger(app?.id) || app.id < 1 || app.slug !== expectedAppSlug) {
      throw new Error("Clean-review comment GitHub App identity is missing or mismatched");
    }
    const createdAt = timestampMilliseconds(comment.created_at, "Clean-review comment creation timestamp");
    const updatedAt = timestampMilliseconds(comment.updated_at, "Clean-review comment update timestamp");
    if (createdAt !== updatedAt) throw new Error("Clean-review comment was edited");
    if (!headSha.startsWith(reviewedCommitPrefix)) continue;
    if (
      cleanReview === null ||
      createdAt > cleanReview.createdAt ||
      (createdAt === cleanReview.createdAt && comment.id > cleanReview.id)
    ) {
      cleanReview = { createdAt, id: comment.id };
    }
  }
  if (cleanReview === null || cleanReview.id !== maximumCommentId) return false;

  if (reviewEvidence !== null && cleanReview.createdAt < reviewEvidence.submittedAt) return false;
  if (cleanReview.createdAt < pullRequestActivityTimestamp(pullRequest)) return false;
  return (
    cleanReview.createdAt > latestRequest.createdAt ||
    (cleanReview.createdAt === latestRequest.createdAt && cleanReview.id > latestRequest.id)
  );
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
    if (authorLogin !== operatorLogin || !isExactHeadReviewRequest(comment.body, headSha)) continue;
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

export function evaluateReviewCompletion({
  automatedReviewLogin,
  expectedHeadSha = "",
  files,
  forceReview = false,
  labels,
  pullRequest,
  pullRequestComments,
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

  if (
    hasTrustedExactHeadCleanReview({
      automatedReviewLogin,
      headSha,
      pullRequest,
      pullRequestComments,
      releaseOperatorLogin,
      reviewEvidence,
      reviewRequestComments,
    })
  ) {
    return {
      description: "Trusted reviewer reported no major issues for the exact PR head; no unresolved threads",
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
  pending(
    "Automated reviewer has no exact-head approval, trusted clean-review comment, or exact-head operator-request +1 reaction",
  );
}
