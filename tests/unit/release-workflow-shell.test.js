import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDigest = "4".repeat(40);
const version = "0.1.4";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fakeGhSource() {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.log.push(args);
function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }
function fail() { save(); process.exit(1); }
if (args[0] === "release" && process.env.GH_REPO !== process.env.GITHUB_REPOSITORY) fail();
if (args[0] === "release" && args[1] === "view") {
  if (!state.releaseExists) fail();
  if (args.includes("--json")) {
    const field = args[args.indexOf("--json") + 1];
    if (
      field === "isDraft" &&
      !state.isDraft &&
      process.env.FAIL_POST_PUBLISH_VERIFY === "true" &&
      !state.failedPostPublishVerify
    ) {
      state.failedPostPublishVerify = true;
      fail();
    }
    if (field === "isDraft") process.stdout.write(String(state.isDraft));
    else if (field === "isPrerelease") process.stdout.write(String(state.isPrerelease));
    else if (field === "assets") {
      const query = args[args.indexOf("--jq") + 1];
      if (query === ".assets | length") process.stdout.write(String(state.assets.length));
      else if (query === ".assets[].name") process.stdout.write(state.assets.join("\\n"));
      else fail();
    }
    else if (field === "databaseId") process.stdout.write(String(state.releaseId));
    else if (field === "isImmutable") process.stdout.write(String(state.immutable));
    else if (field === "targetCommitish") process.stdout.write(String(state.targetSha));
    else fail();
  }
  save(); process.exit(0);
}
if (args[0] === "api" && args[1].includes("/git/ref/tags/")) {
  if (!state.tagExists) fail();
  const query = args[args.indexOf("--jq") + 1];
  process.stdout.write(query === ".object.type" ? "commit" : state.tagSha);
  save(); process.exit(0);
}
if (args[0] === "api" && args[1].includes("/releases/tags/")) {
  if (!state.releaseExists || state.isDraft) fail();
  const query = args[args.indexOf("--jq") + 1];
  if (query === ".immutable") process.stdout.write(String(state.immutable));
  else if (query === ".target_commitish") process.stdout.write(String(state.targetSha));
  else fail();
  save(); process.exit(0);
}
if (args[0] === "release" && args[1] === "download") {
  if (!state.releaseExists) fail();
  const outputDir = args[args.indexOf("--dir") + 1];
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of state.assets) fs.copyFileSync(path.join(state.assetsDir, name), path.join(outputDir, name));
  save(); process.exit(0);
}
if (args[0] === "release" && args[1] === "create") {
  if (state.releaseExists || state.tagExists) fail();
  state.releaseExists = true; state.targetSha = process.env.GITHUB_SHA;
  state.isDraft = args.includes("--draft"); state.isPrerelease = false; state.immutable = false;
  state.tagExists = !state.isDraft; state.tagSha = process.env.GITHUB_SHA;
  state.assets = [];
  fs.mkdirSync(state.assetsDir, { recursive: true });
  for (const argument of args.slice(3)) {
    if (argument.startsWith("--")) break;
    const name = path.basename(argument); state.assets.push(name);
    fs.copyFileSync(argument, path.join(state.assetsDir, name));
  }
  save();
  if (process.env.FAIL_RELEASE_CREATE_AFTER_DRAFT === "true") process.exit(1);
  process.exit(0);
}
if (args[0] === "release" && args[1] === "upload") {
  if (!state.releaseExists || !state.isDraft) fail();
  for (const argument of args.slice(3)) {
    if (argument.startsWith("--")) break;
    const name = path.basename(argument);
    if (state.assets.includes(name)) fail();
    state.assets.push(name);
    fs.copyFileSync(argument, path.join(state.assetsDir, name));
  }
  save(); process.exit(0);
}
if (args[0] === "release" && args[1] === "edit") {
  if (args.includes("--draft=false")) {
    state.isDraft = false;
    state.immutable = state.immutableReleasesEnabled;
    state.tagExists = true;
    state.tagSha = state.targetSha;
  }
  save();
  if (process.env.FAIL_EDIT_AFTER_PUBLISH === "true") process.exit(1);
  process.exit(0);
}
if (args[0] === "release" && args[1] === "delete") {
  state.releaseExists = false; state.tagExists = false; state.immutable = false; save(); process.exit(0);
}
fail();
`;
}

function runPublisher({
  assetCount = null,
  existing = false,
  draft = false,
  failCreateAfterDraft = false,
  failEditAfterPublish = false,
  failPostPublishVerify = false,
  immutableReleasesEnabled = true,
  mismatch = false,
  prerelease = false,
} = {}) {
  const scratchRoot = join(repoRoot, "dist");
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(join(scratchRoot, "publisher-test-"));
  const binDir = join(directory, "bin");
  const releaseAssetsDir = join(directory, "release-assets");
  const remoteAssetsDir = join(directory, "remote-assets");
  const names = [
    `chzzk-${version}.zip`,
    `chzzk-${version}-release-metadata.json`,
    `chzzk-${version}-signed.xpi`,
  ];
  const existingAssetNames = existing ? names.slice(0, assetCount ?? names.length) : [];
  try {
    for (const path of [binDir, releaseAssetsDir, remoteAssetsDir]) {
      mkdirSync(path, { recursive: true });
    }
    for (const [index, name] of names.entries()) {
      writeFileSync(join(releaseAssetsDir, name), `asset-${index}`);
      if (existingAssetNames.includes(name)) {
        cpSync(join(releaseAssetsDir, name), join(remoteAssetsDir, name));
      }
    }
    if (mismatch) writeFileSync(join(remoteAssetsDir, names[2]), "tampered");

    const fakeGhModulePath = join(binDir, "fake-gh.cjs");
    const fakeGhPath = join(binDir, "gh");
    writeFileSync(fakeGhModulePath, fakeGhSource());
    writeFileSync(fakeGhPath, `#!/bin/sh\nexec node "${fakeGhModulePath}" "$@"\n`);
    chmodSync(fakeGhPath, 0o755);
    const statePath = join(directory, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        assets: existingAssetNames,
        assetsDir: remoteAssetsDir,
        immutable: existing && !draft && immutableReleasesEnabled,
        immutableReleasesEnabled,
        log: [],
        isDraft: draft,
        isPrerelease: prerelease,
        releaseExists: existing,
        releaseId: 9876,
        tagExists: existing && !draft,
        tagSha: sourceDigest,
        targetSha: sourceDigest,
      }),
    );

    const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/sign-unlisted.yml"), "utf8"));
    const publishStep = workflow.jobs.publish.steps.find(
      (step) => step.name === "Publish immutable release assets",
    );
    let script = publishStep.run;
    const replacements = new Map([
      ["${{ needs.prepare.outputs.version }}", version],
      ["${{ needs.prepare.outputs.source_sha256 }}", sha256(join(releaseAssetsDir, names[0]))],
      ["${{ needs.prepare.outputs.metadata_sha256 }}", sha256(join(releaseAssetsDir, names[1]))],
      ["${{ needs.verify-signed.outputs.signed_sha256 }}", sha256(join(releaseAssetsDir, names[2]))],
    ]);
    for (const [placeholder, value] of replacements) script = script.replaceAll(placeholder, value);
    script = `unset -f gh 2>/dev/null || true\nhash -r\n${script}`;
    const environment = {
      ...process.env,
      FAIL_EDIT_AFTER_PUBLISH: String(failEditAfterPublish),
      FAIL_RELEASE_CREATE_AFTER_DRAFT: String(failCreateAfterDraft),
      FAIL_POST_PUBLISH_VERIFY: String(failPostPublishVerify),
      FAKE_GH_STATE: statePath,
      GH_TOKEN: "synthetic-token",
      GH_REPO: publishStep.env?.GH_REPO === "${{ github.repository }}" ? "solitude0429/CHZZK" : undefined,
      GITHUB_REPOSITORY: "solitude0429/CHZZK",
      GITHUB_SHA: sourceDigest,
      PATH: `${binDir}:${process.env.PATH}`,
    };
    const result = spawnSync("bash", ["-c", script], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    return {
      cleanup: () => rmSync(directory, { force: true, recursive: true }),
      result,
      state: JSON.parse(readFileSync(statePath, "utf8")),
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

describe("immutable release publisher workflow shell", () => {
  it("fails post-publication verification if GitHub does not mark the release immutable", () => {
    const run = runPublisher({ immutableReleasesEnabled: false });
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(run.state.releaseExists, true);
      assert.equal(run.state.isDraft, false);
      assert.equal(run.state.immutable, false);
      assert.equal(
        run.state.log.some((args) => args[0] === "api" && args[1].includes("/immutable-releases")),
        false,
      );
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "delete"),
        false,
      );
    } finally {
      run.cleanup();
    }
  });

  it("is a true no-op when an existing release has the same tag and exact bytes", () => {
    const run = runPublisher({ existing: true });
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${JSON.stringify(run.state.log)}`);
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "create"),
        false,
      );
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "edit"),
        false,
      );
    } finally {
      run.cleanup();
    }
  });

  it("fails closed without overwriting an existing release when any byte differs", () => {
    const run = runPublisher({ existing: true, mismatch: true });
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(
        run.state.log.some((args) => args.includes("--clobber")),
        false,
      );
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "create"),
        false,
      );
    } finally {
      run.cleanup();
    }
  });

  it("rejects an existing prerelease instead of treating it as published reuse", () => {
    const run = runPublisher({ existing: true, prerelease: true });
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && ["create", "edit", "upload"].includes(args[1])),
        false,
      );
    } finally {
      run.cleanup();
    }
  });

  it("resumes a compatible partial draft and publishes the exact asset set", () => {
    const run = runPublisher({ assetCount: 1, draft: true, existing: true });
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${JSON.stringify(run.state.log)}`);
      assert.equal(run.state.isDraft, false);
      assert.equal(run.state.immutable, true);
      assert.deepEqual([...run.state.assets].sort(), [
        `chzzk-${version}-release-metadata.json`,
        `chzzk-${version}-signed.xpi`,
        `chzzk-${version}.zip`,
      ]);
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "create"),
        false,
      );
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "upload"),
        true,
      );
    } finally {
      run.cleanup();
    }
  });

  it("recovers when release creation reports failure after committing the draft", () => {
    const run = runPublisher({ failCreateAfterDraft: true });
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${JSON.stringify(run.state.log)}`);
      assert.equal(run.state.releaseExists, true);
      assert.equal(run.state.tagExists, true);
      assert.equal(run.state.isDraft, false);
      assert.equal(run.state.immutable, true);
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "delete"),
        false,
      );
    } finally {
      run.cleanup();
    }
  });

  it("preserves a published release when publication succeeds but the CLI reports failure", () => {
    const run = runPublisher({ failEditAfterPublish: true });
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(run.state.releaseExists, true, `${run.result.stderr}\n${JSON.stringify(run.state.log)}`);
      assert.equal(run.state.tagExists, true);
      assert.equal(run.state.isDraft, false);
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "delete"),
        false,
      );
    } finally {
      run.cleanup();
    }
  });

  it("preserves a published release when post-publication verification fails", () => {
    const run = runPublisher({ failPostPublishVerify: true });
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(run.state.releaseExists, true, `${run.result.stderr}\n${JSON.stringify(run.state.log)}`);
      assert.equal(run.state.tagExists, true);
      assert.equal(run.state.isDraft, false);
      assert.equal(
        run.state.log.some((args) => args[0] === "release" && args[1] === "delete"),
        false,
      );
    } finally {
      run.cleanup();
    }
  });

  it("publishes a new release as a verified draft before making it visible", () => {
    const run = runPublisher();
    try {
      assert.equal(run.result.status, 0, `${run.result.stderr}\n${JSON.stringify(run.state.log)}`);
      const operations = run.state.log
        .filter((args) => args[0] === "release" && ["create", "edit"].includes(args[1]))
        .map((args) => args[1]);
      assert.deepEqual(operations, ["create", "edit"]);
      assert.deepEqual([...run.state.assets].sort(), [
        `chzzk-${version}-release-metadata.json`,
        `chzzk-${version}-signed.xpi`,
        `chzzk-${version}.zip`,
      ]);
    } finally {
      run.cleanup();
    }
  });
});
