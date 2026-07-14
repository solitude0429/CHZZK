import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { signPreparedAddon } from "../../scripts/lib/amo-client.js";
import {
  RELEASE_PACKAGE_FILES,
  prepareReleaseArtifacts,
  verifySignedReleaseArtifacts,
} from "../../scripts/lib/release-artifacts.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeReleaseFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "chzzk-release-source-"));
  for (const file of RELEASE_PACKAGE_FILES) {
    cpSync(join(repoRoot, file), join(rootDir, file));
  }
  cpSync(join(repoRoot, "package.json"), join(rootDir, "package.json"));
  return rootDir;
}

function syntheticMetadata(sourceArchiveSha256) {
  return {
    addOnId: "chzzk-quality@solitude.local",
    schemaVersion: 1,
    sourceArchive: {
      name: "chzzk-0.1.4.zip",
      sha256: sourceArchiveSha256,
    },
    sourceDigest: "a".repeat(40),
    sourceRepository: "solitude0429/CHZZK",
    strictMinVersion: "115.0",
    updateManifestUrl: "https://chzzk-updates.alpha-apple.dedyn.io/updates.json",
    version: "0.1.4",
  };
}

describe("immutable release preparation", () => {
  it("archives only exact regular allowlisted files and is byte deterministic", async () => {
    const rootDir = makeReleaseFixture();
    const firstOutput = mkdtempSync(join(tmpdir(), "chzzk-release-output-a-"));
    const secondOutput = mkdtempSync(join(tmpdir(), "chzzk-release-output-b-"));
    try {
      writeFileSync(join(rootDir, "private.pem"), "synthetic private material that must never be archived");
      symlinkSync("private.pem", join(rootDir, "leak-link.pem"));

      const first = await prepareReleaseArtifacts({
        outputDir: firstOutput,
        rootDir,
        sourceDigest: "a".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const second = await prepareReleaseArtifacts({
        outputDir: secondOutput,
        rootDir,
        sourceDigest: "a".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });

      const firstBytes = readFileSync(first.sourceArchivePath);
      const secondBytes = readFileSync(second.sourceArchivePath);
      assert.equal(sha256(firstBytes), sha256(secondBytes));

      const zip = await JSZip.loadAsync(firstBytes);
      const entries = Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort();
      assert.deepEqual(entries, [...RELEASE_PACKAGE_FILES].sort());
      assert.equal(entries.includes("private.pem"), false);
      assert.equal(entries.includes("leak-link.pem"), false);
      assert.equal(lstatSync(first.sourceArchivePath).isFile(), true);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(firstOutput, { force: true, recursive: true });
      rmSync(secondOutput, { force: true, recursive: true });
    }
  });

  it("fails before packaging when an allowlisted runtime path is a symlink", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-release-output-"));
    try {
      rmSync(join(rootDir, "background.js"));
      symlinkSync("manifest.json", join(rootDir, "background.js"));

      await assert.rejects(
        prepareReleaseArtifacts({
          outputDir,
          rootDir,
          sourceDigest: "b".repeat(40),
          sourceRepository: "solitude0429/CHZZK",
        }),
        /regular file|symbolic link/i,
      );
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });
});

async function buildSyntheticSignedXpi(sourceArchivePath, outputPath, mutateManifest = null) {
  const source = await JSZip.loadAsync(readFileSync(sourceArchivePath));
  const signed = new JSZip();
  for (const entry of Object.values(source.files)) {
    if (entry.dir) continue;
    let bytes = await entry.async("nodebuffer");
    if (entry.name === "manifest.json" && mutateManifest) {
      const manifest = JSON.parse(bytes.toString("utf8"));
      mutateManifest(manifest);
      bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    signed.file(entry.name, bytes, { date: new Date("1980-01-01T00:00:00.000Z") });
  }
  signed.file("META-INF/mozilla.rsa", Buffer.from("synthetic signature"));
  writeFileSync(outputPath, await signed.generateAsync({ type: "nodebuffer" }), { mode: 0o600 });
}

describe("signed release verification", () => {
  it("binds the signed XPI to the prepared archive metadata while allowing only signature metadata extras", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-signed-release-"));
    try {
      const prepared = await prepareReleaseArtifacts({
        outputDir,
        rootDir,
        sourceDigest: "c".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
      await buildSyntheticSignedXpi(prepared.sourceArchivePath, signedXpiPath);

      const verified = await verifySignedReleaseArtifacts({
        metadataPath: prepared.metadataPath,
        signedXpiPath,
        sourceArchivePath: prepared.sourceArchivePath,
      });

      assert.equal(verified.version, prepared.metadata.version);
      assert.equal(verified.signedXpiSha256, sha256(readFileSync(signedXpiPath)));
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it("rejects a signed XPI whose embedded identity differs from release metadata", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-signed-release-"));
    try {
      const prepared = await prepareReleaseArtifacts({
        outputDir,
        rootDir,
        sourceDigest: "d".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
      await buildSyntheticSignedXpi(prepared.sourceArchivePath, signedXpiPath, (manifest) => {
        manifest.version = "9.9.9";
      });

      await assert.rejects(
        verifySignedReleaseArtifacts({
          metadataPath: prepared.metadataPath,
          signedXpiPath,
          sourceArchivePath: prepared.sourceArchivePath,
        }),
        /manifest|version|metadata/i,
      );
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });
});

describe("minimal AMO signing client", () => {
  it("uploads only the prepared archive and downloads the approved signed XPI", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-amo-output-"));
    const sourceArchivePath = join(outputDir, "chzzk-0.1.4.zip");
    const sourceBytes = Buffer.from("synthetic deterministic source archive");
    writeFileSync(sourceArchivePath, sourceBytes, { mode: 0o600 });
    const metadata = syntheticMetadata(sha256(sourceBytes));
    const requests = [];
    let validationPolls = 0;
    let approvalPolls = 0;

    const fetchImpl = async (url, options = {}) => {
      requests.push({ options, url: String(url) });
      const path = new URL(url).pathname;
      if (path.endsWith("/addons/upload/") && options.method === "POST") {
        const upload = options.body.get("upload");
        assert.equal(upload.name, "chzzk-0.1.4.zip");
        assert.deepEqual(Buffer.from(await upload.arrayBuffer()), sourceBytes);
        assert.equal(options.body.get("channel"), "unlisted");
        return Response.json({ uuid: "synthetic-upload" });
      }
      if (path.endsWith("/addons/upload/synthetic-upload/")) {
        validationPolls += 1;
        return Response.json({ processed: true, uuid: "synthetic-upload", valid: true, validation: {} });
      }
      if (
        path.endsWith(`/addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/`) &&
        options.method === "POST"
      ) {
        const submitted = JSON.parse(options.body);
        assert.deepEqual(submitted, { upload: "synthetic-upload" });
        return Response.json({
          edit_url: "https://addons.mozilla.org/developers/addon/synthetic",
          id: 1234,
          version: metadata.version,
        });
      }
      if (path.endsWith("/versions/1234/")) {
        approvalPolls += 1;
        return Response.json({
          file: { status: "public", url: "https://addons.mozilla.org/firefox/downloads/file/synthetic.xpi" },
        });
      }
      if (path.endsWith("/firefox/downloads/file/synthetic.xpi")) {
        return new Response(null, {
          headers: {
            location: "https://cdn.addons.mozilla.org/firefox/downloads/file/synthetic-final.xpi",
          },
          status: 302,
        });
      }
      if (path.endsWith("/firefox/downloads/file/synthetic-final.xpi")) {
        return new Response(Buffer.from("synthetic signed xpi"), { status: 200 });
      }
      return new Response("unexpected request", { status: 404 });
    };

    try {
      const result = await signPreparedAddon({
        apiKey: "user:123:456",
        apiSecret: "synthetic-secret",
        fetchImpl,
        metadata,
        outputDir,
        pollIntervalMs: 0,
        sourceArchivePath,
      });

      assert.equal(result.signedXpiPath, join(outputDir, "chzzk-0.1.4-signed.xpi"));
      assert.deepEqual(readFileSync(result.signedXpiPath), Buffer.from("synthetic signed xpi"));
      assert.equal(validationPolls, 1);
      assert.equal(approvalPolls, 1);
      const apiRequests = requests.filter(({ url }) => new URL(url).pathname.startsWith("/api/v5/"));
      const downloadRequests = requests.filter(({ url }) => !new URL(url).pathname.startsWith("/api/v5/"));
      assert.equal(
        apiRequests.every(({ options }) => /^JWT /.test(options.headers.get("Authorization"))),
        true,
      );
      assert.equal(
        apiRequests.every(({ options }) => options.redirect === "error"),
        true,
      );
      assert.equal(downloadRequests.length, 2);
      assert.equal(
        downloadRequests.every(({ options }) => !options.headers.has("Authorization")),
        true,
      );
      assert.equal(
        downloadRequests.every(({ options }) => options.redirect === "manual"),
        true,
      );
      assert.equal(
        requests.some(({ options }) => JSON.stringify(options).includes("synthetic-secret")),
        false,
      );
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });
});
