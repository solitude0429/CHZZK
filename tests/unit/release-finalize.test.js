import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

import { finalizeStagedReleaseFromAdminPreflight } from "../../scripts/lib/release-finalize.js";
import {
  RELEASE_ADD_ON_ID,
  RELEASE_PACKAGE_FILES,
  RELEASE_UPDATE_MANIFEST_URL,
  RELEASE_VERSION,
  canonicalReleaseAssetNames,
  inspectFinalizationReleaseState,
  prepareFinalizationInputs,
} from "../../scripts/lib/release-finalize-state.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const repository = "solitude0429/CHZZK";
const sourceSha = "a".repeat(40);
const version = RELEASE_VERSION;

function makeSourceTree() {
  const cwd = mkdtempSync(join(tmpdir(), "chzzk-release-finalize-"));
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ version })}\n`);
  writeFileSync(join(cwd, "manifest.json"), `${JSON.stringify({ version })}\n`);
  return cwd;
}

function compatibilityRun(overrides = {}) {
  return {
    conclusion: "success",
    display_title: `Signed Firefox compatibility v${version}`,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sourceSha,
    id: 9101,
    name: "Signed Firefox compatibility",
    path: ".github/workflows/release-compatibility.yml",
    run_attempt: 1,
    run_number: 43,
    status: "completed",
    ...overrides,
  };
}

function commandHarness({
  compatibilityRunPages = null,
  compatibilityRuns = [compatibilityRun()],
  immutableEnabled,
  publishError = null,
  workflowRunPages = null,
  workflowRuns = [
    {
      conclusion: "success",
      head_sha: sourceSha,
      id: 9001,
      run_attempt: 1,
      run_number: 42,
      status: "completed",
    },
  ],
}) {
  const calls = [];
  const run = (command, args) => {
    calls.push({ args: [...args], command });
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return `${sourceSha}\n`;
    if (command === "git" && args.join(" ") === "symbolic-ref --short HEAD") return "main\n";
    if (command === "git" && args.join(" ") === "status --porcelain") return "";
    if (command !== "gh") throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    const endpoint = args.find(
      (argument) => argument === "user" || argument.startsWith(`repos/${repository}`),
    );
    if (args[0] === "api" && endpoint === `repos/${repository}`) {
      return `${JSON.stringify({ default_branch: "main" })}\n`;
    }
    if (args[0] === "api" && endpoint === `repos/${repository}/git/ref/heads/main`) {
      return `${JSON.stringify({ object: { sha: sourceSha, type: "commit" } })}\n`;
    }
    if (args[0] === "api" && endpoint === "user") {
      return `${JSON.stringify({ login: "release-admin" })}\n`;
    }
    if (args[0] === "api" && endpoint === `repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`) {
      return `${JSON.stringify({ name: "RELEASE_OPERATOR_LOGIN", value: "release-admin" })}\n`;
    }
    if (
      args[0] === "api" &&
      endpoint ===
        `repos/${repository}/actions/workflows/sign-unlisted.yml/runs?head_sha=${sourceSha}&per_page=100`
    ) {
      return `${JSON.stringify(workflowRunPages ?? { workflow_runs: workflowRuns })}\n`;
    }
    if (
      args[0] === "api" &&
      endpoint ===
        `repos/${repository}/actions/workflows/release-compatibility.yml/runs?branch=main&event=workflow_dispatch&head_sha=${sourceSha}&per_page=100`
    ) {
      return `${JSON.stringify(compatibilityRunPages ?? { workflow_runs: compatibilityRuns })}\n`;
    }
    if (args[0] === "api" && endpoint === `repos/${repository}/immutable-releases`) {
      return `${JSON.stringify({ enabled: immutableEnabled })}\n`;
    }
    if (args[0] === "attestation" && args[1] === "verify") return "verified\n";
    if (args[0] === "api" && args.includes("PATCH") && endpoint === `repos/${repository}/releases/6001`) {
      if (publishError) throw publishError;
      return `${JSON.stringify({ draft: false, id: 6001 })}\n`;
    }
    if (args[0] === "release" && args[1] === "edit") {
      if (publishError) throw publishError;
      return "published\n";
    }
    throw new Error(`unexpected gh command: ${args.join(" ")}`);
  };
  return { calls, run };
}

function isReleasePublicationCall({ args }) {
  return (
    (args[0] === "release" && args[1] === "edit") ||
    (args[0] === "api" &&
      args.includes("PATCH") &&
      args.some((argument) => /\/releases\/[1-9][0-9]*$/.test(argument)))
  );
}

async function prepareArtifacts({ outputDir }) {
  const sourceArchivePath = join(outputDir, `chzzk-${version}.zip`);
  const metadataPath = join(outputDir, `chzzk-${version}-release-metadata.json`);
  writeFileSync(sourceArchivePath, "prepared source bytes");
  writeFileSync(metadataPath, "prepared metadata bytes");
  return {
    metadata: { sourceDigest: sourceSha, sourceRepository: repository, version },
    metadataPath,
    sourceArchivePath,
  };
}

function coreAssetSnapshot() {
  return {
    assets: [
      {
        contentType: "application/x-xpinstall",
        digest: "b".repeat(64),
        id: 7003,
        name: `chzzk-${version}-signed.xpi`,
        size: 128,
      },
    ],
    releaseId: 6001,
    tag: `v${version}`,
  };
}

function stagedInspection({ signedXpiPath }) {
  writeFileSync(signedXpiPath, "attested signed bytes");
  return {
    assetSnapshot: coreAssetSnapshot(),
    draftSignedReady: true,
    reuseExisting: false,
    signedSha256: "b".repeat(64),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobSha(bytes) {
  const value = Buffer.from(bytes);
  return createHash("sha1")
    .update(Buffer.from(`blob ${value.length}\0`))
    .update(value)
    .digest("hex");
}

let crc32Table;

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  crc32Table ??= makeCrc32Table();
  let value = 0xffffffff;
  for (const byte of bytes) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function makeZip(entries, { deflate = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const nameBytes = Buffer.from(name, "ascii");
    const entryBytes = Buffer.from(bytes);
    const payloadBytes = deflate ? deflateRawSync(entryBytes) : entryBytes;
    const compressionMethod = deflate ? 8 : 0;
    const entryCrc32 = crc32(entryBytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(entryCrc32, 14);
    localHeader.writeUInt32LE(payloadBytes.length, 18);
    localHeader.writeUInt32LE(entryBytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, payloadBytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(entryCrc32, 16);
    centralHeader.writeUInt32LE(payloadBytes.length, 20);
    centralHeader.writeUInt32LE(entryBytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payloadBytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeStoredZip(entries) {
  return makeZip(entries);
}

function makeDeflatedZip(entries) {
  return makeZip(entries, { deflate: true });
}

function writeFixtureFile(rootDir, relativePath, bytes) {
  mkdirSync(dirname(join(rootDir, relativePath)), { recursive: true });
  writeFileSync(join(rootDir, relativePath), bytes);
}

function makeReleaseMetadata({ localFiles, names, sourceBytes }) {
  return {
    addOnId: RELEASE_ADD_ON_ID,
    files: localFiles,
    schemaVersion: 1,
    sourceArchive: {
      name: names.source,
      sha256: sha256(sourceBytes),
      size: sourceBytes.length,
    },
    sourceDigest: sourceSha,
    sourceRepository: repository,
    strictMinVersion: "128.0",
    updateManifestUrl: RELEASE_UPDATE_MANIFEST_URL,
    version,
  };
}

async function makeFinalizationFixture({ deflateArchives = false, rewriteSignedManifest = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "chzzk-release-finalize-state-"));
  const outputDir = join(cwd, "verification");
  const names = canonicalReleaseAssetNames(version);
  const manifest = {
    browser_specific_settings: {
      gecko: {
        id: RELEASE_ADD_ON_ID,
        strict_min_version: "128.0",
        update_url: RELEASE_UPDATE_MANIFEST_URL,
      },
    },
    manifest_version: 2,
    name: "CHZZK test fixture",
    version,
  };
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ version })}\n`);
  for (const path of RELEASE_PACKAGE_FILES) {
    const bytes =
      path === "manifest.json"
        ? Buffer.from(`${JSON.stringify(manifest)}\n`)
        : Buffer.from(`runtime bytes for ${path}\n`);
    writeFixtureFile(cwd, path, bytes);
  }
  const prepared = await prepareFinalizationInputs({
    outputDir,
    rootDir: cwd,
    sourceDigest: sourceSha,
    sourceRepository: repository,
  });
  const runtimeEntries = RELEASE_PACKAGE_FILES.map((path) => [path, readFileSync(join(cwd, path))]);
  const zipBuilder = deflateArchives ? makeDeflatedZip : makeStoredZip;
  const sourceBytes = zipBuilder(runtimeEntries);
  const signedRuntimeEntries = runtimeEntries.map(([path, bytes]) => {
    if (path !== "manifest.json" || !rewriteSignedManifest) return [path, bytes];
    return [
      path,
      Buffer.from(
        JSON.stringify({
          version: manifest.version,
          name: manifest.name,
          manifest_version: manifest.manifest_version,
          browser_specific_settings: manifest.browser_specific_settings,
        }),
      ),
    ];
  });
  const signedBytes = zipBuilder([
    ...signedRuntimeEntries,
    ["META-INF/cose.manifest", Buffer.alloc(512, "m")],
    ["META-INF/cose.sig", Buffer.alloc(1024, "c")],
    ["META-INF/manifest.mf", Buffer.alloc(512, "f")],
    ["META-INF/mozilla.rsa", Buffer.alloc(1024, "r")],
    ["META-INF/mozilla.sf", Buffer.alloc(128, "s")],
  ]);
  const metadataBytes = Buffer.from(
    `${JSON.stringify(
      makeReleaseMetadata({ localFiles: prepared.expectedFiles, names, sourceBytes }),
      null,
      2,
    )}\n`,
  );
  const bytesByName = new Map([
    [names.source, sourceBytes],
    [names.metadata, metadataBytes],
    [names.signed, signedBytes],
  ]);
  return {
    bytesByName,
    cleanup() {
      rmSync(cwd, { force: true, recursive: true });
    },
    cwd,
    input: {
      expectedFiles: prepared.expectedFiles,
      metadataPath: prepared.metadataPath,
      repository,
      signedXpiPath: join(outputDir, names.signed),
      sourceArchivePath: prepared.sourceArchivePath,
      sourceSha,
      version,
    },
    names,
  };
}

function assetRecord(name, bytes, contentType) {
  const id = name.endsWith("-signed.xpi") ? 7003 : name.endsWith("-release-metadata.json") ? 7002 : 7001;
  return {
    content_type: contentType,
    digest: `sha256:${sha256(bytes)}`,
    id,
    name,
    size: bytes.length,
    state: "uploaded",
    uploader: { login: "github-actions[bot]", type: "Bot" },
  };
}

function finalizationStateHarness(
  fixture,
  {
    assetRecords = null,
    bytesByName = fixture.bytesByName,
    contentTypes = {
      [fixture.names.metadata]: "application/json",
      [fixture.names.signed]: "application/x-xpinstall",
      [fixture.names.source]: "application/zip",
    },
    release = {},
    tagSha = null,
  } = {},
) {
  const tag = `v${version}`;
  const records =
    assetRecords ??
    [fixture.names.source, fixture.names.metadata, fixture.names.signed].map((name) =>
      assetRecord(name, bytesByName.get(name), contentTypes[name]),
    );
  const releaseRecord = {
    assets: records,
    draft: true,
    id: 6001,
    immutable: false,
    name: `CHZZK ${version}`,
    prerelease: false,
    tag_name: tag,
    target_commitish: sourceSha,
    ...release,
  };
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    const endpoint = args.find((argument) => argument.startsWith(`repos/${repository}/`));
    if (args[0] === "api" && endpoint?.includes("/releases?per_page=100")) {
      return JSON.stringify([[releaseRecord]]);
    }
    if (args[0] === "api" && endpoint?.includes("/git/matching-refs/tags/")) {
      return JSON.stringify([
        tagSha ? [{ object: { sha: tagSha, type: "commit" }, ref: `refs/tags/${tag}` }] : [],
      ]);
    }
    if (args[0] === "release" && args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1];
      const destination = args[args.indexOf("--dir") + 1];
      writeFileSync(join(destination, name), bytesByName.get(name));
      return "";
    }
    if (args[0] === "attestation" && args[1] === "verify") return "";
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  return { calls, runGh };
}

async function inspectFixtureState(fixture, harness) {
  return inspectFinalizationReleaseState({ ...fixture.input, runGh: harness.runGh });
}

async function outsideGitHubActions(callback) {
  const originalActions = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try {
    return await callback();
  } finally {
    if (originalActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalActions;
  }
}

describe("out-of-band immutable release finalizer", { concurrency: false }, () => {
  it("exposes only an explicit out-of-band finalization command", async () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf8"));
    const wrapper = readFileSync(join(repoRoot, "scripts/finalize-release.js"), "utf8");
    const library = readFileSync(join(repoRoot, "scripts/lib/release-finalize.js"), "utf8");
    const stateLibrary = readFileSync(join(repoRoot, "scripts/lib/release-finalize-state.js"), "utf8");
    const versionLibrary = readFileSync(join(repoRoot, "scripts/lib/release-version.js"), "utf8");
    assert.equal(Object.hasOwn(packageJson.scripts, "release:finalize"), false);
    assert.equal(RELEASE_VERSION, packageJson.version);
    assert.equal(RELEASE_VERSION, manifest.version);
    assert.equal(RELEASE_ADD_ON_ID, manifest.browser_specific_settings?.gecko?.id);
    assert.equal(RELEASE_UPDATE_MANIFEST_URL, manifest.browser_specific_settings?.gecko?.update_url);
    assert.deepEqual(
      [...wrapper.matchAll(/^import\s+.*?\s+from\s+"([^"]+)";/gm)].map((match) => match[1]),
      ["node:child_process", "node:fs", "node:path", "node:url"],
    );
    assert.match(wrapper, /GITHUB_ACTIONS/);
    assert.match(wrapper, /GITHUB_TOKEN/);
    assert.match(wrapper, /GITHUB_ENTERPRISE_TOKEN/);
    assert.match(wrapper, /GH_ENTERPRISE_TOKEN/);
    for (const name of [
      "ALL_PROXY",
      "BASH_ENV",
      "CHZZK_RELEASE_ADMIN_TOKEN",
      "CURL_CA_BUNDLE",
      "ENV",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "LD_AUDIT",
      "LD_LIBRARY_PATH",
      "LD_PRELOAD",
      "NODE_EXTRA_CA_CERTS",
      "NODE_OPTIONS",
      "NODE_PATH",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "XDG_CONFIG_HOME",
    ]) {
      assert.match(wrapper, new RegExp(name));
    }
    assert.match(wrapper, /CHZZK_RELEASE_TRUSTED_GH/);
    assert.match(wrapper, /CHZZK_RELEASE_TRUSTED_GIT/);
    assert.match(wrapper, /CHZZK_GITHUB_REPOSITORY/);
    assert.match(wrapper, /finalizeStagedReleaseFromAdminPreflight/);
    assert.doesNotMatch(library, /release-artifacts|github-release-state|jszip/i);
    assert.doesNotMatch(library, /spawnSync/);
    assert.match(library, /typeof runCommand !== "function"/);
    assert.match(
      stateLibrary,
      /inflateRawSync\(compressedBytes,\s*\{\s*maxOutputLength: entry\.uncompressedSize/,
    );
    for (const source of [library, stateLibrary, versionLibrary]) {
      const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
      assert.equal(
        imports.every((specifier) => specifier.startsWith("node:") || specifier.startsWith("./")),
        true,
        `credentialed finalizer imported a package dependency: ${imports.join(", ")}`,
      );
      for (const specifier of imports.filter((value) => value.startsWith("./"))) {
        const trackedPath = `scripts/lib/${specifier.slice(2)}`;
        assert.equal(
          wrapper.includes(`"${trackedPath}"`),
          true,
          `credentialed local import is not HEAD-verified by the CLI: ${trackedPath}`,
        );
      }
    }
    assert.match(wrapper, /data:text\/javascript;base64/);
    assert.match(wrapper, /buildVerifiedFinalizerModuleUrl/);
    assert.doesNotMatch(wrapper, /await import\(["']\.\/lib\/release-finalize\.js["']\)/);
    assert.match(wrapper, /assertRemoteProtectedDefaultHead/);
    assert.match(wrapper, /function runTrustedFinalizerCommand/);
    assert.match(wrapper, /env:\s*trustedChildEnvironment\(command\)/);
    assert.match(wrapper, /env:\s*trustedChildEnvironment\("gh"\)/);
    assert.match(wrapper, /runCommand:\s*runTrustedFinalizerCommand/);
    assert.match(wrapper, /runTrustedFinalizerCommand[\s\S]*command === "git"[\s\S]*TRUSTED_GIT_PREFIX/);
    assert.match(wrapper, /protected[^\n]*!== true|protected[^\n]*=== true/);
    assert.ok(
      wrapper.indexOf("assertRemoteProtectedDefaultHead(repositoryRoot, repository)") <
        wrapper.indexOf("await import"),
      "remote protected default-head binding must precede credentialed import",
    );
    assert.ok(wrapper.indexOf("status", 0) < wrapper.indexOf("await import"));
    const rejected = spawnSync(process.execPath, [join(repoRoot, "scripts/finalize-release.js")], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true" },
    });
    if (rejected.error) {
      assert.equal(rejected.error.code, "EPERM");
      const originalActions = process.env.GITHUB_ACTIONS;
      const originalExitCode = process.exitCode;
      const originalConsoleError = console.error;
      const errors = [];
      process.env.GITHUB_ACTIONS = "true";
      console.error = (...args) => errors.push(args.join(" "));
      try {
        await import(
          new URL(`../../scripts/finalize-release.js?github-actions-refusal=${Date.now()}`, import.meta.url)
        );
        assert.match(errors.join("\n"), /out of band, never in GitHub Actions/i);
      } finally {
        if (originalActions === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = originalActions;
        process.exitCode = originalExitCode;
        console.error = originalConsoleError;
      }
    } else {
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /out of band, never in GitHub Actions/i);
    }
  });

  it("executes only the protected-head finalizer entrypoint fetched by an external bootstrap", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "chzzk-bootstrap-checkout-"));
    const localMarker = join(checkout, "local-entrypoint-executed");
    const remoteMarker = join(checkout, "remote-entrypoint-executed");
    const remoteEntrypoint = Buffer.from(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.REMOTE_MARKER, process.env.CHZZK_RELEASE_BOOTSTRAP_SHA);\n`,
    );
    const calls = [];
    const runCommand = (command, args) => {
      calls.push({ args: [...args], command });
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return `${sourceSha}\n`;
      if (command === "git" && args.join(" ") === "symbolic-ref --short HEAD") return "main\n";
      if (command === "git" && args.join(" ") === "status --porcelain") return "";
      if (command !== "gh") throw new Error(`unexpected bootstrap command: ${command}`);
      const endpoint = args.find(
        (argument) => argument === "user" || argument.startsWith(`repos/${repository}`),
      );
      if (endpoint === `repos/${repository}`) {
        return `${JSON.stringify({ archived: false, default_branch: "main", full_name: repository })}\n`;
      }
      if (endpoint === `repos/${repository}/branches/main`) {
        return `${JSON.stringify({ commit: { sha: sourceSha }, name: "main", protected: true })}\n`;
      }
      if (endpoint === "user") return `${JSON.stringify({ login: "release-admin" })}\n`;
      if (endpoint === `repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`) {
        return `${JSON.stringify({ name: "RELEASE_OPERATOR_LOGIN", value: "release-admin" })}\n`;
      }
      if (endpoint === `repos/${repository}/contents/scripts/finalize-release.js?ref=${sourceSha}`) {
        return `${JSON.stringify({
          content: remoteEntrypoint.toString("base64"),
          encoding: "base64",
          path: "scripts/finalize-release.js",
          sha: gitBlobSha(remoteEntrypoint),
          size: remoteEntrypoint.length,
          type: "file",
        })}\n`;
      }
      throw new Error(`unexpected bootstrap endpoint: ${endpoint}`);
    };
    const originalRemoteMarker = process.env.REMOTE_MARKER;
    try {
      mkdirSync(join(checkout, "scripts"), { recursive: true });
      writeFileSync(
        join(checkout, "scripts/finalize-release.js"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(localMarker)}, "unsafe");\n`,
      );
      process.env.REMOTE_MARKER = remoteMarker;
      const { runProtectedReleaseEntrypoint } = await import(
        new URL("../../scripts/admin-release-bootstrap.js", import.meta.url)
      );
      const result = await outsideGitHubActions(() =>
        runProtectedReleaseEntrypoint({ checkout, repository, runCommand }),
      );
      assert.equal(result.sourceSha, sourceSha);
      assert.equal(existsSync(localMarker), false, "the checkout entrypoint must never execute");
      assert.equal(readFileSync(remoteMarker, "utf8"), sourceSha);
      const protectedBranchIndex = calls.findIndex(({ args }) =>
        args.includes(`repos/${repository}/branches/main`),
      );
      const contentIndex = calls.findIndex(({ args }) =>
        args.includes(`repos/${repository}/contents/scripts/finalize-release.js?ref=${sourceSha}`),
      );
      assert.equal(protectedBranchIndex >= 0 && protectedBranchIndex < contentIndex, true);
    } finally {
      if (originalRemoteMarker === undefined) delete process.env.REMOTE_MARKER;
      else process.env.REMOTE_MARKER = originalRemoteMarker;
      rmSync(checkout, { force: true, recursive: true });
    }
  });

  it("dispatches staging directly from the installed protected bootstrap without repository JavaScript", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "chzzk-bootstrap-dispatch-"));
    const localMarker = join(checkout, "local-dispatch-executed");
    const calls = [];
    const runCommand = (command, args, options = {}) => {
      calls.push({ args: [...args], command, input: options.input });
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return `${sourceSha}\n`;
      if (command === "git" && args.join(" ") === "symbolic-ref --short HEAD") return "main\n";
      if (command === "git" && args.join(" ") === "status --porcelain") return "";
      if (command !== "gh") throw new Error(`unexpected bootstrap command: ${command}`);
      const endpoint = args.find(
        (argument) => argument === "user" || argument.startsWith(`repos/${repository}`),
      );
      if (endpoint === `repos/${repository}`) {
        return `${JSON.stringify({ archived: false, default_branch: "main", full_name: repository })}\n`;
      }
      if (endpoint === `repos/${repository}/branches/main`) {
        return `${JSON.stringify({ commit: { sha: sourceSha }, name: "main", protected: true })}\n`;
      }
      if (endpoint === "user") return `${JSON.stringify({ login: "release-admin" })}\n`;
      if (endpoint === `repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`) {
        return `${JSON.stringify({ name: "RELEASE_OPERATOR_LOGIN", value: "release-admin" })}\n`;
      }
      if (endpoint === `repos/${repository}/immutable-releases`) {
        return `${JSON.stringify({ enabled: true })}\n`;
      }
      if (endpoint === `repos/${repository}/dispatches` && args.includes("POST")) return "";
      throw new Error(`unexpected bootstrap endpoint: ${endpoint}`);
    };
    try {
      mkdirSync(join(checkout, "scripts"), { recursive: true });
      writeFileSync(join(checkout, "package.json"), `${JSON.stringify({ version })}\n`);
      writeFileSync(join(checkout, "manifest.json"), `${JSON.stringify({ version })}\n`);
      writeFileSync(
        join(checkout, "scripts/dispatch-release.js"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(localMarker)}, "unsafe");\n`,
      );
      const { runProtectedReleaseEntrypoint } = await import(
        new URL("../../scripts/admin-release-bootstrap.js", import.meta.url)
      );
      const result = await outsideGitHubActions(() =>
        runProtectedReleaseEntrypoint({
          checkout,
          now: () => new Date("2026-07-16T22:00:00.000Z"),
          operation: "dispatch",
          repository,
          runCommand,
        }),
      );
      assert.deepEqual(result, {
        defaultBranch: "main",
        dispatched: true,
        operatorLogin: "release-admin",
        sourceSha,
        version,
      });
      assert.equal(existsSync(localMarker), false, "dispatch must not execute checkout JavaScript");
      const dispatch = calls.find(({ args }) => args.includes(`repos/${repository}/dispatches`));
      assert.deepEqual(JSON.parse(dispatch.input), {
        client_payload: {
          default_branch: "main",
          immutable_releases_verified: true,
          operator_login: "release-admin",
          source_sha: sourceSha,
          verified_at: "2026-07-16T22:00:00.000Z",
          version,
        },
        event_type: "chzzk-release-preflight-v1",
      });
    } finally {
      rmSync(checkout, { force: true, recursive: true });
    }
  });

  it("validates a staged finalization snapshot with GitHub asset digests and local metadata", async () => {
    const fixture = await makeFinalizationFixture();
    const harness = finalizationStateHarness(fixture);
    try {
      const result = await inspectFixtureState(fixture, harness);
      assert.equal(result.draftSignedReady, true);
      assert.equal(result.reuseExisting, false);
      assert.equal(result.signedSha256, sha256(fixture.bytesByName.get(fixture.names.signed)));
      assert.equal(result.assetSnapshot.releaseId, 6001);
      assert.deepEqual(result.assetSnapshot.assets.map((asset) => asset.id).sort(), [7001, 7002, 7003]);
      assert.deepEqual(
        result.assetSnapshot.assets.map((asset) => asset.name).sort(),
        [fixture.names.metadata, fixture.names.signed, fixture.names.source].sort(),
      );
      assert.equal(
        readFileSync(fixture.input.sourceArchivePath).equals(fixture.bytesByName.get(fixture.names.source)),
        true,
      );
      assert.equal(
        readFileSync(fixture.input.metadataPath).equals(fixture.bytesByName.get(fixture.names.metadata)),
        true,
      );
      assert.equal(
        readFileSync(fixture.input.signedXpiPath).equals(fixture.bytesByName.get(fixture.names.signed)),
        true,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("validates deflated source and signed archives with bounded built-in inflation", async () => {
    const fixture = await makeFinalizationFixture({ deflateArchives: true });
    const harness = finalizationStateHarness(fixture);
    try {
      const result = await inspectFixtureState(fixture, harness);
      assert.equal(result.draftSignedReady, true);
      assert.equal(result.signedSha256, sha256(fixture.bytesByName.get(fixture.names.signed)));
    } finally {
      fixture.cleanup();
    }
  });

  it("accepts AMO manifest-only formatting changes during finalization", async () => {
    const fixture = await makeFinalizationFixture({ rewriteSignedManifest: true });
    const harness = finalizationStateHarness(fixture);
    try {
      const result = await inspectFixtureState(fixture, harness);
      assert.equal(result.draftSignedReady, true);
      assert.equal(result.reuseExisting, false);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed on malformed GitHub release asset records before download", async () => {
    const fixture = await makeFinalizationFixture();
    const source = fixture.bytesByName.get(fixture.names.source);
    const harness = finalizationStateHarness(fixture, {
      assetRecords: [
        assetRecord(fixture.names.source, source, "application/zip"),
        assetRecord(fixture.names.source, source, "application/zip"),
        assetRecord(
          fixture.names.metadata,
          fixture.bytesByName.get(fixture.names.metadata),
          "application/json",
        ),
        assetRecord(
          fixture.names.signed,
          fixture.bytesByName.get(fixture.names.signed),
          "application/x-xpinstall",
        ),
      ],
    });
    try {
      await assert.rejects(inspectFixtureState(fixture, harness), /duplicate asset/i);
      assert.equal(
        harness.calls.some((args) => args[0] === "release" && args[1] === "download"),
        false,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects noncanonical GitHub asset digests before download", async () => {
    const fixture = await makeFinalizationFixture();
    const records = [fixture.names.source, fixture.names.metadata, fixture.names.signed].map((name) =>
      assetRecord(
        name,
        fixture.bytesByName.get(name),
        name === fixture.names.metadata
          ? "application/json"
          : name === fixture.names.signed
            ? "application/x-xpinstall"
            : "application/zip",
      ),
    );
    records.find((asset) => asset.name === fixture.names.signed).digest = sha256(
      fixture.bytesByName.get(fixture.names.signed),
    );
    const harness = finalizationStateHarness(fixture, { assetRecords: records });
    try {
      await assert.rejects(inspectFixtureState(fixture, harness), /digest.*malformed/i);
      assert.equal(
        harness.calls.some((args) => args[0] === "release" && args[1] === "download"),
        false,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("validates GitHub release asset content types before using downloaded bytes", async () => {
    const fixture = await makeFinalizationFixture();
    const harness = finalizationStateHarness(fixture, {
      contentTypes: {
        [fixture.names.metadata]: "application/json",
        [fixture.names.signed]: "application/x-xpinstall",
        [fixture.names.source]: "text/html",
      },
    });
    try {
      await assert.rejects(inspectFixtureState(fixture, harness), /content type/i);
      assert.equal(
        harness.calls.some((args) => args[0] === "release" && args[1] === "download"),
        false,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects release metadata that does not match the local allowlisted file digests", async () => {
    const fixture = await makeFinalizationFixture();
    const metadata = JSON.parse(fixture.bytesByName.get(fixture.names.metadata).toString("utf8"));
    metadata.files[0] = { ...metadata.files[0], sha256: "f".repeat(64) };
    const bytesByName = new Map(fixture.bytesByName);
    bytesByName.set(fixture.names.metadata, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
    const harness = finalizationStateHarness(fixture, { bytesByName });
    try {
      await assert.rejects(inspectFixtureState(fixture, harness), /local allowlisted file/i);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses to publish when a later draft asset snapshot changes", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: true });
    let inspections = 0;
    const inspectReleaseState = ({ signedXpiPath }) => {
      inspections += 1;
      writeFileSync(signedXpiPath, "attested signed bytes");
      return {
        assetSnapshot: {
          assets: [
            {
              digest: inspections === 1 ? "a".repeat(64) : "c".repeat(64),
              name: `chzzk-${version}-signed.xpi`,
            },
          ],
          releaseId: 6001,
          tag: `v${version}`,
        },
        draftSignedReady: true,
        reuseExisting: false,
        signedSha256: "b".repeat(64),
      };
    };
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /asset bytes changed/i,
      );
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
      assert.equal(inspections, 2);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("checks the finalizer script repository before importing credentialed code", async () => {
    const scriptRepository = mkdtempSync(join(tmpdir(), "chzzk-finalizer-script-repo-"));
    const cleanCaller = mkdtempSync(join(tmpdir(), "chzzk-finalizer-clean-caller-"));
    const marker = join(scriptRepository, "imported.marker");
    try {
      mkdirSync(join(scriptRepository, "scripts/lib"), { recursive: true });
      writeFileSync(
        join(scriptRepository, "scripts/finalize-release.js"),
        readFileSync(join(repoRoot, "scripts/finalize-release.js")),
      );
      writeFileSync(
        join(scriptRepository, "scripts/lib/release-finalize.js"),
        "export async function finalizeStagedReleaseFromAdminPreflight() { throw new Error('safe fixture'); }\n",
      );
      for (const [cwd, args] of [
        [scriptRepository, ["init", "-q"]],
        [scriptRepository, ["add", "."]],
        [
          scriptRepository,
          [
            "-c",
            "user.name=CHZZK test",
            "-c",
            "user.email=chzzk-test@example.invalid",
            "commit",
            "-qm",
            "fixture",
          ],
        ],
        [cleanCaller, ["init", "-q"]],
      ]) {
        const result = spawnSync("git", args, { cwd, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      writeFileSync(
        join(scriptRepository, "scripts/lib/release-finalize.js"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.IMPORT_MARKER, "loaded");\nexport async function finalizeStagedReleaseFromAdminPreflight() { throw new Error("tampered fixture"); }\n`,
      );
      const env = {
        ...process.env,
        CHZZK_GITHUB_REPOSITORY: repository,
        IMPORT_MARKER: marker,
      };
      delete env.GITHUB_ACTIONS;
      const result = spawnSync(process.execPath, [join(scriptRepository, "scripts/finalize-release.js")], {
        cwd: cleanCaller,
        encoding: "utf8",
        env,
      });
      if (result.error) {
        assert.equal(result.error.code, "EPERM");
        const originalEnv = {
          actions: process.env.GITHUB_ACTIONS,
          marker: process.env.IMPORT_MARKER,
          repository: process.env.CHZZK_GITHUB_REPOSITORY,
        };
        const originalExitCode = process.exitCode;
        const originalConsoleError = console.error;
        const errors = [];
        delete process.env.GITHUB_ACTIONS;
        process.env.CHZZK_GITHUB_REPOSITORY = repository;
        process.env.IMPORT_MARKER = marker;
        console.error = (...args) => errors.push(args.join(" "));
        try {
          const wrapperUrl = pathToFileURL(join(scriptRepository, "scripts/finalize-release.js"));
          wrapperUrl.search = `dirty-script-repo=${Date.now()}`;
          await import(wrapperUrl.href);
          assert.match(errors.join("\n"), /clean git status|clean checkout/i);
        } finally {
          if (originalEnv.actions === undefined) delete process.env.GITHUB_ACTIONS;
          else process.env.GITHUB_ACTIONS = originalEnv.actions;
          if (originalEnv.repository === undefined) delete process.env.CHZZK_GITHUB_REPOSITORY;
          else process.env.CHZZK_GITHUB_REPOSITORY = originalEnv.repository;
          if (originalEnv.marker === undefined) delete process.env.IMPORT_MARKER;
          else process.env.IMPORT_MARKER = originalEnv.marker;
          process.exitCode = originalExitCode;
          console.error = originalConsoleError;
        }
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /clean git status|clean checkout/i);
      }
      assert.equal(existsSync(marker), false, "dirty finalizer code must not execute before the clean check");
    } finally {
      rmSync(scriptRepository, { force: true, recursive: true });
      rmSync(cleanCaller, { force: true, recursive: true });
    }
  });

  it("rejects assume-unchanged finalizer modules before importing them", () => {
    const scriptRepository = mkdtempSync(join(tmpdir(), "chzzk-finalizer-index-flags-"));
    const marker = join(scriptRepository, "imported.marker");
    try {
      mkdirSync(join(scriptRepository, "scripts/lib"), { recursive: true });
      writeFileSync(
        join(scriptRepository, "scripts/finalize-release.js"),
        readFileSync(join(repoRoot, "scripts/finalize-release.js")),
      );
      writeFileSync(
        join(scriptRepository, "scripts/lib/release-finalize.js"),
        "export async function finalizeStagedReleaseFromAdminPreflight() { throw new Error('safe fixture'); }\n",
      );
      writeFileSync(join(scriptRepository, "scripts/lib/release-finalize-state.js"), "export {};\n");
      writeFileSync(join(scriptRepository, "scripts/lib/release-version.js"), "export {};\n");
      for (const args of [
        ["init", "-q"],
        ["add", "."],
        [
          "-c",
          "user.name=CHZZK test",
          "-c",
          "user.email=chzzk-test@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ],
        ["update-index", "--assume-unchanged", "scripts/lib/release-finalize.js"],
      ]) {
        const result = spawnSync("git", args, { cwd: scriptRepository, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      writeFileSync(
        join(scriptRepository, "scripts/lib/release-finalize.js"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.IMPORT_MARKER, "loaded");\nexport async function finalizeStagedReleaseFromAdminPreflight() { throw new Error("tampered fixture"); }\n`,
      );
      const env = {
        ...process.env,
        CHZZK_GITHUB_REPOSITORY: repository,
        IMPORT_MARKER: marker,
      };
      delete env.GITHUB_ACTIONS;
      const result = spawnSync(process.execPath, [join(scriptRepository, "scripts/finalize-release.js")], {
        encoding: "utf8",
        env,
      });
      assert.notEqual(result.status, 0);
      assert.equal(
        existsSync(marker),
        false,
        "assume-unchanged finalizer code must not execute before HEAD-byte verification",
      );
    } finally {
      rmSync(scriptRepository, { force: true, recursive: true });
    }
  });

  it("neutralizes repository Git fsmonitor hooks before pre-import trust checks", () => {
    const scriptRepository = mkdtempSync(join(dirname(repoRoot), "chzzk-finalizer-git-config-"));
    const marker = join(scriptRepository, "fsmonitor-executed");
    try {
      mkdirSync(join(scriptRepository, "scripts/lib"), { recursive: true });
      writeFileSync(
        join(scriptRepository, "scripts/finalize-release.js"),
        readFileSync(join(repoRoot, "scripts/finalize-release.js")),
      );
      writeFileSync(
        join(scriptRepository, "scripts/lib/release-finalize.js"),
        "export async function finalizeStagedReleaseFromAdminPreflight() { throw new Error('safe fixture'); }\n",
      );
      writeFileSync(join(scriptRepository, "scripts/lib/release-finalize-state.js"), "export {};\n");
      writeFileSync(join(scriptRepository, "scripts/lib/release-version.js"), "export {};\n");
      for (const args of [
        ["init", "-q"],
        ["add", "."],
        ["-c", "user.name=CHZZK Test", "-c", "user.email=chzzk@example.invalid", "commit", "-qm", "fixture"],
      ]) {
        const result = spawnSync("git", args, { cwd: scriptRepository, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      const hook = join(scriptRepository, ".git", "fsmonitor-hook");
      writeFileSync(hook, '#!/bin/sh\n: > "$IMPORT_MARKER"\nprintf "\\n"\n');
      chmodSync(hook, 0o755);
      const configured = spawnSync("git", ["config", "core.fsmonitor", hook], {
        cwd: scriptRepository,
        encoding: "utf8",
      });
      assert.equal(configured.status, 0, configured.stderr);
      const env = {
        ...process.env,
        CHZZK_GITHUB_REPOSITORY: repository,
        IMPORT_MARKER: marker,
      };
      delete env.GITHUB_ACTIONS;
      const result = spawnSync(process.execPath, [join(scriptRepository, "scripts/finalize-release.js")], {
        cwd: scriptRepository,
        encoding: "utf8",
        env,
      });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(marker), false, "git preflight must not execute repository fsmonitor hooks");
    } finally {
      rmSync(scriptRepository, { force: true, recursive: true });
    }
  });

  it("requires an external trusted command runner before post-import library checks", async () => {
    const scriptRepository = mkdtempSync(join(dirname(repoRoot), "chzzk-finalizer-library-git-config-"));
    const trustedBin = mkdtempSync(join(dirname(repoRoot), "chzzk-finalizer-library-bin-"));
    const marker = join(scriptRepository, "fsmonitor-executed");
    const originalPath = process.env.PATH;
    const originalMarker = process.env.IMPORT_MARKER;
    try {
      writeFileSync(join(scriptRepository, "package.json"), `${JSON.stringify({ version })}\n`);
      writeFileSync(join(scriptRepository, "manifest.json"), `${JSON.stringify({ version })}\n`);
      for (const args of [
        ["init", "-q", "-b", "main"],
        ["add", "."],
        ["-c", "user.name=CHZZK Test", "-c", "user.email=chzzk@example.invalid", "commit", "-qm", "fixture"],
      ]) {
        const result = spawnSync("git", args, { cwd: scriptRepository, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      const source = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: scriptRepository,
        encoding: "utf8",
      }).stdout.trim();
      const hook = join(scriptRepository, ".git", "fsmonitor-hook");
      writeFileSync(hook, '#!/bin/sh\n: > "$IMPORT_MARKER"\nprintf "\\n"\n');
      chmodSync(hook, 0o755);
      const configured = spawnSync("git", ["config", "core.fsmonitor", hook], {
        cwd: scriptRepository,
        encoding: "utf8",
      });
      assert.equal(configured.status, 0, configured.stderr);

      const fakeGh = join(trustedBin, "gh");
      writeFileSync(
        fakeGh,
        `#!/bin/sh\nendpoint=""\nfor argument do endpoint="$argument"; done\ncase "$endpoint" in\n  "repos/${repository}") printf '%s\\n' '${JSON.stringify({ default_branch: "main" })}' ;;\n  "repos/${repository}/git/ref/heads/main") printf '%s\\n' '${JSON.stringify({ object: { sha: source, type: "commit" } })}' ;;\n  "user") printf '%s\\n' '${JSON.stringify({ login: "release-admin" })}' ;;\n  "repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN") printf '%s\\n' '${JSON.stringify({ name: "RELEASE_OPERATOR_LOGIN", value: "release-admin" })}' ;;\n  *) printf '%s\\n' 'unexpected endpoint' >&2; exit 1 ;;\nesac\n`,
      );
      chmodSync(fakeGh, 0o755);
      process.env.PATH = `${trustedBin}:/usr/bin:/bin`;
      process.env.IMPORT_MARKER = marker;
      const ghProbe = spawnSync("gh", ["probe"], { encoding: "utf8" });
      assert.match(ghProbe.stderr, /unexpected endpoint/);
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({ cwd: scriptRepository, repository }),
        /trusted command runner/i,
      );
      assert.equal(
        existsSync(marker),
        false,
        "credentialed library Git checks must not execute repository fsmonitor hooks",
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalMarker === undefined) delete process.env.IMPORT_MARKER;
      else process.env.IMPORT_MARKER = originalMarker;
      rmSync(scriptRepository, { force: true, recursive: true });
      rmSync(trustedBin, { force: true, recursive: true });
    }
  });

  it("does not execute ignored node_modules-style command shims from the caller PATH", () => {
    const maliciousBin = mkdtempSync(join(dirname(repoRoot), "chzzk-finalizer-malicious-bin-"));
    const marker = join(maliciousBin, "executed");
    const fakeGit = join(maliciousBin, "git");
    writeFileSync(fakeGit, '#!/bin/sh\n: > "$IMPORT_MARKER"\nexit 1\n');
    chmodSync(fakeGit, 0o755);
    const env = {
      ...process.env,
      CHZZK_GITHUB_REPOSITORY: repository,
      IMPORT_MARKER: marker,
      PATH: maliciousBin,
    };
    delete env.GITHUB_ACTIONS;
    try {
      const result = spawnSync(process.execPath, [join(repoRoot, "scripts/finalize-release.js")], {
        encoding: "utf8",
        env,
      });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(marker), false, "the preflight must not execute a caller-controlled git shim");
    } finally {
      rmSync(maliciousBin, { force: true, recursive: true });
    }
  });

  it("passes only an explicit allowlisted environment to credentialed child processes", () => {
    const scriptRepository = mkdtempSync(join(dirname(repoRoot), "chzzk-finalizer-child-env-"));
    const trustedBin = mkdtempSync(join(dirname(repoRoot), "chzzk-finalizer-child-bin-"));
    const attackerHome = mkdtempSync(join(dirname(repoRoot), "chzzk-finalizer-attacker-home-"));
    const gitEnvironmentLog = join(trustedBin, "git.env");
    const ghEnvironmentLog = join(trustedBin, "gh.env");
    const fakeGit = join(trustedBin, "git");
    const fakeGh = join(trustedBin, "gh");
    const ambientNames = [
      "ALL_PROXY",
      "CURL_CA_BUNDLE",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "REQUESTS_CA_BUNDLE",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "XDG_CONFIG_HOME",
      "all_proxy",
      "https_proxy",
      "http_proxy",
      "no_proxy",
    ];
    const parseEnvironment = (path) =>
      Object.fromEntries(
        readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    try {
      mkdirSync(join(scriptRepository, "scripts/lib"), { recursive: true });
      for (const path of [
        "scripts/finalize-release.js",
        "scripts/lib/release-finalize-state.js",
        "scripts/lib/release-finalize.js",
        "scripts/lib/release-version.js",
      ]) {
        writeFileSync(join(scriptRepository, path), readFileSync(join(repoRoot, path)));
      }
      for (const args of [
        ["init", "-q", "-b", "main"],
        ["add", "."],
        ["-c", "user.name=CHZZK Test", "-c", "user.email=chzzk@example.invalid", "commit", "-qm", "fixture"],
      ]) {
        const result = spawnSync("/usr/bin/git", args, { cwd: scriptRepository, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(gitEnvironmentLog.includes("'"), false);
      assert.equal(ghEnvironmentLog.includes("'"), false);
      writeFileSync(
        fakeGit,
        `#!/bin/sh\n/usr/bin/env > '${gitEnvironmentLog}'\ncase " $* " in *" status --porcelain "*) exit 0 ;; esac\nexec /usr/bin/git "$@"\n`,
      );
      writeFileSync(fakeGh, `#!/bin/sh\n/usr/bin/env > '${ghEnvironmentLog}'\nexit 91\n`);
      chmodSync(fakeGit, 0o755);
      chmodSync(fakeGh, 0o755);
      mkdirSync(join(attackerHome, ".config/gh"), { recursive: true });
      writeFileSync(join(attackerHome, ".config/gh/config.yml"), "http_unix_socket: /tmp/evil.sock\n");

      const env = {
        ...process.env,
        CHZZK_GITHUB_REPOSITORY: repository,
        CHZZK_RELEASE_TRUSTED_GH: fakeGh,
        CHZZK_RELEASE_TRUSTED_GIT: fakeGit,
        GH_TOKEN: "synthetic-release-admin-token",
        HOME: attackerHome,
      };
      for (const name of ambientNames) env[name] = `attacker-controlled-${name.toLowerCase()}`;
      delete env.GITHUB_ACTIONS;
      const result = spawnSync(process.execPath, [join(scriptRepository, "scripts/finalize-release.js")], {
        cwd: scriptRepository,
        encoding: "utf8",
        env,
      });
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(gitEnvironmentLog), true);
      assert.equal(existsSync(ghEnvironmentLog), true, result.stderr);
      const gitEnvironment = parseEnvironment(gitEnvironmentLog);
      const ghEnvironment = parseEnvironment(ghEnvironmentLog);
      for (const name of ambientNames) {
        assert.equal(gitEnvironment[name], undefined, `${name} leaked into git`);
        assert.equal(ghEnvironment[name], undefined, `${name} leaked into gh`);
      }
      assert.equal(gitEnvironment.GH_TOKEN, undefined, "git must not receive the GitHub release token");
      assert.equal(ghEnvironment.GH_TOKEN, "synthetic-release-admin-token");
      assert.notEqual(gitEnvironment.HOME, attackerHome, "git must not inherit the caller HOME");
      assert.notEqual(ghEnvironment.HOME, attackerHome, "gh must not inherit the caller HOME");
      assert.equal(
        ghEnvironment.GH_CONFIG_DIR?.startsWith(attackerHome),
        false,
        "gh must use an operator-bootstrap-owned config directory",
      );
      assert.equal(
        ghEnvironment.XDG_CACHE_HOME?.startsWith(attackerHome),
        false,
        "gh must use an operator-bootstrap-owned cache directory",
      );
    } finally {
      rmSync(attackerHome, { force: true, recursive: true });
      rmSync(scriptRepository, { force: true, recursive: true });
      rmSync(trustedBin, { force: true, recursive: true });
    }
  });

  it("keeps the GitHub Actions refusal in the CLI boundary so CI can exercise the library", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: false });
    const original = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository: "solitude0429/CHZZK",
          runCommand: harness.run,
        }),
        /immutable release finalization preflight did not return enabled/i,
      );
    } finally {
      if (original === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = original;
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses to publish until every exact-source staging workflow run is complete", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      immutableEnabled: true,
      workflowRuns: [
        {
          conclusion: null,
          head_sha: sourceSha,
          id: 9001,
          run_attempt: 1,
          run_number: 42,
          status: "in_progress",
        },
      ],
    });
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /staging workflow.*complete/i,
      );
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("allows an older failed exact-source run after a newer successful staging run", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      immutableEnabled: true,
      workflowRuns: [
        {
          conclusion: "failure",
          head_sha: sourceSha,
          id: 9001,
          run_attempt: 1,
          run_number: 41,
          status: "completed",
        },
        {
          conclusion: "success",
          head_sha: sourceSha,
          id: 9002,
          run_attempt: 1,
          run_number: 42,
          status: "completed",
        },
      ],
    });
    let inspections = 0;
    const inspectReleaseState = (input) => {
      inspections += 1;
      if (inspections < 4) return stagedInspection(input);
      return {
        assetSnapshot: coreAssetSnapshot(),
        draftSignedReady: false,
        reuseExisting: true,
        signedSha256: "b".repeat(64),
      };
    };
    try {
      const result = await finalizeStagedReleaseFromAdminPreflight({
        cwd,
        inspectReleaseState,
        prepareArtifacts,
        repository,
        runCommand: harness.run,
      });
      assert.equal(result.alreadyPublished, false);
      assert.equal(harness.calls.filter(isReleasePublicationCall).length, 1);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses to publish when the newest exact-source staging workflow run failed", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      immutableEnabled: true,
      workflowRuns: [
        {
          conclusion: "success",
          head_sha: sourceSha,
          id: 9001,
          run_attempt: 1,
          run_number: 41,
          status: "completed",
        },
        {
          conclusion: "failure",
          head_sha: sourceSha,
          id: 9002,
          run_attempt: 1,
          run_number: 42,
          status: "completed",
        },
      ],
    });
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /newest.*staging workflow.*(?:succeed|success)/i,
      );
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("checks every workflow-run page before publishing", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      immutableEnabled: true,
      workflowRunPages: [
        {
          workflow_runs: [
            {
              conclusion: "success",
              head_sha: sourceSha,
              id: 9001,
              run_attempt: 1,
              run_number: 41,
              status: "completed",
            },
          ],
        },
        {
          workflow_runs: [
            {
              conclusion: null,
              head_sha: sourceSha,
              id: 9002,
              run_attempt: 1,
              run_number: 42,
              status: "queued",
            },
          ],
        },
      ],
    });
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /staging workflow.*complete/i,
      );
      const lookup = harness.calls.find(({ args }) =>
        args.at(-1).includes("actions/workflows/sign-unlisted.yml/runs?"),
      );
      assert.equal(lookup.args.includes("--paginate"), true);
      assert.equal(lookup.args.includes("--slurp"), true);
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses to publish without a manual compatibility run for the exact draft tag", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      compatibilityRuns: [compatibilityRun({ display_title: "Signed Firefox compatibility v0.1.6" })],
      immutableEnabled: true,
    });
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /manually dispatched.*exact draft tag/i,
      );
      const lookup = harness.calls.find(({ args }) =>
        args.some((argument) => argument.includes("actions/workflows/release-compatibility.yml/runs?")),
      );
      assert.equal(lookup.args.includes("--paginate"), true);
      assert.equal(lookup.args.includes("--slurp"), true);
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses to publish until every exact-tag compatibility run is complete", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      compatibilityRuns: [compatibilityRun({ conclusion: null, status: "in_progress" })],
      immutableEnabled: true,
    });
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /exact-tag signed compatibility workflow.*complete/i,
      );
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses to publish when the newest exact-tag compatibility run failed", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      compatibilityRuns: [
        compatibilityRun(),
        compatibilityRun({ conclusion: "failure", id: 9102, run_number: 44 }),
      ],
      immutableEnabled: true,
    });
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /newest exact-tag signed compatibility workflow.*succeed/i,
      );
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses to publish when the just-in-time administrator check says immutable releases are disabled", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: false });
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState: stagedInspection,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /immutable release|enabled/i,
      );
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
      const immutableIndex = harness.calls.findIndex(({ args }) =>
        args.includes(`repos/${repository}/immutable-releases`),
      );
      const attestationIndex = harness.calls.findLastIndex(({ args }) => args[0] === "attestation");
      assert.equal(immutableIndex > attestationIndex, true);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses publication when the release ID changes during the immediate pre-publication inspection", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: true });
    let inspections = 0;
    const inspectReleaseState = (input) => {
      inspections += 1;
      const state = stagedInspection(input);
      if (inspections === 3) {
        state.assetSnapshot = { ...state.assetSnapshot, releaseId: 6002 };
      }
      return state;
    };
    try {
      await assert.rejects(
        finalizeStagedReleaseFromAdminPreflight({
          cwd,
          inspectReleaseState,
          prepareArtifacts,
          repository,
          runCommand: harness.run,
        }),
        /identity.*changed immediately before publication/i,
      );
      assert.equal(
        harness.calls.some(({ args }) => args.includes(`repos/${repository}/releases/6001`)),
        false,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("publishes only the exact inspected release ID after an immediate third draft inspection", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: true });
    let inspections = 0;
    const assetSnapshot = {
      assets: [
        {
          contentType: "application/x-xpinstall",
          digest: "b".repeat(64),
          id: 7001,
          name: `chzzk-${version}-signed.xpi`,
          size: 128,
        },
      ],
      releaseId: 6001,
      tag: `v${version}`,
    };
    const inspectReleaseState = ({ signedXpiPath }) => {
      inspections += 1;
      writeFileSync(signedXpiPath, "attested signed bytes");
      const published = inspections === 4;
      return {
        assetSnapshot,
        draftSignedReady: !published,
        reuseExisting: published,
        signedSha256: "b".repeat(64),
      };
    };
    try {
      const result = await finalizeStagedReleaseFromAdminPreflight({
        cwd,
        inspectReleaseState,
        prepareArtifacts,
        repository,
        runCommand: harness.run,
      });
      assert.equal(result.alreadyPublished, false);
      assert.equal(inspections, 4);
      const publish = harness.calls.find(({ args }) =>
        args.includes(`repos/${repository}/releases/${assetSnapshot.releaseId}`),
      );
      assert.equal(publish.command, "gh");
      assert.equal(publish.args.includes("PATCH"), true);
      assert.equal(publish.args.includes("draft=false"), true);
      assert.equal(publish.args.includes(`tag_name=v${version}`), true);
      assert.equal(publish.args.includes(`target_commitish=${sourceSha}`), true);
      assert.equal(harness.calls.filter(isReleasePublicationCall).length, 1);
      assert.equal(
        harness.calls.some(({ args }) => args[0] === "release" && args[1] === "edit"),
        false,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("publishes only after three exact draft inspections, attestations, and the final immutable check", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: true });
    let inspections = 0;
    const inspectReleaseState = (input) => {
      inspections += 1;
      if (inspections < 4) return stagedInspection(input);
      return {
        assetSnapshot: coreAssetSnapshot(),
        draftSignedReady: false,
        reuseExisting: true,
        signedSha256: "b".repeat(64),
      };
    };
    try {
      const result = await finalizeStagedReleaseFromAdminPreflight({
        cwd,
        inspectReleaseState,
        prepareArtifacts,
        repository,
        runCommand: harness.run,
      });
      assert.equal(result.alreadyPublished, false);
      assert.equal(result.recoveredAmbiguousPublish, false);
      assert.equal(result.sourceSha, sourceSha);
      assert.equal(result.tag, `v${version}`);
      assert.equal(inspections, 4);

      const immutableIndex = harness.calls.findIndex(({ args }) =>
        args.includes(`repos/${repository}/immutable-releases`),
      );
      const publishIndex = harness.calls.findIndex(({ args }) =>
        args.includes(`repos/${repository}/releases/6001`),
      );
      const attestationIndex = harness.calls.findLastIndex(({ args }) => args[0] === "attestation");
      assert.equal(attestationIndex < immutableIndex, true);
      assert.equal(immutableIndex < publishIndex, true);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("accepts the expected draft-to-immutable transition when exact asset bytes remain unchanged", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: true });
    let inspections = 0;
    const assets = [
      {
        contentType: "application/x-xpinstall",
        digest: "b".repeat(64),
        id: 7003,
        name: `chzzk-${version}-signed.xpi`,
        size: 128,
      },
    ];
    const inspectReleaseState = ({ signedXpiPath }) => {
      inspections += 1;
      writeFileSync(signedXpiPath, "attested signed bytes");
      const published = inspections === 4;
      return {
        assetSnapshot: {
          assets,
          immutable: published,
          releaseId: 6001,
          tag: `v${version}`,
        },
        draftSignedReady: !published,
        reuseExisting: published,
        signedSha256: "b".repeat(64),
      };
    };
    try {
      const result = await finalizeStagedReleaseFromAdminPreflight({
        cwd,
        inspectReleaseState,
        prepareArtifacts,
        repository,
        runCommand: harness.run,
      });
      assert.equal(result.alreadyPublished, false);
      assert.equal(inspections, 4);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("recovers a lost publish response only when the post-state is exact and immutable", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({
      immutableEnabled: true,
      publishError: new Error("synthetic lost publish response"),
    });
    let inspections = 0;
    const inspectReleaseState = (input) => {
      inspections += 1;
      if (inspections < 4) return stagedInspection(input);
      return {
        assetSnapshot: coreAssetSnapshot(),
        draftSignedReady: false,
        reuseExisting: true,
        signedSha256: "b".repeat(64),
      };
    };
    try {
      const result = await finalizeStagedReleaseFromAdminPreflight({
        cwd,
        inspectReleaseState,
        prepareArtifacts,
        repository,
        runCommand: harness.run,
      });
      assert.equal(result.recoveredAmbiguousPublish, true);
      assert.equal(inspections, 4);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("treats an already verified immutable release as a mutation-free no-op", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness({ immutableEnabled: true });
    let inspections = 0;
    try {
      const result = await finalizeStagedReleaseFromAdminPreflight({
        cwd,
        inspectReleaseState() {
          inspections += 1;
          return { draftSignedReady: false, reuseExisting: true, signedSha256: "b".repeat(64) };
        },
        prepareArtifacts,
        repository,
        runCommand: harness.run,
      });
      assert.equal(result.alreadyPublished, true);
      assert.equal(inspections, 1);
      assert.equal(harness.calls.some(isReleasePublicationCall), false);
      assert.equal(
        harness.calls.some(({ args }) => args.includes(`repos/${repository}/immutable-releases`)),
        true,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
