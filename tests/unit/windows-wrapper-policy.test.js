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

  it("publishes a dedicated exact-diff check without executing pull-request code in the write job", () => {
    const workflow = read(".github/workflows/exact-head-review.yml");
    assert.match(workflow, /name:\s*Exact head review/);
    assert.match(workflow, /types:\s*\[opened, reopened, synchronize, edited\]/);
    assert.doesNotMatch(workflow, /pull_request_review_thread/);
    assert.match(workflow, /github\.event\.comment\.id \|\| 'pr-state'/);
    assert.match(workflow, /vars\.RELEASE_OPERATOR_LOGIN/);
    assert.match(workflow, /"name":\s*"exact-head-review"/);
    assert.match(workflow, /checks:\s*write/);
    assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
    const publishJob = workflow.slice(workflow.indexOf("  publish-exact-head-review:"));
    assert.doesNotMatch(publishJob, /actions\/checkout@/);
    assert.doesNotMatch(publishJob, /node scripts\//);
  });

  it("binds immutable review evidence to the exact head and base and fails closed", () => {
    const verifier = read("scripts/verify-exact-head-review.js");
    assert.match(verifier, /baseRefName/);
    assert.match(verifier, /baseRefOid/);
    assert.match(verifier, /headRefOid/);
    assert.match(verifier, /databaseId/);
    assert.match(verifier, /createdAt !== comment\.updatedAt/);
    assert.match(verifier, /PullRequestCommit/);
    assert.match(verifier, /BaseRefChangedEvent/);
    assert.match(verifier, /isResolved !== true/);
    assert.match(verifier, /pageInfo\?\.hasPreviousPage/);
    assert.match(verifier, /pageInfo\?\.hasNextPage/);
    assert.doesNotMatch(verifier, /SUCCESS_RE/);
    assert.doesNotMatch(verifier, /reviewedCommit/);
  });
});
