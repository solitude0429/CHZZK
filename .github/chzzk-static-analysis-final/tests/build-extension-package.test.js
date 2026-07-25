import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import JSZip from "jszip";

import { EXTENSION_PACKAGE_FILES, buildExtensionPackage } from "../../scripts/build-extension-package.js";

describe("deterministic ordinary extension package", () => {
  it("builds the exact approved file set reproducibly without web-ext", async () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), "chzzk-package-first-"));
    const secondDirectory = mkdtempSync(join(tmpdir(), "chzzk-package-second-"));
    try {
      const firstPath = await buildExtensionPackage({ outputDir: firstDirectory });
      const secondPath = await buildExtensionPackage({ outputDir: secondDirectory });
      const firstBytes = readFileSync(firstPath);
      const secondBytes = readFileSync(secondPath);
      assert.equal(firstBytes.equals(secondBytes), true, "ordinary package bytes must be deterministic");

      const zip = await JSZip.loadAsync(firstBytes, { checkCRC32: true });
      const actual = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort();
      assert.deepEqual(actual, [...EXTENSION_PACKAGE_FILES].sort());
      assert.equal(actual.includes("LICENSE"), true);
      assert.equal(actual.includes("NOTICE"), true);
      assert.equal(
        actual.some((path) => path.startsWith("node_modules/")),
        false,
      );
    } finally {
      rmSync(firstDirectory, { force: true, recursive: true });
      rmSync(secondDirectory, { force: true, recursive: true });
    }
  });
});
