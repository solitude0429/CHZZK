import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Windows signed-smoke and exact-head review policy", () => {
  it("requires an explicit absolute Node executable and never resolves Node through PATH", () => {
    const wrapper = read("scripts/firefox-signed-smoke.windows.ps1");
    assert.match(
      wrapper,
      /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$NodeBinary/,
    );
    assert.match(wrapper, /IsPathFullyQualified\(\$Path\)/);
    assert.match(
      wrapper,
      /Resolve-RegularFile -Path \$NodeBinary -Label "NodeBinary" -RequireAbsolute/,
    );
    assert.doesNotMatch(wrapper, /Get-Command\s+-Name\s+\$NodeBinary/);
    assert.doesNotMatch(wrapper, /\$NodeBinary\s*=\s*"node\.exe"/);
    assert.match(wrapper, /& \$node -p/);
    assert.match(wrapper, /& \$node \$runner/);
  });

  it("publishes a dedicated exact-head-review check without executing pull-request code in the write job", () => {
    const workflow = read(".github/workflows/exact-head-review.yml");
    assert.match(workflow, /name:\s*Exact head review/);
    assert.match(workflow, /"name":\s*"exact-head-review"/);
    assert.match(workflow, /checks:\s*write/);
    assert.match(
      workflow,
      /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/,
    );
    const publishJob = workflow.slice(workflow.indexOf("  publish:"));
    assert.doesNotMatch(publishJob, /actions\/checkout@/);
    assert.doesNotMatch(publishJob, /node scripts\//);
  });

  it("keeps the verifier fail-closed for pagination and unresolved threads", () => {
    const verifier = read("scripts/verify-exact-head-review.js");
    assert.match(verifier, /hasPreviousPage/);
    assert.match(verifier, /hasNextPage/);
    assert.match(verifier, /isResolved !== true/);
    assert.match(verifier, /Didn\['’\]t find any major issues/);
    assert.match(
      verifier,
      /headSha\.toLowerCase\(\)\.startsWith\(reviewed\)/,
    );
  });
});
