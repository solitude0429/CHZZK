import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

import { MAX_SIGNED_XPI_BYTES, signPreparedAddon } from "../../scripts/lib/amo-client.js";
import {
  RELEASE_PACKAGE_FILES,
  prepareReleaseArtifacts,
  verifySignedReleaseStructure,
} from "../../scripts/lib/release-artifacts.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const SYNTHETIC_AMO_CREDENTIAL = ["synthetic", "credential", "value"].join("-");
const STRUCTURAL_SIGNATURE_FIXTURE = Object.freeze({
  "META-INF/cose.manifest": Buffer.alloc(512, "m"),
  "META-INF/cose.sig": Buffer.alloc(1024, "c"),
  "META-INF/manifest.mf": Buffer.alloc(512, "f"),
  "META-INF/mozilla.rsa": Buffer.alloc(1024, "r"),
  "META-INF/mozilla.sf": Buffer.alloc(128, "s"),
});

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

function addManifestNumericFixture(rootDir, token) {
  const manifestPath = join(rootDir, "manifest.json");
  const manifestText = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, manifestText.replace(/^\{/, `{\n  "numeric_fixture": ${token},`));
}

function syntheticMetadata(sourceArchiveSha256, sourceArchiveSize) {
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
      sha256: sourceArchiveSha256,
      size: sourceArchiveSize,
    },
    sourceDigest: "a".repeat(40),
    sourceRepository: "solitude0429/CHZZK",
    strictMinVersion: "140.0",
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
    metadata: syntheticMetadata(sha256(sourceBytes), sourceBytes.length),
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
  signatureMetadata = STRUCTURAL_SIGNATURE_FIXTURE,
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
  for (const [name, bytes] of Object.entries(signatureMetadata)) {
    signed.file(name, bytes, { createFolders: false });
  }
  writeFileSync(outputPath, await signed.generateAsync({ type: "nodebuffer" }), { mode: 0o600 });
}

async function assertSignedZipResourceRejected({ compression, expected, replaceRuntime }) {
  const rootDir = makeReleaseFixture();
  const outputDir = mkdtempSync(join(tmpdir(), "chzzk-zip-resource-"));
  try {
    const prepared = await prepareReleaseArtifacts({
      outputDir,
      rootDir,
      sourceDigest: "5".repeat(40),
      sourceRepository: "solitude0429/CHZZK",
    });
    const source = await JSZip.loadAsync(readFileSync(prepared.sourceArchivePath));
    const signed = new JSZip();
    for (const entry of Object.values(source.files)) {
      if (entry.dir) continue;
      const originalBytes = await entry.async("nodebuffer");
      signed.file(entry.name, replaceRuntime(entry.name, originalBytes), { createFolders: false });
    }
    for (const [name, bytes] of Object.entries(STRUCTURAL_SIGNATURE_FIXTURE)) {
      signed.file(name, bytes, { createFolders: false });
    }
    const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
    writeFileSync(
      signedXpiPath,
      await signed.generateAsync({
        compression,
        compressionOptions: compression === "DEFLATE" ? { level: 9 } : undefined,
        type: "nodebuffer",
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      verifySignedReleaseStructure({
        metadataPath: prepared.metadataPath,
        signedXpiPath,
        sourceArchivePath: prepared.sourceArchivePath,
      }),
      expected,
    );
  } finally {
    rmSync(rootDir, { force: true, recursive: true });
    rmSync(outputDir, { force: true, recursive: true });
  }
}

describe("signed release structural verification", () => {
  it("binds an AMO-shaped XPI to prepared metadata without claiming signature authenticity", async () => {
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

      const verified = await verifySignedReleaseStructure({
        metadataPath: prepared.metadataPath,
        signedXpiPath,
        sourceArchivePath: prepared.sourceArchivePath,
      });

      assert.equal(verified.version, prepared.metadata.version);
      assert.equal(verified.signedXpiSha256, sha256(readFileSync(signedXpiPath)));
      assert.equal(verified.verification, "structural-only");
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

      const verified = await verifySignedReleaseStructure({
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

  it("does not collapse distinct JSON numeric tokens during manifest comparison", async () => {
    const collisions = [
      ["9007199254740992", "9007199254740993"],
      ["0", "1e-400"],
      ["1.0000000000000000", "1.0000000000000001"],
      ["-0", "0"],
    ];
    for (const [sourceToken, signedToken] of collisions) {
      const rootDir = makeReleaseFixture();
      const outputDir = mkdtempSync(join(tmpdir(), "chzzk-json-number-"));
      try {
        addManifestNumericFixture(rootDir, sourceToken);
        const prepared = await prepareReleaseArtifacts({
          outputDir,
          rootDir,
          sourceDigest: "2".repeat(40),
          sourceRepository: "solitude0429/CHZZK",
        });
        const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
        await buildSyntheticSignedXpi(prepared.sourceArchivePath, signedXpiPath, null, (bytes) => {
          const source = `"numeric_fixture": ${sourceToken}`;
          assert.equal(bytes.toString("utf8").includes(source), true);
          return Buffer.from(bytes.toString("utf8").replace(source, `"numeric_fixture": ${signedToken}`));
        });

        await assert.rejects(
          verifySignedReleaseStructure({
            metadataPath: prepared.metadataPath,
            signedXpiPath,
            sourceArchivePath: prepared.sourceArchivePath,
          }),
          /manifest|metadata|numeric/i,
          `${sourceToken} and ${signedToken} must remain distinguishable`,
        );
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
        rmSync(outputDir, { force: true, recursive: true });
      }
    }
  });

  it("normalizes mathematically equivalent JSON exponent spellings losslessly", async () => {
    for (const [sourceToken, signedToken] of [
      ["100", "1e2"],
      ["1.2300e2", "123"],
    ]) {
      const rootDir = makeReleaseFixture();
      const outputDir = mkdtempSync(join(tmpdir(), "chzzk-json-number-"));
      try {
        addManifestNumericFixture(rootDir, sourceToken);
        const prepared = await prepareReleaseArtifacts({
          outputDir,
          rootDir,
          sourceDigest: "3".repeat(40),
          sourceRepository: "solitude0429/CHZZK",
        });
        const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
        await buildSyntheticSignedXpi(prepared.sourceArchivePath, signedXpiPath, null, (bytes) =>
          Buffer.from(
            bytes
              .toString("utf8")
              .replace(`"numeric_fixture": ${sourceToken}`, `"numeric_fixture": ${signedToken}`),
          ),
        );

        const verified = await verifySignedReleaseStructure({
          metadataPath: prepared.metadataPath,
          signedXpiPath,
          sourceArchivePath: prepared.sourceArchivePath,
        });
        assert.equal(verified.version, prepared.metadata.version);
      } finally {
        rmSync(rootDir, { force: true, recursive: true });
        rmSync(outputDir, { force: true, recursive: true });
      }
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
        verifySignedReleaseStructure({
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
        verifySignedReleaseStructure({
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
        verifySignedReleaseStructure({
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

  it("enforces the exact bounded Mozilla signature metadata structure", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-signature-structure-"));
    try {
      const prepared = await prepareReleaseArtifacts({
        outputDir,
        rootDir,
        sourceDigest: "4".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const exact = Object.fromEntries(
        Object.entries(STRUCTURAL_SIGNATURE_FIXTURE).map(([name, bytes]) => [name, Buffer.from(bytes)]),
      );
      const cases = [
        { "META-INF/mozilla.rsa": Buffer.from("synthetic signature") },
        Object.fromEntries(Object.entries(exact).filter(([name]) => name !== "META-INF/cose.sig")),
        { ...exact, "META-INF/cose.sig": Buffer.alloc(0) },
        { ...exact, "META-INF/unexpected.sig": Buffer.alloc(1024, "x") },
        { ...exact, "META-INF/mozilla.rsa": Buffer.alloc(128 * 1024, "x") },
      ];

      for (const [index, signatureMetadata] of cases.entries()) {
        const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
        await buildSyntheticSignedXpi(
          prepared.sourceArchivePath,
          signedXpiPath,
          null,
          null,
          null,
          signatureMetadata,
        );
        await assert.rejects(
          verifySignedReleaseStructure({
            metadataPath: prepared.metadataPath,
            signedXpiPath,
            sourceArchivePath: prepared.sourceArchivePath,
          }),
          /signature metadata|META-INF|signature.*size/i,
          `invalid signature metadata case ${index} must fail structurally`,
        );
      }
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it("rejects a signed XPI above the compressed archive cap before ZIP parsing", async () => {
    const rootDir = makeReleaseFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-zip-compressed-cap-"));
    try {
      const prepared = await prepareReleaseArtifacts({
        outputDir,
        rootDir,
        sourceDigest: "6".repeat(40),
        sourceRepository: "solitude0429/CHZZK",
      });
      const signedXpiPath = join(outputDir, `chzzk-${prepared.metadata.version}-signed.xpi`);
      writeFileSync(signedXpiPath, Buffer.alloc(16 * 1024 * 1024 + 1), { mode: 0o600 });
      await assert.rejects(
        verifySignedReleaseStructure({
          metadataPath: prepared.metadataPath,
          signedXpiPath,
          sourceArchivePath: prepared.sourceArchivePath,
        }),
        /compressed archive size limit/i,
      );
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
      rmSync(outputDir, { force: true, recursive: true });
    }
  });

  it("rejects oversized compressed and uncompressed entries from central-directory metadata", async () => {
    await assertSignedZipResourceRejected({
      compression: "STORE",
      expected: /compressed entry size limit/i,
      replaceRuntime: (name, bytes) =>
        name === "background.js" ? Buffer.alloc(3 * 1024 * 1024, "x") : bytes,
    });
    await assertSignedZipResourceRejected({
      compression: "DEFLATE",
      expected: /uncompressed entry size limit/i,
      replaceRuntime: (name, bytes) =>
        name === "background.js" ? Buffer.alloc(5 * 1024 * 1024, "x") : bytes,
    });
  });

  it("rejects excessive aggregate uncompressed size before full inflation", async () => {
    await assertSignedZipResourceRejected({
      compression: "STORE",
      expected: /aggregate uncompressed size limit/i,
      replaceRuntime: () => Buffer.alloc(1024 * 1024, "a"),
    });
  });

  it("rejects excessive central-directory compression ratios before full inflation", async () => {
    await assertSignedZipResourceRejected({
      compression: "DEFLATE",
      expected: /compression ratio limit/i,
      replaceRuntime: (name, bytes) => (name === "background.js" ? Buffer.alloc(1024 * 1024, 0) : bytes),
    });
  });
});

describe("minimal AMO signing client", () => {
  it("uploads only the prepared archive and downloads the approved signed XPI", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "chzzk-amo-output-"));
    const sourceArchivePath = join(outputDir, "chzzk-0.1.4.zip");
    const sourceBytes = Buffer.from("synthetic deterministic source archive");
    writeFileSync(sourceArchivePath, sourceBytes, { mode: 0o600 });
    const metadata = syntheticMetadata(sha256(sourceBytes), sourceBytes.length);
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
        pollIntervalMs: 100,
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
    const metadata = syntheticMetadata(sha256(sourceBytes), sourceBytes.length);
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
        pollIntervalMs: 100,
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

  it("retries only approved-URL 404s with a fresh JWT inside the global deadline", async () => {
    const input = makeAmoInput("chzzk-amo-retry-");
    const approvedUrl = "https://addons.mozilla.org/firefox/downloads/file/retry.xpi";
    const redirectedUrl = "https://cdn.addons.mozilla.org/firefox/downloads/file/retry-final.xpi";
    const approvedAuthorizations = [];
    let approvedAttempts = 0;
    let redirectedAuthorization;
    const fetchImpl = async (url, options = {}) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/versions/")) {
        return Response.json({
          next: null,
          results: [
            {
              channel: "unlisted",
              file: { status: "public", url: approvedUrl },
              id: 2468,
              version: input.metadata.version,
            },
          ],
        });
      }
      if (String(url) === approvedUrl) {
        approvedAttempts += 1;
        approvedAuthorizations.push(options.headers.get("Authorization"));
        if (approvedAttempts < 3) return new Response("not propagated", { status: 404 });
        return new Response(null, { headers: { location: redirectedUrl }, status: 302 });
      }
      if (String(url) === redirectedUrl) {
        redirectedAuthorization = options.headers.get("Authorization");
        return new Response(Buffer.from("eventually signed xpi"), { status: 200 });
      }
      return new Response("unexpected request", { status: 500 });
    };
    try {
      const result = await signPreparedAddon({
        apiKey: SYNTHETIC_AMO_CREDENTIAL,
        apiSecret: "synthetic-secret",
        fetchImpl,
        ...input,
        pollIntervalMs: 100,
      });
      assert.deepEqual(readFileSync(result.signedXpiPath), Buffer.from("eventually signed xpi"));
      assert.equal(approvedAttempts, 3);
      assert.equal(new Set(approvedAuthorizations).size, 3, "every retry must mint a fresh JWT");
      assert.equal(
        approvedAuthorizations.every((authorization) => /^JWT /.test(authorization)),
        true,
      );
      assert.equal(redirectedAuthorization, null, "redirect hops must not receive AMO authorization");
    } finally {
      input.cleanup();
    }
  });

  it("stops repeated approved-URL 404 retries at the one global signing deadline", async () => {
    const input = makeAmoInput("chzzk-amo-retry-deadline-");
    let downloadAttempts = 0;
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
                url: "https://addons.mozilla.org/firefox/downloads/file/not-ready.xpi",
              },
              id: 1357,
              version: input.metadata.version,
            },
          ],
        });
      }
      downloadAttempts += 1;
      return new Response("not propagated", { status: 404 });
    };
    try {
      await assertControlledAmoTimeout(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl,
          ...input,
          maxWaitMs: 25,
          pollIntervalMs: 100,
        }),
      );
      assert.equal(downloadAttempts, 1);
    } finally {
      input.cleanup();
    }
  });

  it("fails a signed-download 403 immediately without retrying", async () => {
    const input = makeAmoInput("chzzk-amo-forbidden-");
    let downloadAttempts = 0;
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
                url: "https://addons.mozilla.org/firefox/downloads/file/forbidden.xpi",
              },
              id: 9753,
              version: input.metadata.version,
            },
          ],
        });
      }
      downloadAttempts += 1;
      return new Response("forbidden", { status: 403 });
    };
    try {
      await assert.rejects(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl,
          ...input,
          pollIntervalMs: 100,
        }),
        /HTTP 403/i,
      );
      assert.equal(downloadAttempts, 1);
    } finally {
      input.cleanup();
    }
  });

  it("validates the AMO poll interval as a bounded safe integer before any request", async () => {
    for (const pollIntervalMs of [-1, 0, 99, 100.5, Number.NaN, 60_001]) {
      const input = makeAmoInput("chzzk-amo-poll-interval-");
      let fetchCalls = 0;
      try {
        await assert.rejects(
          signPreparedAddon({
            apiKey: SYNTHETIC_AMO_CREDENTIAL,
            apiSecret: "synthetic-secret",
            fetchImpl: async () => {
              fetchCalls += 1;
              throw new Error("network must not be reached");
            },
            ...input,
            pollIntervalMs,
          }),
          /poll interval/i,
        );
        assert.equal(fetchCalls, 0);
      } finally {
        input.cleanup();
      }
    }
  });

  it("rejects oversized signed Content-Length and cancels before reading the body", async () => {
    const input = makeAmoInput("chzzk-amo-content-length-");
    const downloadUrl = "https://addons.mozilla.org/firefox/downloads/file/oversized-length.xpi";
    let arrayBufferCalls = 0;
    let cancelCalls = 0;
    const fetchImpl = async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/versions/")) {
        return Response.json({
          next: null,
          results: [
            {
              channel: "unlisted",
              file: { status: "public", url: downloadUrl },
              id: 8642,
              version: input.metadata.version,
            },
          ],
        });
      }
      return {
        arrayBuffer: async () => {
          arrayBufferCalls += 1;
          return new Uint8Array([1]).buffer;
        },
        body: {
          cancel() {
            cancelCalls += 1;
            return Promise.resolve();
          },
        },
        headers: new Headers({ "content-length": String(MAX_SIGNED_XPI_BYTES + 1) }),
        ok: true,
        status: 200,
        url: downloadUrl,
      };
    };
    try {
      await assert.rejects(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl,
          ...input,
          pollIntervalMs: 100,
        }),
        /signed download.*size limit/i,
      );
      assert.equal(arrayBufferCalls, 0);
      assert.equal(cancelCalls, 1);
    } finally {
      input.cleanup();
    }
  });

  it("streams and cancels an undeclared oversized signed body before aggregate allocation", async () => {
    const input = makeAmoInput("chzzk-amo-stream-cap-");
    const downloadUrl = "https://addons.mozilla.org/firefox/downloads/file/oversized-stream.xpi";
    const chunk = new Uint8Array(1024 * 1024);
    let cancelCalls = 0;
    let reads = 0;
    const fetchImpl = async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/versions/")) {
        return Response.json({
          next: null,
          results: [
            {
              channel: "unlisted",
              file: { status: "public", url: downloadUrl },
              id: 8643,
              version: input.metadata.version,
            },
          ],
        });
      }
      return {
        arrayBuffer: async () => {
          throw new Error("arrayBuffer must not be used for signed downloads");
        },
        body: {
          getReader() {
            return {
              cancel() {
                cancelCalls += 1;
                return Promise.resolve();
              },
              async read() {
                reads += 1;
                return { done: false, value: chunk };
              },
            };
          },
        },
        headers: new Headers(),
        ok: true,
        status: 200,
        url: downloadUrl,
      };
    };
    try {
      await assert.rejects(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl,
          ...input,
          pollIntervalMs: 100,
        }),
        /signed download.*size limit/i,
      );
      assert.equal(reads, MAX_SIGNED_XPI_BYTES / chunk.byteLength + 1);
      assert.equal(cancelCalls, 1);
    } finally {
      input.cleanup();
    }
  });

  it("bounds AMO JSON response bytes before parsing and cancels oversized bodies", async () => {
    const input = makeAmoInput("chzzk-amo-json-cap-");
    let cancelCalls = 0;
    let jsonCalls = 0;
    try {
      await assert.rejects(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl: async () => ({
            body: {
              cancel() {
                cancelCalls += 1;
                return Promise.resolve();
              },
            },
            headers: new Headers({ "content-length": String(1024 * 1024 + 1) }),
            json: async () => {
              jsonCalls += 1;
              return { next: null, results: [] };
            },
            ok: true,
            status: 200,
          }),
          ...input,
          pollIntervalMs: 100,
        }),
        /JSON response.*size limit/i,
      );
      assert.equal(jsonCalls, 0);
      assert.equal(cancelCalls, 1);
    } finally {
      input.cleanup();
    }
  });

  it("rejects AMO JSON responses beyond the nesting limit", async () => {
    const input = makeAmoInput("chzzk-amo-json-depth-");
    let nested = { version: "not-the-target" };
    for (let depth = 0; depth < 65; depth += 1) nested = [nested];
    let fetchCalls = 0;
    try {
      await assert.rejects(
        signPreparedAddon({
          apiKey: SYNTHETIC_AMO_CREDENTIAL,
          apiSecret: "synthetic-secret",
          fetchImpl: async () => {
            fetchCalls += 1;
            if (fetchCalls > 1) throw new Error("nesting must fail before another request");
            return Response.json({ next: null, results: [nested] });
          },
          ...input,
          pollIntervalMs: 100,
        }),
        /JSON response.*nesting limit/i,
      );
      assert.equal(fetchCalls, 1);
    } finally {
      input.cleanup();
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
            pollIntervalMs: 100,
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
            pollIntervalMs: 100,
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
          pollIntervalMs: 100,
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
          pollIntervalMs: 100,
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
            body: {
              getReader: () => ({
                cancel: () => Promise.resolve(),
                read: async () => new Promise(() => {}),
                releaseLock() {},
              }),
            },
            headers: new Headers(),
            ok: true,
            status: 200,
          }),
          ...input,
          maxWaitMs: 25,
          pollIntervalMs: 100,
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
          pollIntervalMs: 100,
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
        body: {
          getReader: () => ({
            cancel: () => Promise.resolve(),
            read: async () => new Promise(() => {}),
            releaseLock() {},
          }),
        },
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
          pollIntervalMs: 100,
        }),
      );
    } finally {
      input.cleanup();
    }
  });
});
