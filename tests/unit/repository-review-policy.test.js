import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_GITHUB_ACTIONS_CHECKS,
  REQUIRED_SIGNING_SECRET_NAMES,
  planRepositorySettings,
} from "../../scripts/configure-repository.js";

const githubActionsAppId = 15368;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function repositoryState(checks) {
  return {
    actionsPermissions: { allowed_actions: "selected", enabled: true },
    branchProtection: {
      enforce_admins: { enabled: true },
      required_conversation_resolution: { enabled: true },
      required_pull_request_reviews: {
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
        required_approving_review_count: 0,
        require_last_push_approval: false,
      },
    },
    immutableReleases: { enabled: true },
    labels: [],
    repository: {
      allow_auto_merge: false,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      delete_branch_on_merge: true,
    },
    repositorySecrets: [],
    selectedActions: {
      github_owned_allowed: true,
      patterns_allowed: [],
      verified_allowed: false,
    },
    signingEnvironment: {
      deployment_branch_policy: {
        custom_branch_policies: false,
        protected_branches: true,
      },
      name: "firefox-signing",
    },
    signingEnvironmentSecrets: REQUIRED_SIGNING_SECRET_NAMES.map((name) => ({ name })),
    statusProtection: { checks, strict: true },
    variables: [{ name: "RELEASE_OPERATOR_LOGIN", value: "release-operator" }],
    workflowPermissions: {
      can_approve_pull_request_reviews: false,
      default_workflow_permissions: "read",
    },
  };
}

function desiredChecks() {
  return REQUIRED_GITHUB_ACTIONS_CHECKS.map((context) => ({
    app_id: githubActionsAppId,
    context,
  }));
}

describe("repository review policy", () => {
  it("keeps only deterministic GitHub Actions checks in branch protection", () => {
    assert.deepEqual(REQUIRED_GITHUB_ACTIONS_CHECKS, [
      "analyze",
      "dependency-review",
      "firefox-e2e",
      "verify",
    ]);
    const state = repositoryState([
      ...desiredChecks(),
      { app_id: githubActionsAppId, context: "exact-head-review" },
    ]);
    const changes = planRepositorySettings(state, githubActionsAppId, "release-operator");
    assert.deepEqual(changes, [
      {
        checks: desiredChecks(),
        kind: "status-checks",
        strict: true,
      },
    ]);
  });

  it("retires the asynchronous commit-scoped review gate", () => {
    for (const path of [".github/workflows/exact-head-review.yml", "scripts/verify-exact-head-review.js"]) {
      assert.equal(existsSync(join(rootDir, path)), false, path);
    }
  });

  it("is idempotent when the deterministic check set is installed", () => {
    assert.deepEqual(
      planRepositorySettings(repositoryState(desiredChecks()), githubActionsAppId, "release-operator"),
      [],
    );
  });

  it("exposes repository configuration only through the external protected bootstrap", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(Object.hasOwn(packageJson.scripts, "configure:repository"), false);
    assert.equal(existsSync(join(rootDir, "scripts/repository-settings-bootstrap.js")), true);
  });

  it("permits only an explicitly authorized operating agent to execute the post-gate merge", () => {
    const operations = readFileSync(join(rootDir, "docs/OPERATIONS.md"), "utf8");
    assert.match(
      operations,
      /owner or an operating agent explicitly authorized by the owner squash-merges through protected `main` only after step 5 is complete/,
    );
    assert.match(operations, /does not request a second merge confirmation after the gates pass/);
    assert.match(operations, /mark the PR ready for review and request the final direct Codex review/);
    assert.match(operations, /new final direct Codex review on the Ready PR/);
    const orderedMarkers = [
      "5. Finalize the PR body and every high-risk release, permissions, deployment, or security-policy note after the last source push",
      "mark the PR ready for review",
      "@codex review",
      "Immediately before the authorized squash merge",
      "6. The owner or an operating agent explicitly authorized by the owner squash-merges",
    ];
    const markerPositions = orderedMarkers.map((marker) => operations.indexOf(marker));
    assert.equal(
      markerPositions.every((position) => position >= 0),
      true,
      "every guarded merge marker must exist",
    );
    for (let index = 1; index < markerPositions.length; index += 1) {
      assert.equal(
        markerPositions[index - 1] < markerPositions[index],
        true,
        `${orderedMarkers[index - 1]} must precede ${orderedMarkers[index]}`,
      );
    }
    assert.match(
      operations,
      /GitHub auto-merge and unattended generic merge automation must not be enabled or used/,
    );
    assert.doesNotMatch(operations, /automation must not merge the PR/);
  });
});
