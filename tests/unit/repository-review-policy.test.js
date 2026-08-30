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

describe("repository review policy", () => {
  it("keeps only deterministic GitHub Actions checks in the local operator policy", () => {
    assert.deepEqual(REQUIRED_CHECKS, ["analyze", "dependency-review", "firefox-e2e", "verify"]);
    assert.equal(OPS_ACTIONS_APP_ID, 15368);
  });

  it("retires the asynchronous commit-scoped review gate", () => {
    for (const path of [".github/workflows/exact-head-review.yml", "scripts/verify-exact-head-review.js"]) {
      assert.equal(existsSync(join(rootDir, path)), false, path);
    }
  });

  it("documents read-only operation and the one-release-per-UTC-day queue", () => {
    const agents = read("AGENTS.md");
    const operations = read("docs/OPERATIONS.md");
    const status = read("docs/PROJECT_STATUS.md");
    const docs = [agents, operations, status].join("\n");

    assert.match(operations, /npm run chzzk -- status --json/);
    assert.match(operations, /npm run chzzk -- ship --json/);
    assert.match(docs, /읽기 전용[\s\S]{0,180}(?:변경하지|변경하지 않는다)/);
    assert.match(docs, /UTC[\s\S]{0,80}`YY\.M\.D`/);
    assert.match(docs, /하루에 (?:하나만|immutable Release는 하나만)/);
    assert.match(docs, /`ship-pending`/);
    assert.match(docs, /문서[\s\S]{0,100}(?:merge|병합)[\s\S]{0,80}(?:Release|릴리스)/);
  });

  it("uses a local exact-head COMMENT review without an external review app dependency", () => {
    const operations = read("docs/OPERATIONS.md");
    const signing = read("docs/SIGNING.md");
    const security = read("docs/SECURITY.md");
    const docs = [operations, signing, security].join("\n");

    for (const text of [operations, signing, security]) {
      assert.match(
        text,
        /exact-head COMMENT|exact head SHA[\s\S]{0,120}COMMENT|exact current head[\s\S]{0,120}COMMENT|현재 head SHA[\s\S]{0,120}COMMENT/i,
      );
    }
    assert.match(operations, /GitHub App[\s\S]{0,100}disable/);
    assert.match(docs, /Build signed Firefox release/);
    assert.doesNotMatch(docs, /@codex review|Stage unlisted Firefox release/);
    assert.doesNotMatch(docs, /owner-only external [`]?[.]mjs|external protected bootstrap|\/usr\/bin\/node/);

    const reviewPosition = operations.indexOf("exact-head COMMENT");
    const mergePosition = operations.indexOf("squash merge", reviewPosition);
    assert.equal(reviewPosition >= 0 && mergePosition > reviewPosition, true);
    assert.match(operations, /GitHub auto-merge[\s\S]{0,80}(?:사용하지|disabled)/i);
  });

  it("keeps release publication local and server deployment credential-free", () => {
    const signing = read("docs/SIGNING.md");
    const updates = read("docs/UPDATES.md");
    const security = read("docs/SECURITY.md");
    const docs = [signing, updates, security].join("\n");

    assert.match(signing, /Workflow는 GitHub Release를 생성, draft, 수정 또는 게시하지/);
    assert.match(signing, /gh release verify/);
    assert.match(updates, /SCP/);
    assert.match(updates, /서버로 보내지 않는다|서버에는? GitHub token/i);
    assert.match(docs, /keyring/);
    assert.match(docs, /rollback journal/i);
  });
});
