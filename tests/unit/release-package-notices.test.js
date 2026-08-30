import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RELEASE_PACKAGE_FILES } from "../../scripts/lib/release-artifacts.js";

describe("release notice packaging", () => {
  it("ships the license and attribution notice through the canonical release artifacts", () => {
    assert.equal(RELEASE_PACKAGE_FILES.includes("LICENSE"), true);
    assert.equal(RELEASE_PACKAGE_FILES.includes("NOTICE"), true);
  });
});
