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
const SYNTHETIC_AMO_CREDENTIAL = ["synthetic", "credential", "value"].join("-");

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

function makeAmoInput(prefix = "chzzk-amo-review-") {
  const outputDir = mkdtempSync(join(tmpdir(), prefix));
  const sourceArchivePath = join(outputDir, "chzzk-0.1.4.zip");
  const sourceBytes = Buffer.from("synthetic deterministic source archive");
  writeFileSync(sourceArchivePath, sourceBytes, { mode: 0o600 });
  return {
    cleanup() {
      rmSync(outputDir, { force: true, recursive: true });
    },
    metadata: syntheticMetadata(sha256(sourceBytes)),
    outputDir,
    sourceArchivePath,
  };
}

async function assertControlledAmoTimeout(operation) {
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(
      () => reject(new Error("test guard expired before a controlled AMO timeout")),
      250,
    );
  });
  try {
    await assert.rejects(Promise.race([operation, guard]), /AMO .*timed out/i);
  } finally {
    clearTimeout(guardTimer);
  }
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

async function buildSyntheticSignedXpi(
  sourceArchivePath,
  outputPath,
  mutateManifest = null,
  transformManifestBytes = null,
  transformEntryName = null,
) {
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
    if (entry.name === "manifest.json" && transformManifestBytes) {
      bytes = transformManifestBytes(bytes);
    }
    signed.file(transformEntryName?.(entry.name) ?? entry.name, bytes, {
      createFolders: false,
      date: new Date("1980-01-01T00:00:00.000Z"),
    });
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

  it("accepts AMO manifest formatting and key-order normalization when semantics are identical", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-signed-release-"));
    try {
      const prepared = await prepareReleaseArtifacts({
        outputDir,
        rootDir,
        sourceDigest: "e".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
      await buildSyntheticSignedXpi(prepared.sourceArchivePath, signedXpiPath, (manifest) => {
        const name = manifest.name;
        delete manifest.name;
        manifest.name = name;
      });

      const verified = await verifySignedReleaseArtifacts({
        metadataPath: prepared.metadataPath,
        signedXpiPath,
        sourceArchivePath: prepared.sourceArchivePath,
      });

      assert.equal(verified.version, prepared.metadata.version);
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

  it("rejects duplicate signed manifest keys before semantic comparison", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-signed-release-"));
    try {
      const prepared = await prepareReleaseArtifacts({
        outputDir,
        rootDir,
        sourceDigest: "f".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
      await buildSyntheticSignedXpi(prepared.sourceArchivePath, signedXpiPath, null, (bytes) => {
        const text = bytes.toString("utf8");
        const expected = `"version": "${prepared.metadata.version}"`;
        assert.equal(text.includes(expected), true);
        return Buffer.from(text.replace(expected, `"\\u0076ersion": "9.9.9",\n  ${expected}`));
      });

      await assert.rejects(
        verifySignedReleaseArtifacts({
          metadataPath: prepared.metadataPath,
          signedXpiPath,
          sourceArchivePath: prepared.sourceArchivePath,
        }),
        /duplicate|manifest/i,
      );
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it("rejects signed ZIP entries whose raw names normalize into the runtime allowlist", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-signed-release-"));
    try {
      const prepared = await prepareReleaseArtifacts({
        outputDir,
        rootDir,
        sourceDigest: "1".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
      await buildSyntheticSignedXpi(prepared.sourceArchivePath, signedXpiPath, null, null, (name) =>
        name === "manifest.json" ? "nested/../manifest.json" : name,
      );

      await assert.rejects(
        verifySignedReleaseArtifacts({
          metadataPath: prepared.metadataPath,
          signedXpiPath,
          sourceArchivePath: prepared.sourceArchivePath,
        }),
        /unsafe|raw|entry|path/i,
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
      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname;
      if (
        path.endsWith(`/addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/`) &&
        options.method === "GET"
      ) {
        assert.equal(parsedUrl.searchParams.get("filter"), "all_with_unlisted");
        return Response.json({ next: null, results: [] });
      }
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
          channel: "unlisted",
          file: { status: "public", url: "https://addons.mozilla.org/firefox/downloads/file/synthetic.xpi" },
          id: 1234,
          version: metadata.version,
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
      assert.equal(
        new URL(requests[0].url).pathname.endsWith(
          `/addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/`,
        ),
        true,
        "the client must detect an existing target version before creating a new upload",
      );
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
      assert.match(downloadRequests[0].options.headers.get("Authorization"), /^JWT /);
      assert.equal(downloadRequests[1].options.headers.has("Authorization"), false);
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

  it("resumes an existing unlisted target version without creating another upload", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-amo-resume-"));
    const sourceArchivePath = join(outputDir, "chzzk-0.1.4.zip");
    const sourceBytes = Buffer.from("synthetic deterministic source archive");
    writeFileSync(sourceArchivePath, sourceBytes, { mode: 0o600 });
    const metadata = syntheticMetadata(sha256(sourceBytes));
    const requests = [];

    const fetchImpl = async (url, options = {}) => {
      requests.push({ options, url: String(url) });
      const parsedUrl = new URL(url);
      if (
        parsedUrl.pathname.endsWith(`/addons/addon/${encodeURIComponent(metadata.addOnId)}/versions/`) &&
        options.method === "GET"
      ) {
        assert.equal(parsedUrl.searchParams.get("filter"), "all_with_unlisted");
        return Response.json({
          next: null,
          results: [
            {
              channel: "unlisted",
              file: {
                status: "public",
                url: "https://addons.mozilla.org/firefox/downloads/file/resumed.xpi",
              },
              id: 5678,
              version: metadata.version,
            },
          ],
        });
      }
      if (parsedUrl.pathname.endsWith("/firefox/downloads/file/resumed.xpi")) {
        return new Response(Buffer.from("resumed signed xpi"), { status: 200 });
      }
      return new Response("unexpected request", { status: 404 });
    };

    try {
      const result = await signPreparedAddon({
        apiKey: "synthetic-key",
        apiSecret: "synthetic-secret",
        fetchImpl,
        metadata,
        outputDir,
        pollIntervalMs: 0,
        sourceArchivePath,
      });

      assert.deepEqual(readFileSync(result.signedXpiPath), Buffer.from("resumed signed xpi"));
      assert.equal(
        requests.some(({ url }) => new URL(url).pathname.endsWith("/addons/upload/")),
        false,
      );
      assert.equal(
        requests.some(({ options }) => options.method === "POST"),
        false,
      );
      assert.equal(requests.length, 2);
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it("rejects listed or wrong-version submission records before polling", async () => {
    for (const invalidSubmission of [
      { channel: "listed", version: "0.1.4" },
      { channel: "unlisted", version: "9.9.9" },
    ]) {
      const input = makeAmoInput();
      let followupRequests = 0;
      const fetchImpl = async (url, options = {}) => {
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname;
        if (path.endsWith(`/addons/addon/${encodeURIComponent(input.metadata.addOnId)}/versions/`)) {
          if (options.method === "GET") return Response.json({ next: null, results: [] });
          return Response.json({
            ...invalidSubmission,
            file: { status: "public", url: "https://addons.mozilla.org/firefox/downloads/file/invalid.xpi" },
            id: 1234,
          });
        }
        if (path.endsWith("/addons/upload/") && options.method === "POST") {
          return Response.json({ uuid: "synthetic-upload" });
        }
        if (path.endsWith("/addons/upload/synthetic-upload/")) {
          return Response.json({ processed: true, valid: true });
        }
        followupRequests += 1;
        return new Response("unexpected request", { status: 404 });
      };
      try {
        await assert.rejects(
          signPreparedAddon({
            apiKey: SYNTHETIC_AMO_CREDENTIAL,
            apiSecret: "synthetic-secret",
            fetchImpl,
            ...input,
            pollIntervalMs: 0,
          }),
          /unlisted|release metadata|version/i,
        );
        assert.equal(followupRequests, 0);
      } finally {
        input.cleanup();
      }
    }
  });

  it("rejects listed or wrong-version approval records before downloading", async () => {
    for (const invalidApproval of [
      { channel: "listed", version: "0.1.4" },
      { channel: "unlisted", version: "9.9.9" },
    ]) {
      const input = makeAmoInput();
      let downloadRequests = 0;
      const fetchImpl = async (url, options = {}) => {
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname;
        if (path.endsWith(`/addons/addon/${encodeURIComponent(input.metadata.addOnId)}/versions/`)) {
          if (options.method === "GET") return Response.json({ next: null, results: [] });
          return Response.json({ id: 1234, version: input.metadata.version });
        }
        if (path.endsWith("/addons/upload/") && options.method === "POST") {
          return Response.json({ uuid: "synthetic-upload" });
        }
        if (path.endsWith("/addons/upload/synthetic-upload/")) {
          return Response.json({ processed: true, valid: true });
        }
        if (path.endsWith("/versions/1234/")) {
          return Response.json({
            ...invalidApproval,
            file: { status: "public", url: "https://addons.mozilla.org/firefox/downloads/file/invalid.xpi" },
            id: 1234,
          });
        }
        if (path.endsWith("/firefox/downloads/file/invalid.xpi")) {
          downloadRequests += 1;
          return new Response(Buffer.from("must not download"), { status: 200 });
        }
        return new Response("unexpected request", { status: 404 });
      };
      try {
        await assert.rejects(
          signPreparedAddon({
            apiKey: SYNTHETIC_AMO_CREDENTIAL,
            apiSecret: "synthetic-secret",
            fetchImpl,
            ...input,
            pollIntervalMs: 0,
          }),
          /unlisted|release metadata|version/i,
        );
        assert.equal(downloadRequests, 0);
      } finally {
        input.cleanup();
      }
    }
  });

  it("rejects duplicate target versions spread across pagination", async () => {
    const input = makeAmoInput();
    const requests = [];
    const versionRecord = (id) => ({
      channel: "unlisted",
      file: { status: "public", url: `https://addons.mozilla.org/firefox/downloads/file/${id}.xpi` },
      id,
      version: input.metadata.version,
    });
    const fetchImpl = async (url, options = {}) => {
      const parsedUrl = new URL(url);
      requests.push(parsedUrl.href);
      if (options.method === "GET" && parsedUrl.pathname.endsWith("/versions/")) {
        if (parsedUrl.searchParams.get("page") === "2") {
          return Response.json({ next: null, results: [versionRecord(2222)] });
        }
        const next = new URL(parsedUrl);
        next.searchParams.set("page", "2");
        return Response.json({ next: next.href, results: [versionRecord(1111)] });
      }
      if (parsedUrl.pathname.endsWith("/firefox/downloads/file/1111.xpi")) {
        return new Response(Buffer.from("must not download"), { status: 200 });
      }
      return new Response("unexpected request", { status: 404 });
    };
    try {
      await assert.rejects(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl,
          ...input,
          pollIntervalMs: 0,
        }),
        /duplicate target versions/i,
      );
      assert.equal(
        requests.some((url) => new URL(url).searchParams.get("page") === "2"),
        true,
      );
      assert.equal(
        requests.some((url) => url.endsWith("/firefox/downloads/file/1111.xpi")),
        false,
      );
    } finally {
      input.cleanup();
    }
  });

  it("times out a stalled AMO API fetch", async () => {
    const input = makeAmoInput();
    try {
      await assertControlledAmoTimeout(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl: async () => new Promise(() => {}),
          ...input,
          maxWaitMs: 25,
          pollIntervalMs: 0,
        }),
      );
    } finally {
      input.cleanup();
    }
  });

  it("times out a stalled AMO JSON response body", async () => {
    const input = makeAmoInput();
    try {
      await assertControlledAmoTimeout(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl: async () => ({
            json: async () => new Promise(() => {}),
            ok: true,
            status: 200,
          }),
          ...input,
          maxWaitMs: 25,
          pollIntervalMs: 0,
        }),
      );
    } finally {
      input.cleanup();
    }
  });

  it("times out a stalled signed-XPI fetch", async () => {
    const input = makeAmoInput();
    const fetchImpl = async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/versions/")) {
        return Response.json({
          next: null,
          results: [
            {
              channel: "unlisted",
              file: {
                status: "public",
                url: "https://addons.mozilla.org/firefox/downloads/file/stalled.xpi",
              },
              id: 1234,
              version: input.metadata.version,
            },
          ],
        });
      }
      return new Promise(() => {});
    };
    try {
      await assertControlledAmoTimeout(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl,
          ...input,
          maxWaitMs: 25,
          pollIntervalMs: 0,
        }),
      );
    } finally {
      input.cleanup();
    }
  });

  it("times out a stalled signed-XPI response body", async () => {
    const input = makeAmoInput();
    const downloadUrl = "https://addons.mozilla.org/firefox/downloads/file/stalled-body.xpi";
    const fetchImpl = async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/versions/")) {
        return Response.json({
          next: null,
          results: [
            {
              channel: "unlisted",
              file: { status: "public", url: downloadUrl },
              id: 1234,
              version: input.metadata.version,
            },
          ],
        });
      }
      return {
        arrayBuffer: async () => new Promise(() => {}),
        headers: new Headers(),
        ok: true,
        status: 200,
        url: downloadUrl,
      };
    };
    try {
      await assertControlledAmoTimeout(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl,
          ...input,
          maxWaitMs: 25,
          pollIntervalMs: 0,
        }),
      );
    } finally {
      input.cleanup();
    }
  });
});
