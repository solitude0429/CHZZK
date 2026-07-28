import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Windows signed-smoke policy", () => {
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
});
