import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  loadCompatibilityPolicy,
  resolveSignedSmokeToolchain,
  validateCompatibilityPolicy,
} from "../../scripts/lib/compatibility-policy.js";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("Firefox compatibility policy", () => {
  it("binds manifest support declarations to minimum and current stock-Firefox profiles", () => {
    const policy = loadCompatibilityPolicy({ manifest });
    assert.equal(policy.desktop.minimumVersion, "140.0");
    assert.equal(policy.android.minimumVersion, "142.0");

    const minimum = resolveSignedSmokeToolchain(policy, {
      architecture: "x64",
      profileName: "minimum",
    });
    assert.equal(minimum.firefoxVersion, manifest.browser_specific_settings.gecko.strict_min_version);
    assert.equal(
      minimum.firefoxUrl,
      "https://archive.mozilla.org/pub/firefox/releases/140.0/linux-x86_64/en-US/firefox-140.0.tar.xz",
    );

    const current = resolveSignedSmokeToolchain(policy, {
      architecture: "arm64",
      profileName: "current",
    });
    assert.equal(current.firefoxVersion, "152.0.6");
    assert.match(current.firefoxSha512, /^[a-f0-9]{128}$/);
    assert.equal(current.geckodriverVersion, "0.37.0");
  });

  it("rejects manifest drift, invalid digests, and incomplete profiles", () => {
    const policy = loadCompatibilityPolicy();
    const driftedManifest = clone(manifest);
    driftedManifest.browser_specific_settings.gecko.strict_min_version = "141.0";
    assert.throws(
      () => validateCompatibilityPolicy(policy, { manifest: driftedManifest }),
      /Desktop minimum Firefox version/i,
    );

    const badDigest = clone(policy);
    badDigest.desktop.signedSmokeProfiles.minimum.architectures.x64.sha512 = "0";
    assert.throws(() => validateCompatibilityPolicy(badDigest), /sha512/i);

    const missingProfile = clone(policy);
    delete missingProfile.desktop.signedSmokeProfiles.minimum;
    assert.throws(() => validateCompatibilityPolicy(missingProfile), /schema keys|profiles/i);
  });

  it("fails closed for unknown profiles and unsupported architectures", () => {
    const policy = loadCompatibilityPolicy();
    assert.throws(
      () => resolveSignedSmokeToolchain(policy, { profileName: "latest" }),
      /Unknown signed-smoke Firefox profile/i,
    );
    assert.throws(
      () => resolveSignedSmokeToolchain(policy, { architecture: "riscv64" }),
      /Unsupported signed-smoke architecture/i,
    );
  });
});
