import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { OPS_ACTIONS_APP_ID, REQUIRED_CHECKS } from "../../scripts/chzzk-ops.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(path) {
  return readFileSync(join(rootDir, path), "utf8");
}

function parseContract(text, name) {
  const matches = Array.from(text.matchAll(new RegExp(`<!-- contract:${name}\\s+([^>]+?)\\s*-->`, "g")));
  assert.equal(matches.length, 1, `expected one contract:${name} marker`);
  const entries = matches[0][1]
    .trim()
    .split(/\s+/)
    .map((field) => {
      const separator = field.indexOf("=");
      assert.ok(separator > 0, `invalid contract:${name} field: ${field}`);
      return [field.slice(0, separator), field.slice(separator + 1)];
    });
  const keys = entries.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length, `duplicate contract:${name} field`);
  return Object.fromEntries(entries);
}

function assertContract(text, name, expected) {
  assert.deepEqual(parseContract(text, name), expected);
}

describe("repository review policy", () => {
  it("rejects ambiguous duplicate contract fields", () => {
    assert.throws(
      () => parseContract("<!-- contract:probe mode=old mode=new -->", "probe"),
      /duplicate contract:probe field/,
    );
  });

  it("keeps only deterministic GitHub Actions checks in the local operator policy", () => {
    assert.deepEqual(REQUIRED_CHECKS, ["analyze", "dependency-review", "firefox-e2e", "verify"]);
    assert.equal(OPS_ACTIONS_APP_ID, 15368);
  });

  it("retires the asynchronous commit-scoped review gate", () => {
    for (const path of [".github/workflows/exact-head-review.yml", "scripts/verify-exact-head-review.js"]) {
      assert.equal(existsSync(join(rootDir, path)), false, path);
    }
  });

  it("keeps always-read entry docs bounded and treats project status as historical context", () => {
    const readme = read("README.md");
    const agents = read("AGENTS.md");
    const expected = {
      "combined-max-utf8-bytes": "10240",
      "project-status": "historical-on-demand",
    };

    assertContract(agents, "entry-docs", expected);
    assert.ok(Buffer.byteLength(readme, "utf8") + Buffer.byteLength(agents, "utf8") <= 10_240);
  });

  it("documents read-only operation and the one-release-per-UTC-day queue", () => {
    const agents = read("AGENTS.md");
    const operations = read("docs/OPERATIONS.md");
    const status = read("docs/PROJECT_STATUS.md");
    const expected = {
      "read-only": "no-mutation",
      "docs-only": "protected-merge-no-release",
      "release-version": "YY.M.D",
      "daily-release-limit": "1",
      overflow: "ship-pending",
    };

    assert.match(operations, /npm run chzzk -- status --json/);
    assert.match(operations, /npm run chzzk -- ship --json/);
    for (const text of [agents, operations, status]) {
      assertContract(text, "policy", expected);
    }
  });

  it("uses a local exact-head COMMENT review without an external review app dependency", () => {
    const operations = read("docs/OPERATIONS.md");
    const signing = read("docs/SIGNING.md");
    const security = read("docs/SECURITY.md");
    const docs = [operations, signing, security].join("\n");
    const expected = {
      "exact-head-comment": "required",
      "external-app": "advisory",
      merge: "manual-squash",
      "auto-merge": "disabled",
    };

    for (const text of [operations, signing, security]) {
      assertContract(text, "review", expected);
    }
    assert.match(docs, /Build signed Firefox release/);
    assert.doesNotMatch(docs, /@codex review|Stage unlisted Firefox release/);
    assert.doesNotMatch(docs, /owner-only external [`]?[.]mjs|external protected bootstrap|\/usr\/bin\/node/);

    const reviewPosition = operations.indexOf("exact-head COMMENT");
    const mergePosition = operations.indexOf("squash merge", reviewPosition);
    assert.equal(reviewPosition >= 0 && mergePosition > reviewPosition, true);
    assert.match(operations, /GitHub auto-merge/);
  });

  it("keeps release publication local and server deployment credential-free", () => {
    const signing = read("docs/SIGNING.md");
    const updates = read("docs/UPDATES.md");
    const security = read("docs/SECURITY.md");
    const docs = [signing, updates, security].join("\n");
    const expected = {
      "actions-publish": "false",
      "local-release-verify": "required",
      "server-credentials": "forbidden",
      "rollback-journal": "required",
    };

    for (const text of [signing, updates]) {
      assertContract(text, "release", expected);
    }
    assert.match(signing, /gh release verify/);
    assert.match(updates, /SCP/);
    assert.match(updates, /ssh server/);
    assert.match(docs, /keyring/);
    assert.match(docs, /rollback journal/i);
  });
});
