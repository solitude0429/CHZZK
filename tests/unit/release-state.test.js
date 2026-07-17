import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { inspectPreSignReleaseState } from "../../scripts/lib/github-release-state.js";
import { RELEASE_PACKAGE_FILES, prepareReleaseArtifacts } from "../../scripts/lib/release-artifacts.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const repository = "solitude0429/CHZZK";
const sourceSha = "b".repeat(40);
const STRUCTURAL_SIGNATURE_FIXTURE = Object.freeze({
  "META-INF/cose.manifest": Buffer.alloc(512, "m"),
  "META-INF/cose.sig": Buffer.alloc(1024, "c"),
  "META-INF/manifest.mf": Buffer.alloc(512, "f"),
  "META-INF/mozilla.rsa": Buffer.alloc(1024, "r"),
  "META-INF/mozilla.sf": Buffer.alloc(128, "s"),
});

async function makePreparedFixture() {
  const sourceRoot = mkdtempSync(join(tmpdir(), "chzzk-release-state-source-"));
  const localDir = mkdtempSync(join(tmpdir(), "chzzk-release-state-local-"));
  const remoteDir = mkdtempSync(join(tmpdir(), "chzzk-release-state-remote-"));
  for (const file of RELEASE_PACKAGE_FILES) cpSync(join(repoRoot, file), join(sourceRoot, file));
  cpSync(join(repoRoot, "package.json"), join(sourceRoot, "package.json"));
  const prepared = await prepareReleaseArtifacts({
    outputDir: localDir,
    rootDir: sourceRoot,
    sourceDigest: sourceSha,
    sourceRepository: repository,
  });
  const version = prepared.metadata.version;
  return {
    cleanup() {
      for (const path of [sourceRoot, localDir, remoteDir]) rmSync(path, { force: true, recursive: true });
    },
    localDir,
    metadataPath: prepared.metadataPath,
    remoteDir,
    signedXpiPath: join(localDir, `chzzk-${version}-signed.xpi`),
    sourceArchivePath: prepared.sourceArchivePath,
    version,
  };
}

async function writeSyntheticSignedXpi(sourceArchivePath, outputPath) {
  const source = await JSZip.loadAsync(readFileSync(sourceArchivePath));
  const signed = new JSZip();
  for (const entry of Object.values(source.files)) {
    if (!entry.dir) {
      signed.file(entry.name, await entry.async("nodebuffer"), { createFolders: false });
    }
  }
  for (const [name, bytes] of Object.entries(STRUCTURAL_SIGNATURE_FIXTURE)) {
    signed.file(name, bytes, { createFolders: false });
  }
  writeFileSync(outputPath, await signed.generateAsync({ type: "nodebuffer" }), { mode: 0o600 });
}

function releaseHarness({ assets = [], release = {}, tagSha = null }, fixture) {
  const tag = `v${fixture.version}`;
  const calls = [];
  const releaseRecord =
    release === null
      ? null
      : {
          assets: assets.map((name) => ({ name })),
          draft: true,
          immutable: false,
          prerelease: false,
          tag_name: tag,
          target_commitish: sourceSha,
          ...release,
        };
  const runGh = (args) => {
    calls.push(args);
    const endpoint = args.find((argument) => argument.startsWith(`repos/${repository}/`));
    if (args[0] === "api" && endpoint?.includes("/releases?per_page=100")) {
      return JSON.stringify([[...(releaseRecord ? [releaseRecord] : [])]]);
    }
    if (args[0] === "api" && endpoint?.includes("/git/matching-refs/tags/")) {
      return JSON.stringify([
        tagSha ? [{ object: { sha: tagSha, type: "commit" }, ref: `refs/tags/${tag}` }] : [],
      ]);
    }
    if (args[0] === "release" && args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1];
      const destination = args[args.indexOf("--dir") + 1];
      cpSync(join(fixture.remoteDir, name), join(destination, name));
      return "";
    }
    if (args[0] === "attestation" && args[1] === "verify") return "";
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  return { calls, runGh };
}

async function inspect(fixture, harness) {
  return inspectPreSignReleaseState({
    metadataPath: fixture.metadataPath,
    repository,
    runGh: harness.runGh,
    signedXpiPath: fixture.signedXpiPath,
    sourceArchivePath: fixture.sourceArchivePath,
    sourceSha,
    version: fixture.version,
  });
}

describe("pre-sign GitHub release state inspection", () => {
  it("accepts a compatible partial draft only after comparing every existing expected byte", async () => {
    const fixture = await makePreparedFixture();
    const sourceName = basename(fixture.sourceArchivePath);
    const metadataName = basename(fixture.metadataPath);
    cpSync(fixture.sourceArchivePath, join(fixture.remoteDir, sourceName));
    cpSync(fixture.metadataPath, join(fixture.remoteDir, metadataName));
    const harness = releaseHarness({ assets: [sourceName, metadataName] }, fixture);
    try {
      assert.deepEqual(await inspect(fixture, harness), {
        draftSignedReady: false,
        reuseExisting: false,
        signedSha256: "",
      });
      assert.deepEqual(
        harness.calls
          .filter((args) => args[0] === "release" && args[1] === "download")
          .map((args) => args[args.indexOf("--pattern") + 1])
          .sort(),
        [metadataName, sourceName].sort(),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("reuses a compatible complete draft's already-verified signed XPI without another AMO operation", async () => {
    const fixture = await makePreparedFixture();
    const names = [
      basename(fixture.sourceArchivePath),
      basename(fixture.metadataPath),
      basename(fixture.signedXpiPath),
    ];
    cpSync(fixture.sourceArchivePath, join(fixture.remoteDir, names[0]));
    cpSync(fixture.metadataPath, join(fixture.remoteDir, names[1]));
    await writeSyntheticSignedXpi(fixture.sourceArchivePath, join(fixture.remoteDir, names[2]));
    const expectedSignedBytes = readFileSync(join(fixture.remoteDir, names[2]));
    const harness = releaseHarness({ assets: names }, fixture);
    try {
      const result = await inspect(fixture, harness);
      assert.equal(result.draftSignedReady, true);
      assert.equal(result.reuseExisting, false);
      assert.match(result.signedSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(readFileSync(fixture.signedXpiPath), expectedSignedBytes);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects stale targets, orphan tags, foreign assets, and changed expected bytes", async () => {
    const cases = [
      {
        configure(fixture) {
          return releaseHarness({ release: { target_commitish: "c".repeat(40) } }, fixture);
        },
        expected: /target|commit|source/i,
      },
      {
        configure(fixture) {
          return releaseHarness({ release: null, tagSha: sourceSha }, fixture);
        },
        expected: /orphan|tag/i,
      },
      {
        configure(fixture) {
          return releaseHarness({ assets: ["foreign.bin"] }, fixture);
        },
        expected: /unexpected|asset|foreign/i,
      },
      {
        configure(fixture) {
          const name = basename(fixture.sourceArchivePath);
          writeFileSync(join(fixture.remoteDir, name), "changed remote bytes");
          return releaseHarness({ assets: [name] }, fixture);
        },
        expected: /byte|differ|asset/i,
      },
    ];

    for (const testCase of cases) {
      const fixture = await makePreparedFixture();
      const harness = testCase.configure(fixture);
      try {
        await assert.rejects(inspect(fixture, harness), testCase.expected);
      } finally {
        fixture.cleanup();
      }
    }
  });
});
