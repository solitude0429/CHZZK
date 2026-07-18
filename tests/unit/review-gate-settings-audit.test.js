import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createReviewGateAuditEnvironment,
  validateReviewGateAuditProcess,
} from "../../scripts/check-review-gate-settings.js";

function auditSource() {
  return {
    CHZZK_AUTOMATED_REVIEW_LOGIN: "reviewer[bot]",
    CHZZK_GITHUB_REPOSITORY: "example/repository",
    CHZZK_RELEASE_OPERATOR_LOGIN: "operator",
    CHZZK_REVIEW_GATE_AUDIT_TOKEN: "github_pat_read_only_fixture",
  };
}

describe("review-gate repository settings audit", () => {
  it("accepts an exact read-only inspection", () => {
    const report = validateReviewGateAuditProcess({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        applied: false,
        exact: true,
        plannedChanges: [],
      }),
    });
    assert.equal(report.exact, true);
  });

  it("creates a sanitized child environment from one dedicated audit token", () => {
    const directory = mkdtempSync(join(tmpdir(), "chzzk-audit-environment-"));
    const ghPath = join(directory, "gh");
    try {
      chmodSync(directory, 0o700);
      writeFileSync(ghPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const environment = createReviewGateAuditEnvironment(auditSource(), directory, ghPath);
      assert.equal(environment.GH_TOKEN, auditSource().CHZZK_REVIEW_GATE_AUDIT_TOKEN);
      assert.equal(environment.CHZZK_GH_COMMAND, ghPath);
      assert.equal(environment.HOME, directory);
      assert.equal(environment.GITHUB_ACTIONS, "false");
      assert.equal(Object.hasOwn(environment, "CHZZK_RELEASE_ADMIN_TOKEN"), false);
      assert.equal(Object.hasOwn(environment, "NODE_OPTIONS"), false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects ambient write-capable or generic GitHub credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "chzzk-audit-credential-"));
    const ghPath = join(directory, "gh");
    try {
      chmodSync(directory, 0o700);
      writeFileSync(ghPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      for (const name of ["CHZZK_RELEASE_ADMIN_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
        assert.throws(
          () =>
            createReviewGateAuditEnvironment(
              { ...auditSource(), [name]: "ambient-secret" },
              directory,
              ghPath,
            ),
          new RegExp(name),
        );
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails on drift, malformed output, or an inspection failure", () => {
    assert.throws(
      () =>
        validateReviewGateAuditProcess({
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            applied: false,
            exact: false,
            plannedChanges: [{ kind: "status-checks" }],
          }),
        }),
      /drifted|status-checks/i,
    );
    assert.throws(
      () =>
        validateReviewGateAuditProcess({
          status: 0,
          stderr: "",
          stdout: "not json",
        }),
      /malformed JSON/i,
    );
    assert.throws(
      () =>
        validateReviewGateAuditProcess({
          status: 1,
          stderr: "forbidden",
          stdout: "",
        }),
      /forbidden/i,
    );
  });
});
