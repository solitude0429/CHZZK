import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { signPreparedAddon } from "../../scripts/lib/amo-client.js";
import { RELEASE_PACKAGE_FILES, assertReleaseMetadata } from "../../scripts/lib/release-artifacts.js";
import { buildUpdateManifestDocument } from "../../scripts/lib/update-manifest.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

describe("canonical release metadata schema", () => {
  it("accepts only the exact canonical schema at every object level", () => {
    assert.equal(assertReleaseMetadata(canonicalMetadata()).version, "0.1.5");

    const mutations = [
      (metadata) => {
        metadata.unknown = true;
      },
      (metadata) => {
        metadata.sourceArchive.unknown = true;
      },
      (metadata) => {
        metadata.files[0].unknown = true;
      },
      (metadata) => {
        delete metadata.strictMinVersion;
      },
    ];
    for (const mutate of mutations) {
      const metadata = canonicalMetadata();
      mutate(metadata);
      assert.throws(() => assertReleaseMetadata(metadata), /schema|key|metadata/i);
    }
  });

  it("rejects noncanonical project identity, URLs, and archive names", () => {
    const mutations = [
      (metadata) => {
        metadata.addOnId = "other@example.invalid";
      },
      (metadata) => {
        metadata.sourceRepository = "attacker/CHZZK";
      },
      (metadata) => {
        metadata.updateManifestUrl = "https://example.invalid/updates.json";
      },
      (metadata) => {
        metadata.sourceArchive.name = "renamed.zip";
      },
    ];
    for (const mutate of mutations) {
      const metadata = canonicalMetadata();
      mutate(metadata);
      assert.throws(() => assertReleaseMetadata(metadata), /canonical|add-on|archive|repository|URL/i);
    }
  });

  it("requires one valid digest and safe size for every exact runtime path", () => {
    const mutations = [
      (metadata) => {
        metadata.files.push({ ...metadata.files[0], sha256: "f".repeat(64) });
      },
      (metadata) => {
        metadata.files[0].path = "unexpected.js";
      },
      (metadata) => {
        metadata.files.pop();
      },
      (metadata) => {
        metadata.files[0].sha256 = "not-a-digest";
      },
      (metadata) => {
        metadata.files[0].size = Number.MAX_SAFE_INTEGER + 1;
      },
      (metadata) => {
        metadata.sourceArchive.size = -1;
      },
    ];
    for (const mutate of mutations) {
      const metadata = canonicalMetadata();
      mutate(metadata);
      assert.throws(() => assertReleaseMetadata(metadata), /allowlist|digest|duplicate|file|size/i);
    }
  });

  it("makes AMO and update callers reject noncanonical metadata before side effects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chzzk-canonical-metadata-"));
    const sourceArchivePath = join(directory, "chzzk-0.1.5.zip");
    const sourceBytes = Buffer.from("synthetic source archive");
    writeFileSync(sourceArchivePath, sourceBytes, { mode: 0o600 });
    const metadata = canonicalMetadata();
    metadata.sourceArchive.sha256 = sha256(sourceBytes);
    metadata.sourceArchive.size = sourceBytes.length;
    metadata.unknown = true;
    let fetchCalls = 0;
    try {
      await assert.rejects(
        signPreparedAddon({
          apiKey: "synthetic-key",
          apiSecret: "synthetic-secret",
          fetchImpl: async () => {
            fetchCalls += 1;
            throw new Error("network must not be reached");
          },
          metadata,
          outputDir: directory,
          sourceArchivePath,
        }),
        /schema|key|metadata/i,
      );
      assert.equal(fetchCalls, 0);
      assert.throws(
        () => buildUpdateManifestDocument({ metadata, signedXpiBytes: Buffer.from("x") }),
        /schema|key|metadata/i,
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
