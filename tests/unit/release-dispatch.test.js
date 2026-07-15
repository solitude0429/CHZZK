import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { dispatchReleaseFromAdminPreflight } from "../../scripts/lib/release-dispatch.js";

const repository = "solitude0429/CHZZK";
const sourceSha = "a".repeat(40);

function makeSourceTree(version = "0.1.5") {
  const cwd = mkdtempSync(join(tmpdir(), "chzzk-release-dispatch-"));
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ version })}\n`);
  writeFileSync(join(cwd, "manifest.json"), `${JSON.stringify({ version })}\n`);
  return cwd;
}

function commandHarness({ immutableResponse = { enabled: true, enforced_by_owner: false } } = {}) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ args, command, input: options.input });
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return `${sourceSha}\n`;
    if (command === "git" && args.join(" ") === "symbolic-ref --short HEAD") return "main\n";
    if (command === "git" && args.join(" ") === "status --porcelain") return "";
    if (command !== "gh" || args[0] !== "api") throw new Error(`unexpected command: ${command} ${args}`);
    const endpoint = args.at(-1);
    if (endpoint === `repos/${repository}`) return `${JSON.stringify({ default_branch: "main" })}\n`;
    if (endpoint === `repos/${repository}/git/ref/heads/main`) {
      return `${JSON.stringify({ object: { sha: sourceSha, type: "commit" } })}\n`;
    }
    if (endpoint === "user") return `${JSON.stringify({ login: "release-admin" })}\n`;
    if (endpoint === `repos/${repository}/immutable-releases`) {
      if (immutableResponse instanceof Error) throw immutableResponse;
      return `${JSON.stringify(immutableResponse)}\n`;
    }
    if (endpoint === `repos/${repository}/dispatches` && args.includes("POST")) return "";
    throw new Error(`unexpected gh endpoint: ${endpoint}`);
  };
  return { calls, run };
}

describe("administrator immutable-release dispatch preflight", () => {
  it("binds an enabled immutable setting to the exact default-branch head, version, and operator", async () => {
    const cwd = makeSourceTree();
    const harness = commandHarness();
    try {
      const result = await dispatchReleaseFromAdminPreflight({
        cwd,
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        repository,
        runCommand: harness.run,
      });

      assert.deepEqual(result, {
        defaultBranch: "main",
        operatorLogin: "release-admin",
        sourceSha,
        version: "0.1.5",
      });
      const immutableIndex = harness.calls.findIndex(({ args }) =>
        args.includes(`repos/${repository}/immutable-releases`),
      );
      const dispatchIndex = harness.calls.findIndex(({ args }) =>
        args.includes(`repos/${repository}/dispatches`),
      );
      assert.equal(immutableIndex >= 0, true);
      assert.equal(dispatchIndex > immutableIndex, true);
      const dispatch = harness.calls[dispatchIndex];
      assert.deepEqual(JSON.parse(dispatch.input), {
        client_payload: {
          default_branch: "main",
          immutable_releases_verified: true,
          operator_login: "release-admin",
          source_sha: sourceSha,
          verified_at: "2026-07-15T10:00:00.000Z",
          version: "0.1.5",
        },
        event_type: "chzzk-release-preflight-v1",
      });
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails without dispatching when the immutable setting is false, malformed, or unreadable", async () => {
    for (const immutableResponse of [
      { enabled: false },
      { enabled: "true" },
      {},
      new Error("HTTP 404: immutable releases disabled"),
    ]) {
      const cwd = makeSourceTree();
      const harness = commandHarness({ immutableResponse });
      try {
        await assert.rejects(
          dispatchReleaseFromAdminPreflight({ cwd, repository, runCommand: harness.run }),
          /immutable release|enabled|preflight/i,
        );
        assert.equal(
          harness.calls.some(({ args }) => args.includes(`repos/${repository}/dispatches`)),
          false,
        );
      } finally {
        rmSync(cwd, { force: true, recursive: true });
      }
    }
  });
});
