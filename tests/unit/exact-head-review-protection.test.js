import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  REQUIRED_GITHUB_ACTIONS_CHECKS,
  planRepositorySettings,
} from "../../scripts/configure-repository.js";

const githubActionsAppId = 15368;

function repositoryState(checks) {
  return {
    actionsPermissions: { allowed_actions: "selected", enabled: true },
    branchProtection: {
      enforce_admins: { enabled: true },
      required_conversation_resolution: { enabled: true },
      required_pull_request_reviews: null,
    },
    immutableReleases: { enabled: true },
    labels: [],
    repository: {
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      delete_branch_on_merge: true,
    },
    selectedActions: {
      github_owned_allowed: true,
      patterns_allowed: [],
      verified_allowed: false,
    },
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

describe("exact-head review branch protection", () => {
  it("includes exact-head-review in the single atomic required-check plan", () => {
    assert.deepEqual(REQUIRED_GITHUB_ACTIONS_CHECKS, [
      "analyze",
      "dependency-review",
      "exact-head-review",
      "firefox-e2e",
      "verify",
    ]);
    const changes = planRepositorySettings(
      repositoryState(desiredChecks().filter((check) => check.context !== "exact-head-review")),
      githubActionsAppId,
      "release-operator",
    );
    assert.deepEqual(changes, [
      {
        checks: desiredChecks(),
        kind: "status-checks",
        strict: true,
      },
    ]);
  });

  it("is idempotent when the full source-bound check set is installed", () => {
    assert.deepEqual(
      planRepositorySettings(repositoryState(desiredChecks()), githubActionsAppId, "release-operator"),
      [],
    );
  });

  it("routes the public configure command directly through the atomic configurator", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(packageJson.scripts["configure:repository"], "node scripts/configure-repository.js");
  });
});
