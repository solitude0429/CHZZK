import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RELEASE_PACKAGE_FILES as signingPackageFiles } from "../../scripts/lib/amo-client.js";
import { RELEASE_PACKAGE_FILES as finalizerPackageFiles } from "../../scripts/lib/release-finalize-state.js";

describe("release notice packaging", () => {
  it("ships the license and attribution notice through signing and finalization", () => {
    assert.deepEqual(finalizerPackageFiles, signingPackageFiles);
    assert.equal(signingPackageFiles.includes("LICENSE"), true);
    assert.equal(signingPackageFiles.includes("NOTICE"), true);
  });
});
