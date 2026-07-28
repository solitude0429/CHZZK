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

  it("publishes a source-bound exact-head-review check without executing pull-request code in the write job", () => {
    const workflow = read(".github/workflows/exact-head-review.yml");
    assert.match(workflow, /name:\s*Exact head review/);
    assert.match(workflow, /"name":\s*"exact-head-review"/);
    assert.match(workflow, /checks:\s*write/);
    assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
    assert.match(workflow, /types:\s*\[opened, reopened, synchronize, edited\]/);
    assert.match(workflow, /push:\s*[\r\n]+\s*branches:\s*\[main\]/);
    assert.match(workflow, /cancel-in-progress:\s*true/);
    assert.match(workflow, /&& 'protected' \|\| github\.run_id/);
    assert.match(workflow, /github\.event\.comment\.user\.login == github\.event\.issue\.user\.login/);
    assert.match(workflow, /CHZZK_COMMENT_NODE_ID/);
    assert.match(workflow, /CHZZK_BASE_SHA/);
    assert.match(workflow, /evaluated_base != current_base/);
    assert.match(workflow, /invalidate-base-advance:/);
    assert.match(workflow, /"state": "open"/);
    assert.match(workflow, /"conclusion": "failure"/);
    assert.match(workflow, /Base branch advanced/);
    assert.doesNotMatch(workflow, /pull_request_review_thread/);
    const publishJob = workflow.slice(workflow.indexOf("  publish-exact-head-review:"));
    assert.doesNotMatch(publishJob, /actions\/checkout@/);
    assert.doesNotMatch(publishJob, /node scripts\//);
  });

  it("binds review evidence to one immutable request, the request-time head, and the current base", () => {
    const verifier = read("scripts/verify-exact-head-review.js");
    assert.match(verifier, /hasPreviousPage/);
    assert.match(verifier, /hasNextPage/);
    assert.match(verifier, /baseRefOid/);
    assert.match(verifier, /timelineItems/);
    assert.match(verifier, /PullRequestCommit/);
    assert.match(verifier, /HeadRefRestoredEvent/);
    assert.match(verifier, /pullRequest\?\.headRefOid/);
    assert.match(verifier, /lastEditedAt/);
    assert.match(verifier, /reactedAt/);
    assert.match(verifier, /requestComment/);
    assert.match(verifier, /Exact head:/);
    assert.match(verifier, /Exact base:/);
    assert.doesNotMatch(verifier, /reviewThreads/);
    assert.doesNotMatch(verifier, /snapshot\?\.isDraft === true/);
    assert.doesNotMatch(verifier, /comments\(last:/);
  });
});
