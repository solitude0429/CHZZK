import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OPS_DEFAULT_BRANCH,
  OPS_LOGIN,
  OPS_REPOSITORY,
  assertUtcReleaseSlot,
  branchChangesProduct,
  classifyDailyReleaseState,
  compareUtcVersions,
  createSubprocessRunner,
  finalizeDeploymentResult,
  formatUtcVersion,
  mergeExactHead,
  normalizeRepositoryRemote,
  parseCliArguments,
  parseReleaseRunTitle,
  parseUtcVersion,
  publishPreparedDraft,
  queueShipPending,
  readServerStatus,
  redactSensitive,
  reusableSuccessfulRun,
  selectPreviousSignedRelease,
  shipCurrentBranch,
  validateCompatibleDraftAssets,
  validateServerProvenanceAgainstRelease,
} from "../../scripts/chzzk-ops.js";

const sha = "a".repeat(40);
const mergeSha = "b".repeat(40);
const nonce = "c".repeat(32);

function response(value, status = 0) {
  return {
    status,
    stderr: status === 0 ? "" : String(value),
    stdout: status === 0 ? (typeof value === "string" ? value : JSON.stringify(value)) : "",
  };
}

function serverReleaseFixture(version = "26.8.30") {
  const digests = {
    metadata: "1".repeat(64),
    signed: "2".repeat(64),
    source: "3".repeat(64),
  };
  const names = {
    metadata: `chzzk-${version}-release-metadata.json`,
    signed: `chzzk-${version}-signed.xpi`,
    source: `chzzk-${version}.zip`,
  };
  return {
    provenance: {
      assets: Object.fromEntries(Object.entries(names).map(([kind, name]) => [name, digests[kind]])),
      schemaVersion: 1,
      sourceDigest: sha,
      sourceRepository: OPS_REPOSITORY,
      version,
    },
    release: {
      assets: Object.entries(names).map(([kind, name]) => ({
        digest: `sha256:${digests[kind]}`,
        name,
        state: "uploaded",
      })),
      draft: false,
      immutable: true,
      tag_name: `v${version}`,
      target_commitish: sha,
    },
    version,
  };
}

describe("CHZZK operator CLI contract", () => {
  it("uses one canonical calendar version per UTC day", () => {
    assert.equal(formatUtcVersion(new Date("2026-08-30T23:59:59.999Z")), "26.8.30");
    assert.equal(formatUtcVersion(new Date("2026-08-30T00:00:00.000-07:00")), "26.8.30");
    assert.deepEqual(
      {
        canonical: parseUtcVersion("24.2.29").canonical,
        year: parseUtcVersion("24.2.29").year,
      },
      { canonical: "24.2.29", year: 2024 },
    );
    assert.equal(compareUtcVersions("26.8.29", "26.8.30") < 0, true);
    assert.throws(() => parseUtcVersion("26.08.30"), /canonical/i);
    assert.throws(() => parseUtcVersion("25.2.29"), /real UTC calendar date/i);
    assert.equal(assertUtcReleaseSlot("26.8.30", new Date("2026-08-30T23:59:59Z")), "26.8.30");
    assert.throws(() => assertUtcReleaseSlot("26.8.30", new Date("2026-08-31T00:00:00Z")), /rolled over/i);
  });

  it("accepts the public positional deploy and rollback spelling", () => {
    assert.deepEqual(parseCliArguments(["status", "--json"]), {
      command: "status",
      json: true,
      version: null,
    });
    assert.deepEqual(parseCliArguments(["deploy", "26.8.30"]), {
      command: "deploy",
      json: false,
      version: "26.8.30",
    });
    assert.deepEqual(parseCliArguments(["rollback", "--version", "26.8.29", "--json"]), {
      command: "rollback",
      json: true,
      version: "26.8.29",
    });
    assert.deepEqual(parseCliArguments(["rollback", "0.1.23"]), {
      command: "rollback",
      json: false,
      version: "0.1.23",
    });
    assert.throws(() => parseCliArguments(["rollback"]), /requires/i);
    assert.throws(() => parseCliArguments(["release", "26.8.30"]), /does not accept/i);
    assert.throws(
      () => parseCliArguments(["deploy", "26.8.30", "--version", "26.8.29"]),
      /either positionally/i,
    );
  });

  it("normalizes only canonical GitHub remotes", () => {
    assert.equal(normalizeRepositoryRemote("https://github.com/solitude0429/CHZZK.git"), OPS_REPOSITORY);
    assert.equal(normalizeRepositoryRemote("git@github.com:solitude0429/CHZZK.git"), OPS_REPOSITORY);
    assert.throws(() => normalizeRepositoryRemote("https://token@github.com/solitude0429/CHZZK.git"));
    assert.throws(() => normalizeRepositoryRemote("https://example.com/solitude0429/CHZZK.git"));
  });

  it("never extracts a gh token and always spawns without a shell", async () => {
    const calls = [];
    const runner = createSubprocessRunner({
      environment: { GH_TOKEN: "must-not-propagate", GITHUB_TOKEN: "also-remove", PATH: "synthetic" },
      spawn(command, args, options) {
        calls.push({ args, command, options });
        return { status: 0, stderr: "", stdout: "ok\n" };
      },
    });
    assert.equal((await runner("gh", ["api", "user"])).stdout, "ok");
    assert.equal(calls[0].options.shell, false);
    assert.deepEqual(calls[0].options.env, { PATH: "synthetic" });
    await assert.rejects(() => runner("gh", ["auth", "token"]), /never extract/i);
    assert.equal(calls.length, 1);
  });

  it("redacts credentials from operator errors", () => {
    assert.equal(redactSensitive("token=super-secret-value"), "token=[redacted]");
    assert.equal(
      redactSensitive("https://someone:password@github.com/solitude0429/CHZZK"),
      "https://[redacted]@github.com/solitude0429/CHZZK",
    );
    assert.equal(redactSensitive("gho_abcdefghijklmnopqrstuvwxyz"), "[redacted]");
  });

  it("recognizes the exact workflow run title emitted by sign-unlisted", () => {
    assert.deepEqual(parseReleaseRunTitle(`Release assets ${nonce}`), { nonce });
    assert.equal(parseReleaseRunTitle(`Release assets ${nonce.slice(1)}`), null);
    assert.equal(parseReleaseRunTitle(`Release assets ${nonce} extra`), null);
  });
});

describe("product and release input classification", () => {
  it("classifies a deleted product file as a product change", async () => {
    let diffArguments = null;
    const run = async (command, args) => {
      assert.equal(command, "git");
      diffArguments = args;
      return response("manifest.json\n");
    };
    assert.equal(
      await branchChangesProduct(run, {
        branch: "agent/delete-manifest",
        headSha: sha,
        remoteMainSha: "d".repeat(40),
        root: "C:\\repo",
      }),
      true,
    );
    assert.equal(diffArguments.includes("--diff-filter=ACDMRT"), true);
  });

  it("chooses only the highest immutable version older than the deployment target", () => {
    const selected = selectPreviousSignedRelease(
      [
        { isImmutable: true, publishedAt: "2026-09-01T00:00:00Z", tagName: "v26.9.1" },
        { isImmutable: true, publishedAt: "2026-08-01T00:00:00Z", tagName: "v26.8.29" },
        { isImmutable: true, publishedAt: "2026-08-29T00:00:00Z", tagName: "v0.1.23" },
        { isImmutable: false, publishedAt: "2026-08-30T00:00:00Z", tagName: "v26.8.30" },
      ],
      "26.8.30",
    );
    assert.equal(selected.version, "26.8.29");
  });

  it("rejects every incompatible draft asset before returning uploads", () => {
    const verified = {
      digests: { metadata: "a".repeat(64), signed: "b".repeat(64), source: "c".repeat(64) },
      names: { metadata: "metadata.json", signed: "signed.xpi", source: "source.zip" },
    };
    const signed = {
      digest: `sha256:${verified.digests.signed}`,
      name: verified.names.signed,
      state: "uploaded",
    };
    assert.deepEqual(validateCompatibleDraftAssets([signed], verified), [
      ["metadata", "metadata.json"],
      ["source", "source.zip"],
    ]);
    assert.throws(
      () =>
        validateCompatibleDraftAssets(
          [{ digest: `sha256:${"d".repeat(64)}`, name: "foreign.bin", state: "uploaded" }],
          verified,
        ),
      /unexpected asset/i,
    );
    assert.throws(() => validateCompatibleDraftAssets([{ ...signed, state: "new" }], verified), /differs/i);
  });
});

describe("final mutation guards", () => {
  it("does not publish a prepared draft after protected main changes", async () => {
    const calls = [];
    const run = async (command, args) => {
      calls.push({ args, command });
      if (args.at(-1).endsWith("/immutable-releases")) return response({ enabled: true });
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const staleSha = "d".repeat(40);
    await assert.rejects(
      () =>
        publishPreparedDraft({
          context: { root: "C:\\repo" },
          readContext: async () => ({
            branch: OPS_DEFAULT_BRANCH,
            clean: true,
            headSha: staleSha,
            remoteMainSha: staleSha,
            root: "C:\\repo",
          }),
          releaseId: 42,
          run,
          sourceSha: sha,
        }),
      /protected main changed/i,
    );
    assert.equal(
      calls.some(({ args }) => args.includes("PATCH")),
      false,
    );
  });

  it("does not invoke a merge after the UTC release slot rolls over", async () => {
    const calls = [];
    await assert.rejects(
      () =>
        mergeExactHead({
          context: { headSha: sha, root: "C:\\repo" },
          expectedUtcVersion: "26.8.30",
          now: () => new Date("2026-08-31T00:00:00.000Z"),
          pullRequestNumber: 104,
          run: async (...call) => {
            calls.push(call);
            return response("");
          },
        }),
      /rolled over/i,
    );
    assert.equal(calls.length, 0);
  });
});

describe("deployment completion", () => {
  it("fails a nominal deployment when remote staging cleanup fails", () => {
    const deploymentResult = { version: "26.8.30" };
    assert.equal(
      finalizeDeploymentResult({ cleanupFailure: null, deploymentResult, operationError: null }),
      deploymentResult,
    );
    assert.throws(
      () =>
        finalizeDeploymentResult({
          cleanupFailure: "remote staging cleanup failed",
          deploymentResult,
          operationError: null,
        }),
      /remote staging cleanup failed/i,
    );
  });

  it("preserves both the primary deployment error and cleanup failure", () => {
    assert.throws(
      () =>
        finalizeDeploymentResult({
          cleanupFailure: "remote staging cleanup failed",
          deploymentResult: null,
          operationError: new Error("activation failed"),
        }),
      /activation failed; remote staging cleanup failed/i,
    );
  });
});

describe("server status provenance", () => {
  it("binds server status to the immutable release and verifies its attestation", async () => {
    const fixture = serverReleaseFixture();
    const calls = [];
    let liveArguments = null;
    const run = async (command, args) => {
      calls.push({ args, command });
      if (command === "ssh" && args.some((argument) => argument.endsWith("/readlink"))) {
        return response(`releases/${fixture.version}`);
      }
      if (command === "ssh" && args.some((argument) => argument.endsWith("/cat"))) {
        return response(fixture.provenance);
      }
      if (command === "gh" && args[0] === "api") return response(fixture.release);
      if (command === "gh" && args[0] === "release" && args[1] === "verify") return response("");
      if (command === "ssh" && args.some((argument) => argument.endsWith("/systemctl"))) {
        return response("active\nactive\n");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const status = await readServerStatus({
      context: { root: "C:\\repo" },
      run,
      verifyLiveReadback: async (arguments_) => {
        liveArguments = arguments_;
        return { status: "passed" };
      },
    });
    assert.equal(status.version, fixture.version);
    assert.deepEqual(liveArguments, {
      root: "C:\\repo",
      signedXpiSha256: fixture.provenance.assets[`chzzk-${fixture.version}-signed.xpi`],
      sourceSha: sha,
      version: fixture.version,
    });
    assert.equal(
      calls.some(({ args }) => args[0] === "release" && args[1] === "verify"),
      true,
    );
  });

  it("rejects server provenance that is self-consistent but differs from the release", async () => {
    const fixture = serverReleaseFixture();
    fixture.provenance.assets[`chzzk-${fixture.version}-signed.xpi`] = "4".repeat(64);
    assert.throws(
      () => validateServerProvenanceAgainstRelease(fixture),
      /differs from immutable release asset/i,
    );
    let liveReadbackCalled = false;
    const run = async (command, args) => {
      if (command === "ssh" && args.some((argument) => argument.endsWith("/readlink"))) {
        return response(`releases/${fixture.version}`);
      }
      if (command === "ssh" && args.some((argument) => argument.endsWith("/cat"))) {
        return response(fixture.provenance);
      }
      if (command === "gh" && args[0] === "api") return response(fixture.release);
      throw new Error(`unexpected command after release mismatch: ${command} ${args.join(" ")}`);
    };
    await assert.rejects(
      () =>
        readServerStatus({
          context: { root: "C:\\repo" },
          run,
          verifyLiveReadback: async () => {
            liveReadbackCalled = true;
          },
        }),
      /differs from immutable release asset/i,
    );
    assert.equal(liveReadbackCalled, false);
  });
});

describe("daily release state", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const version = "26.8.30";

  it("reports one exact immutable release as idempotently published", () => {
    const release = {
      isDraft: false,
      isImmutable: true,
      publishedAt: "2026-08-30T01:00:00.000Z",
      tagName: "v26.8.30",
      targetCommitish: sha,
    };
    const state = classifyDailyReleaseState({ headSha: sha, now, releases: [release], runs: [], version });
    assert.equal(state.kind, "published");
    assert.equal(state.release, release);
  });

  it("surfaces one exact in-progress workflow as pending", () => {
    const run = {
      displayTitle: `Release assets ${nonce}`,
      headSha: sha,
      status: "in_progress",
    };
    const state = classifyDailyReleaseState({ headSha: sha, now, releases: [], runs: [run], version });
    assert.equal(state.kind, "workflow");
    assert.equal(state.pendingRun, run);
  });

  it("fails closed on a second or differently named release in the same UTC day", () => {
    assert.throws(
      () =>
        classifyDailyReleaseState({
          headSha: sha,
          now,
          releases: [
            {
              isDraft: false,
              isImmutable: true,
              publishedAt: "2026-08-30T01:00:00.000Z",
              tagName: "v26.8.29",
            },
          ],
          runs: [],
          version,
        }),
      /consumed this UTC release day/i,
    );
    assert.throws(
      () =>
        classifyDailyReleaseState({
          headSha: sha,
          now,
          releases: [],
          runs: [
            { displayTitle: `Release assets ${nonce}`, headSha: sha, status: "queued" },
            { displayTitle: `Release assets ${"d".repeat(32)}`, headSha: sha, status: "waiting" },
          ],
          version,
        }),
      /multiple release workflows/i,
    );
  });
});

describe("idempotent release retry", () => {
  it("reuses the newest exact-head successful run whose canonical artifact still exists", async () => {
    const calls = [];
    const run = async (command, args) => {
      calls.push({ args, command });
      if (args[0] === "run" && args[1] === "list") {
        return response([
          {
            conclusion: "success",
            createdAt: "2026-08-30T02:00:00Z",
            databaseId: 22,
            displayTitle: `Release assets ${nonce}`,
            event: "workflow_dispatch",
            headBranch: OPS_DEFAULT_BRANCH,
            headSha: sha,
            status: "completed",
          },
          {
            conclusion: "success",
            createdAt: "2026-08-30T01:00:00Z",
            databaseId: 21,
            displayTitle: `Release assets ${"d".repeat(32)}`,
            event: "workflow_dispatch",
            headBranch: OPS_DEFAULT_BRANCH,
            headSha: sha,
            status: "completed",
          },
        ]);
      }
      if (args.at(-1).endsWith("/22/artifacts")) {
        return response({
          artifacts: [{ expired: true, name: `chzzk-release-assets-${sha}`, size_in_bytes: 10 }],
        });
      }
      if (args.at(-1).endsWith("/21/artifacts")) {
        return response({
          artifacts: [{ expired: false, name: `chzzk-release-assets-${sha}`, size_in_bytes: 10 }],
        });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const reusable = await reusableSuccessfulRun({ context: { root: "C:\\repo" }, run, sourceSha: sha });
    assert.equal(reusable.databaseId, 21);
    assert.equal(reusable.artifactName, `chzzk-release-assets-${sha}`);
    assert.equal(
      calls.some(({ args }) => args[0] === "workflow" && args[1] === "run"),
      false,
    );
  });
});

describe("same-day product queue", () => {
  it("merges a later source into the one draft and finishes with an exact-head ancestry readback", async () => {
    const pendingSha = "d".repeat(40);
    const queuedSha = "e".repeat(40);
    const calls = [];
    let mergePayload = null;
    const run = async (command, args, options = {}) => {
      calls.push({ args, command });
      if (command === "git" && args[0] === "push") return response("");
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return response([
          {
            baseRefName: OPS_DEFAULT_BRANCH,
            headRefName: "agent/pending",
            headRefOid: pendingSha,
            isDraft: true,
            number: 105,
            state: "OPEN",
            url: "https://github.com/solitude0429/CHZZK/pull/105",
          },
        ]);
      }
      if (command === "gh" && args[0] === "api" && args.at(-1).includes("/branches/agent%2Fsource")) {
        return response({ commit: { sha } });
      }
      if (command === "gh" && args[0] === "api" && args.at(-1).endsWith("/merges")) {
        mergePayload = JSON.parse(options.input);
        return response({ sha: queuedSha });
      }
      if (command === "gh" && args[0] === "api" && args.at(-1).includes("/branches/agent%2Fpending")) {
        return response({ commit: { sha: queuedSha } });
      }
      if (command === "gh" && args[0] === "api" && args.at(-1).includes("/compare/")) {
        return response({ behind_by: 0, status: "ahead" });
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return response({
          baseRefName: OPS_DEFAULT_BRANCH,
          headRefName: "agent/pending",
          headRefOid: queuedSha,
          isDraft: true,
          number: 105,
          state: "OPEN",
          url: "https://github.com/solitude0429/CHZZK/pull/105",
        });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const result = await queueShipPending({
      context: {
        branch: "agent/source",
        clean: true,
        headSha: sha,
        remoteMainSha: "c".repeat(40),
        root: "C:\\repo",
      },
      run,
      version: "26.8.30",
    });
    assert.equal(result.headSha, queuedSha);
    assert.deepEqual(mergePayload, {
      base: "agent/pending",
      commit_message: "chore: queue CHZZK changes from agent/source",
      head: sha,
    });
    const compareIndices = calls
      .map(({ args }, index) => (args.at(-1).includes?.("/compare/") ? index : -1))
      .filter((index) => index >= 0);
    const finalViewIndex = calls.findLastIndex(({ args }) => args[0] === "pr" && args[1] === "view");
    assert.equal(compareIndices.length, 2);
    assert.equal(
      compareIndices.every((index) => index < finalViewIndex),
      true,
    );
  });
});

describe("exact-head ship", () => {
  it("records a COMMENT review on the checked head and head-matches the squash merge", async () => {
    const calls = [];
    let prViewCount = 0;
    let reviewPayload = null;
    const run = async (command, args, options = {}) => {
      calls.push({ args, command, options });
      if (command === "git" && args[0] === "push") return response("");
      if (command === "gh" && args[0] === "api" && args.at(-1).includes("/branches/")) {
        return response({ commit: { sha } });
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return response([
          {
            baseRefName: OPS_DEFAULT_BRANCH,
            headRefOid: sha,
            isDraft: false,
            number: 104,
            state: "OPEN",
            url: "https://github.com/solitude0429/CHZZK/pull/104",
          },
        ]);
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "checks") return response("");
      if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
        return response({
          data: {
            repository: {
              pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
            },
          },
        });
      }
      if (command === "gh" && args[0] === "api" && args.at(-1).endsWith("/reviews")) {
        reviewPayload = JSON.parse(options.input);
        return response({ commit_id: sha, id: 901, state: "COMMENTED" });
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        prViewCount += 1;
        if (prViewCount === 1) {
          return response({
            baseRefName: OPS_DEFAULT_BRANCH,
            headRefOid: sha,
            isDraft: false,
            mergeStateStatus: "CLEAN",
            state: "OPEN",
            statusCheckRollup: ["analyze", "dependency-review", "firefox-e2e", "verify"].map((name) => ({
              conclusion: "SUCCESS",
              name,
            })),
          });
        }
        if (prViewCount === 2) return response({ headRefOid: sha, state: "OPEN" });
        return response({ headRefOid: sha, mergeCommit: { oid: mergeSha }, state: "MERGED" });
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "merge") return response("");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const result = await shipCurrentBranch({
      context: {
        branch: "agent/example",
        clean: true,
        headSha: sha,
        remoteMainSha: "e".repeat(40),
        root: "C:\\repo",
      },
      run,
    });
    assert.equal(result.pullRequest, 104);
    assert.equal(result.mergeSha, mergeSha);
    assert.deepEqual(reviewPayload, {
      body: `Final CHZZK operator review: required checks passed and no blocking findings remain for exact head ${sha}.`,
      commit_id: sha,
      event: "COMMENT",
    });
    const merge = calls.find(({ args }) => args[0] === "pr" && args[1] === "merge");
    const review = calls.find(({ args }) => args[0] === "api" && args.at(-1).endsWith("/reviews"));
    assert.deepEqual(review.args.slice(review.args.indexOf("--input"), -1), ["--input", "-"]);
    assert.deepEqual(merge.args.slice(-2), ["--match-head-commit", sha]);
    assert.equal(
      calls.some(({ args }) => args[0] === "auth" && args[1] === "token"),
      false,
    );
    assert.equal(OPS_LOGIN, "solitude0429");
  });
});
