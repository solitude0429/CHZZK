import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildUpdateManifestDocument,
  validateUpdateManifestDocument,
} from "../../scripts/lib/update-manifest.js";
import { RELEASE_PACKAGE_FILES } from "../../scripts/lib/release-artifacts.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function metadata() {
  return {
    addOnId: "chzzk@solitude0429.local",
    files: RELEASE_PACKAGE_FILES.map((path, index) => ({
      path,
      sha256: String(index + 1).repeat(64),
      size: index + 1,
    })),
    schemaVersion: 1,
    sourceArchive: {
      name: "chzzk-0.1.4.zip",
      sha256: "a".repeat(64),
      size: 123,
    },
    sourceDigest: "b".repeat(40),
    sourceRepository: "solitude0429/CHZZK",
    strictMinVersion: "140.0",
    updateManifestUrl: "https://chzzk-updates.alpha-apple.dedyn.io/updates.json",
    version: "0.1.4",
  };
}

describe("strict Firefox update manifest", () => {
  it("builds update metadata only from immutable release metadata and signed XPI bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "chzzk-update-manifest-"));
    const signedXpiPath = join(directory, "chzzk-0.1.4-signed.xpi");
    const signedBytes = Buffer.from("synthetic signed xpi");
    writeFileSync(signedXpiPath, signedBytes);
    try {
      const document = buildUpdateManifestDocument({ metadata: metadata(), signedXpiPath });
      const update = document.addons["chzzk@solitude0429.local"].updates[0];
      assert.equal(update.version, "0.1.4");
      assert.equal(update.update_hash, `sha256:${sha256(signedBytes)}`);
      assert.equal(
        update.update_link,
        "https://chzzk-updates.alpha-apple.dedyn.io/releases/0.1.4/chzzk-0.1.4-signed.xpi",
      );
      assert.deepEqual(
        validateUpdateManifestDocument(document, {
          expectedMetadata: metadata(),
          expectedSignedXpiSha256: sha256(signedBytes),
        }),
        { signedXpiSha256: sha256(signedBytes), version: "0.1.4" },
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects extra keys, add-ons, update entries, and noncanonical update URLs", () => {
    const base = buildUpdateManifestDocument({
      metadata: metadata(),
      signedXpiBytes: Buffer.from("synthetic signed xpi"),
    });
    const expected = {
      expectedMetadata: metadata(),
      expectedSignedXpiSha256: sha256(Buffer.from("synthetic signed xpi")),
    };

    const cases = [
      { ...structuredClone(base), extra: true },
      {
        ...structuredClone(base),
        addons: { ...structuredClone(base.addons), "other@example": { updates: [] } },
      },
      (() => {
        const copy = structuredClone(base);
        copy.addons[metadata().addOnId].updates.push(
          structuredClone(copy.addons[metadata().addOnId].updates[0]),
        );
        return copy;
      })(),
      (() => {
        const copy = structuredClone(base);
        copy.addons[metadata().addOnId].updates[0].update_link =
          "https://user:pass@chzzk-updates.alpha-apple.dedyn.io/releases/0.1.4/chzzk-0.1.4-signed.xpi?token=bad#fragment";
        return copy;
      })(),
    ];

    for (const document of cases) {
      assert.throws(
        () => validateUpdateManifestDocument(document, expected),
        /schema|key|add-on|update|URL|canonical/i,
      );
    }
  });

  it("rejects a noncanonical signed XPI basename in direct path-based API use", () => {
    const directory = mkdtempSync(join(tmpdir(), "chzzk-update-manifest-"));
    const signedXpiPath = join(directory, "foreign.xpi");
    writeFileSync(signedXpiPath, "synthetic signed xpi");
    try {
      assert.throws(
        () => buildUpdateManifestDocument({ metadata: metadata(), signedXpiPath }),
        /canonical|signed XPI.*filename|basename/i,
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
