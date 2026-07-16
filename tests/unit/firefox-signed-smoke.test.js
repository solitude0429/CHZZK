import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertTrustedPermanentAddon,
  bindGeckodriverService,
  buildProductionFirefoxCapabilities,
  validateSignedSmokeInputs,
} from "../../scripts/lib/firefox-signed-smoke.js";
import { RELEASE_PACKAGE_FILES } from "../../scripts/lib/release-artifacts.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function canonicalMetadata() {
  return {
    addOnId: "chzzk@solitude0429.local",
    files: RELEASE_PACKAGE_FILES.map((path, index) => ({
      path,
      sha256: String(index + 1).repeat(64),
      size: index + 1,
    })),
    schemaVersion: 1,
    sourceArchive: {
      name: "chzzk-0.1.5.zip",
      sha256: "a".repeat(64),
      size: 1234,
    },
    sourceDigest: "b".repeat(40),
    sourceRepository: "solitude0429/CHZZK",
    strictMinVersion: "140.0",
    updateManifestUrl: "https://chzzk-updates.alpha-apple.dedyn.io/updates.json",
    version: "0.1.5",
  };
}

function makeInputFiles() {
  const directory = mkdtempSync(join(tmpdir(), "chzzk-signed-smoke-input-"));
  const firefoxBinary = join(directory, "firefox");
  const geckodriverBinary = join(directory, "geckodriver");
  const metadataPath = join(directory, "chzzk-0.1.5-release-metadata.json");
  const newSignedXpiPath = join(directory, "chzzk-0.1.5-signed.xpi");
  const oldSignedXpiPath = join(directory, "chzzk-0.1.4-signed.xpi");
  for (const path of [firefoxBinary, geckodriverBinary]) {
    writeFileSync(path, "synthetic executable");
    chmodSync(path, 0o700);
  }
  writeFileSync(metadataPath, `${JSON.stringify(canonicalMetadata())}\n`);
  writeFileSync(newSignedXpiPath, "synthetic final signed artifact");
  writeFileSync(oldSignedXpiPath, "synthetic old signed artifact");
  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    firefoxBinary,
    geckodriverBinary,
    metadataPath,
    newSignedXpiPath,
    oldSignedXpiPath,
  };
}

describe("stock Firefox AMO-signed release smoke gate", () => {
  it("requires canonical final inputs and an older signed XPI in update mode", () => {
    const files = makeInputFiles();
    try {
      const install = validateSignedSmokeInputs({ ...files, mode: "install" });
      assert.equal(install.metadata.version, "0.1.5");
      assert.equal(install.oldVersion, null);

      const update = validateSignedSmokeInputs({ ...files, mode: "update" });
      assert.equal(update.oldVersion, "0.1.4");

      assert.throws(
        () => validateSignedSmokeInputs({ ...files, mode: "install", newSignedXpiPath: undefined }),
        /CHZZK_SIGNED_XPI|final signed XPI.*required/i,
      );
      assert.throws(
        () => validateSignedSmokeInputs({ ...files, mode: "update", oldSignedXpiPath: undefined }),
        /CHZZK_OLD_SIGNED_XPI|old signed XPI.*required/i,
      );
      assert.throws(
        () =>
          validateSignedSmokeInputs({
            ...files,
            mode: "update",
            oldSignedXpiPath: files.newSignedXpiPath,
          }),
        /older|version/i,
      );
    } finally {
      files.cleanup();
    }
  });

  it("normalizes workflow-style relative inputs to absolute WebDriver paths", () => {
    const files = makeInputFiles();
    try {
      const relativeFiles = Object.fromEntries(
        Object.entries(files)
          .filter(([name]) => name !== "cleanup")
          .map(([name, path]) => [name, relative(repoRoot, path)]),
      );
      const input = validateSignedSmokeInputs({ ...relativeFiles, mode: "update" });
      for (const path of [
        input.firefoxBinary,
        input.geckodriverBinary,
        input.metadataPath,
        input.newSignedXpiPath,
        input.oldSignedXpiPath,
      ]) {
        assert.equal(isAbsolute(path), true, path);
      }
    } finally {
      files.cleanup();
    }
  });

  it("binds the reserved geckodriver port into every disposable Firefox session", () => {
    const input = { firefoxBinary: "/opt/firefox/firefox" };
    assert.deepEqual(bindGeckodriverService(input, { port: 28_282 }), { ...input, port: 28_282 });
    for (const port of [undefined, 0, 65_536, 1.5]) {
      assert.throws(() => bindGeckodriverService(input, { port }), /geckodriver.*port/i);
    }
  });

  it("launches a disposable profile without signature or update trust preference overrides", () => {
    const capabilities = buildProductionFirefoxCapabilities({
      firefoxBinary: "/opt/firefox/firefox",
      profileDir: "/tmp/disposable-profile",
    });
    const firefoxOptions = capabilities.alwaysMatch["moz:firefoxOptions"];
    assert.equal(Object.hasOwn(firefoxOptions, "prefs"), false);
    assert.equal(firefoxOptions.args.includes("-profile"), true);
    assert.equal(firefoxOptions.args.includes("/tmp/disposable-profile"), true);
    assert.doesNotMatch(
      JSON.stringify(capabilities),
      /xpinstall\.signatures|requiredBuiltInCerts|requireBuiltInCerts/i,
    );
  });

  it("requires the expected ID/version, permanent install, default enforcement, and AMO signed state", () => {
    const expected = {
      expectedAddOnId: "chzzk@solitude0429.local",
      expectedUpdateUrl: "https://chzzk-updates.alpha-apple.dedyn.io/updates.json",
      expectedVersion: "0.1.5",
      securityState: {
        appName: "Firefox",
        expectedSignedState: 2,
        signaturePreferenceHasUserValue: false,
        signaturesRequired: true,
      },
    };
    const addon = {
      active: true,
      appDisabled: false,
      id: expected.expectedAddOnId,
      signedState: 2,
      temporarilyInstalled: false,
      updateURL: expected.expectedUpdateUrl,
      userDisabled: false,
      version: expected.expectedVersion,
    };
    assert.equal(assertTrustedPermanentAddon({ addon, ...expected }).version, "0.1.5");

    const cases = [
      { addon: { ...addon, id: "other@example.invalid" } },
      { addon: { ...addon, version: "9.9.9" } },
      { addon: { ...addon, temporarilyInstalled: true } },
      { addon: { ...addon, signedState: 0 } },
      { addon: { ...addon, active: false } },
      { addon: { ...addon, updateURL: "https://example.invalid/updates.json" } },
      { securityState: { ...expected.securityState, signaturesRequired: false } },
      { securityState: { ...expected.securityState, signaturePreferenceHasUserValue: true } },
    ];
    for (const mutation of cases) {
      assert.throws(
        () =>
          assertTrustedPermanentAddon({
            addon: mutation.addon ?? addon,
            ...expected,
            securityState: mutation.securityState ?? expected.securityState,
          }),
        /Firefox|add-on|permanent|signed|active|update|version|signature/i,
      );
    }
  });

  it("fails clearly when release-use signed artifacts are absent", () => {
    const result = spawnSync(process.execPath, ["scripts/firefox-signed-smoke.js"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /FIREFOX_BINARY.*required/i);
  });

  it("labels the unsigned Firefox E2E as functional-only and exposes the signed gate separately", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const functionalE2e = readFileSync(join(repoRoot, "tests/e2e/firefox-update-playback.mjs"), "utf8");
    assert.equal(
      packageJson.scripts["test:firefox-functional-e2e"],
      "node tests/e2e/firefox-update-playback.mjs",
    );
    assert.equal(packageJson.scripts["test:firefox-signed-smoke"], "node scripts/firefox-signed-smoke.js");
    assert.match(functionalE2e, /functionalOnly:\s*true/);
  });

  it("names the Node artifact check as structural and leaves authenticity to Firefox", async () => {
    const releaseArtifacts = await import("../../scripts/lib/release-artifacts.js");
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(typeof releaseArtifacts.verifySignedReleaseStructure, "function");
    assert.equal(Object.hasOwn(releaseArtifacts, "verifySignedReleaseArtifacts"), false);
    assert.equal(
      packageJson.scripts["verify:signed-release-structure"],
      "node scripts/verify-signed-release-structure.js",
    );
  });
});
