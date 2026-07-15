const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
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

export function evaluateReviewCompletion({
  checkRuns,
  expectedHeadSha = "",
  files,
  forceReview = false,
  labels,
  pullRequest,
  reviewAppSlug,
  reviewCheckName,
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

  if (typeof reviewAppSlug !== "string" || !reviewAppSlug.trim()) {
    throw new Error("Automated reviewer app slug is not configured");
  }
  if (typeof reviewCheckName !== "string" || !reviewCheckName.trim()) {
    throw new Error("Automated reviewer completion check is not configured");
  }
  if (reviewAppSlug === "github-actions" && reviewCheckName === "CHZZK review completion") {
    throw new Error("Automated reviewer configuration must not trust the review gate's own check");
  }
  if (!Array.isArray(checkRuns)) throw new Error("Automated reviewer check-run response is missing");
  const matchingRuns = checkRuns
    .filter((run) => run?.app?.slug === reviewAppSlug && run?.name === reviewCheckName)
    .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));
  const completion = matchingRuns[0];
  if (!completion) throw new Error("Automated reviewer exposes no configured completion signal");
  if (
    completion.head_sha !== headSha ||
    completion.status !== "completed" ||
    completion.conclusion !== "success"
  ) {
    throw new Error("Automated reviewer completion is absent, unsuccessful, or stale for the current head");
  }

  if (!Array.isArray(reviewThreads)) throw new Error("Pull request review-thread response is missing");
  if (reviewThreads.some((thread) => typeof thread?.isResolved !== "boolean")) {
    throw new Error("Pull request review-thread completion state is unknown");
  }
  const unresolved = reviewThreads.filter((thread) => !thread.isResolved);
  if (unresolved.length > 0) {
    throw new Error(`Pull request has ${unresolved.length} unresolved actionable review thread(s)`);
  }

  return {
    description: "Automated review completed on the exact PR head; no unresolved review threads",
    headSha,
    required: true,
    state: "success",
  };
}
