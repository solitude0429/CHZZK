import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertReleaseVersionParity } from "../../scripts/validate-manifest.js";

function versionFiles(version = "1.2.3") {
  return {
    manifest: { version },
    packageJson: { version },
    packageLock: {
      packages: {
        "": { version },
      },
      version,
    },
  };
}

describe("release version parity", () => {
  it("accepts one exact version across the manifest and both package-lock locations", () => {
    assert.doesNotThrow(() => assertReleaseVersionParity(versionFiles()));
  });

  it("rejects each independently stale version location", () => {
    const manifestMismatch = versionFiles();
    manifestMismatch.manifest.version = "1.2.2";
    assert.throws(
      () => assertReleaseVersionParity(manifestMismatch),
      /manifest version must match package\.json/,
    );

    const lockTopLevelMismatch = versionFiles();
    lockTopLevelMismatch.packageLock.version = "1.2.2";
    assert.throws(
      () => assertReleaseVersionParity(lockTopLevelMismatch),
      /package-lock top-level version must match package\.json/,
    );

    const lockRootMismatch = versionFiles();
    lockRootMismatch.packageLock.packages[""].version = "1.2.2";
    assert.throws(
      () => assertReleaseVersionParity(lockRootMismatch),
      /package-lock root package version must match package\.json/,
    );
  });
});
