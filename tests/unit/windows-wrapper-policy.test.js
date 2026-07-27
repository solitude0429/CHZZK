import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Windows signed-smoke and exact-head review policy", () => {
  it("requires an explicit absolute Node executable and never resolves Node through PATH", () => {
    const wrapper = read("scripts/firefox-signed-smoke.windows.ps1");
    assert.match(wrapper, /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$NodeBinary/);
    assert.match(wrapper, /IsPathRooted\(\$Path\)/);
    assert.match(wrapper, /GetFullPath\(\$Path\)/);
    assert.doesNotMatch(wrapper, /IsPathFullyQualified/);
    assert.match(wrapper, /Resolve-RegularFile -Path \$NodeBinary -Label "NodeBinary" -RequireAbsolute/);
    assert.doesNotMatch(wrapper, /Get-Command\s+-Name\s+\$NodeBinary/);
    assert.doesNotMatch(wrapper, /\$NodeBinary\s*=\s*"node\.exe"/);
    assert.match(wrapper, /& \$node -p/);
    assert.match(wrapper, /& \$node \$runner/);
  });

  it("serializes trusted review state and publishes a durable exact-diff check", () => {
    const workflow = read(".github/workflows/exact-head-review.yml");
    assert.match(workflow, /name:\s*Exact head review/);
    assert.match(workflow, /types:\s*\[opened, reopened, synchronize, edited\]/);
    assert.doesNotMatch(workflow, /pull_request_review_thread/);
    assert.match(workflow, /github\.event_name == 'issue_comment'/);
    assert.match(workflow, /github\.event\.comment\.user\.login == github\.event\.issue\.user\.login/);
    assert.match(workflow, /\) && github\.run_id \|\|/);
    assert.doesNotMatch(workflow, /vars\.RELEASE_OPERATOR_LOGIN/);
    assert.match(workflow, /evidence_created_at:/);
    assert.match(workflow, /evidence_id:/);
    assert.match(workflow, /request_comment_id:/);
    assert.match(workflow, /"name":\s*"exact-head-review"/);
    assert.match(workflow, /checks:\s*write/);
    assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
    const publishJob = workflow.slice(workflow.indexOf("  publish-exact-head-review:"));
    const publishCondition = publishJob.slice(0, publishJob.indexOf("    needs:"));
    assert.match(
      publishCondition,
      /if:\s*always\(\) && needs\.evaluate-exact-head-review\.result != 'skipped'/,
    );
    assert.doesNotMatch(publishCondition, /should_publish/);
    assert.match(publishJob, /current_draft = pull_request\["draft"\]/);
    assert.match(publishJob, /conclusion == "success" and current_draft is not True/);
    assert.match(publishJob, /Pull request left draft before the review attestation was published\./);
    assert.match(publishJob, /Review verifier did not produce durable Codex evidence\./);
    assert.match(publishJob, /request:\{request_comment_id or 0\}:reaction:\{evidence_id or 0\}/);
    assert.doesNotMatch(publishJob, /actions\/checkout@/);
    assert.doesNotMatch(publishJob, /node scripts\//);
  });

  it("binds immutable author evidence to draft, exact head/base, and PR edit state", () => {
    const verifier = read("scripts/verify-exact-head-review.js");
    assert.match(verifier, /baseRefName/);
    assert.match(verifier, /baseRefOid/);
    assert.match(verifier, /headRefOid/);
    assert.match(verifier, /isDraft/);
    assert.match(verifier, /lastEditedAt/);
    assert.match(verifier, /reactions\(first: 100, content: THUMBS_UP/);
    assert.match(verifier, /evidenceCreatedAt/);
    assert.match(verifier, /evidenceId/);
    assert.match(verifier, /requestCommentId/);
    assert.match(verifier, /createdAt !== comment\.updatedAt/);
    assert.match(verifier, /PullRequestCommit/);
    assert.match(verifier, /BaseRefChangedEvent/);
    assert.match(verifier, /isResolved !== true/);
    assert.match(verifier, /pageInfo\?\.hasPreviousPage/);
    assert.match(verifier, /pageInfo\?\.hasNextPage/);
    assert.doesNotMatch(verifier, /eventTrustedRequester/);
    assert.doesNotMatch(verifier, /SUCCESS_RE/);
    assert.doesNotMatch(verifier, /reviewedCommit/);
  });
});
