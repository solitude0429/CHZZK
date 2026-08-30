import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OPS_DEFAULT_BRANCH,
  OPS_LOGIN,
  OPS_REPOSITORY,
  classifyDailyReleaseState,
  compareUtcVersions,
  createSubprocessRunner,
  formatUtcVersion,
  normalizeRepositoryRemote,
  parseCliArguments,
  parseReleaseRunTitle,
  parseUtcVersion,
  redactSensitive,
  reusableSuccessfulRun,
  shipCurrentBranch,
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
