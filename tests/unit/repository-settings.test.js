import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  planRepositorySettings,
  REQUIRED_GITHUB_ACTIONS_CHECKS,
} from "../../scripts/configure-repository.js";

const githubActionsAppId = 15368;
const releaseOperatorLogin = "sole-owner";

function protectedState() {
  return {
    actionsPermissions: {
      allowed_actions: "selected",
      enabled: true,
    },
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
    statusProtection: {
      checks: REQUIRED_GITHUB_ACTIONS_CHECKS.map((context) => ({
        app_id: githubActionsAppId,
        context,
      })),
      strict: true,
    },
    variables: [{ name: "RELEASE_OPERATOR_LOGIN", value: releaseOperatorLogin }],
    workflowPermissions: {
      can_approve_pull_request_reviews: false,
      default_workflow_permissions: "read",
    },
  };
}

describe("repository settings source of truth", () => {
  it("accepts the minimal sole-owner protection model exactly", () => {
    assert.deepEqual(planRepositorySettings(protectedState(), githubActionsAppId, releaseOperatorLogin), []);
  });

  it("removes the bot review layer and tightens merge and Actions permissions", () => {
    const state = protectedState();
    state.actionsPermissions.allowed_actions = "all";
    state.selectedActions = null;
    state.branchProtection.required_conversation_resolution.enabled = false;
    state.branchProtection.required_pull_request_reviews = { required_approving_review_count: 1 };
    state.labels = [{ name: "release-review-required" }, { name: "security-review-required" }];
    state.repository.allow_merge_commit = true;
    state.repository.allow_rebase_merge = true;
    state.repository.delete_branch_on_merge = false;
    state.statusProtection.checks.push({
      app_id: githubActionsAppId,
      context: "CHZZK review completion",
    });
    state.variables.push({
      name: "AUTOMATED_REVIEW_LOGIN",
      value: "chatgpt-codex-connector[bot]",
    });

    const changes = planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin);
    assert.deepEqual(
      changes.map((change) => `${change.kind}:${change.action ?? "update"}`),
      [
        "repository:update",
        "actions-permissions:update",
        "selected-actions:update",
        "variable:delete",
        "label:delete",
        "label:delete",
        "status-checks:update",
        "pull-request-protection:update",
      ],
    );
    assert.deepEqual(
      changes.find((change) => change.kind === "status-checks").checks,
      REQUIRED_GITHUB_ACTIONS_CHECKS.map((context) => ({
        app_id: githubActionsAppId,
        context,
      })),
    );
  });

  it("binds every required check to the GitHub Actions app", () => {
    const state = protectedState();
    state.statusProtection.checks[0].app_id = -1;
    const changes = planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin);
    assert.deepEqual(
      changes.map((change) => change.kind),
      ["status-checks"],
    );
  });
});
