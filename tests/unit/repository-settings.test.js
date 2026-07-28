import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRepositoryChange,
  applyRepositoryChangesWithRecovery,
  assertProtectedBootstrapHeadCurrent,
  assertRepositoryChangesAutomatable,
  fullProtectionUpdate,
  inspectSigningSecretScope,
  planRepositorySettings,
  REQUIRED_GITHUB_ACTIONS_CHECKS,
  REQUIRED_SIGNING_SECRET_NAMES,
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
  it("accepts native pull-request-only merging with zero required approvals", () => {
    const state = protectedState();
    assert.deepEqual(planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin), []);
    assert.deepEqual(inspectSigningSecretScope(state), {
      environment: "firefox-signing",
      environmentProtected: true,
      environmentScopedSecretNames: REQUIRED_SIGNING_SECRET_NAMES,
      missingEnvironmentSecretNames: [],
      repositoryScopedSecretNames: [],
      safe: true,
    });
    assert.doesNotThrow(() => assertRepositoryChangesAutomatable([]));
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

  it("preserves unrelated branch-protection fields while enabling zero-approval pull requests", () => {
    const update = fullProtectionUpdate({
      allow_deletions: { enabled: false },
      allow_force_pushes: { enabled: false },
      allow_fork_syncing: { enabled: true },
      block_creations: { enabled: true },
      enforce_admins: { enabled: true },
      lock_branch: { enabled: false },
      required_conversation_resolution: { enabled: false },
      required_linear_history: { enabled: true },
      required_pull_request_reviews: null,
      required_status_checks: {
        checks: [{ app_id: githubActionsAppId, context: "verify" }],
        strict: true,
      },
      restrictions: {
        apps: [{ slug: "release-app" }],
        teams: [{ slug: "release-team" }],
        users: [{ login: "release-user" }],
      },
    });

    assert.deepEqual(update, {
      allow_deletions: false,
      allow_force_pushes: false,
      allow_fork_syncing: true,
      block_creations: true,
      enforce_admins: true,
      lock_branch: false,
      required_conversation_resolution: true,
      required_linear_history: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
        required_approving_review_count: 0,
        require_last_push_approval: false,
      },
      required_status_checks: {
        checks: [{ app_id: githubActionsAppId, context: "verify" }],
        strict: true,
      },
      restrictions: {
        apps: ["release-app"],
        teams: ["release-team"],
        users: ["release-user"],
      },
    });
  });

  it("fails closed with a value-free manual plan when signing secrets exist only at repository scope", () => {
    const state = protectedState();
    state.repositorySecrets = REQUIRED_SIGNING_SECRET_NAMES.map((name) => ({
      created_at: "2026-07-01T00:00:00Z",
      name,
    }));
    state.signingEnvironmentSecrets = [];

    const scope = inspectSigningSecretScope(state);
    assert.deepEqual(scope, {
      environment: "firefox-signing",
      environmentProtected: true,
      environmentScopedSecretNames: [],
      missingEnvironmentSecretNames: REQUIRED_SIGNING_SECRET_NAMES,
      repositoryScopedSecretNames: REQUIRED_SIGNING_SECRET_NAMES,
      safe: false,
    });
    const changes = planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "manual");
    assert.equal(changes[0].kind, "signing-secret-scope");
    assert.deepEqual(changes[0].requiredSecretNames, REQUIRED_SIGNING_SECRET_NAMES);
    assert.match(changes[0].migrationPlan.join("\n"), /does not expose existing secret values/i);
    assert.match(changes[0].migrationPlan.join("\n"), /delete.*repository secrets.*after/i);
    assert.equal(JSON.stringify(changes).includes("created_at"), false);
    assert.throws(
      () => assertRepositoryChangesAutomatable(changes),
      /manual changes are required before repository settings can be applied/i,
    );
  });

  it("keeps a partial environment migration manual and fail-closed", () => {
    const state = protectedState();
    state.repositorySecrets = REQUIRED_SIGNING_SECRET_NAMES.map((name) => ({ name }));
    state.signingEnvironmentSecrets = [{ name: REQUIRED_SIGNING_SECRET_NAMES[0] }];

    const changes = planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "manual");
    assert.deepEqual(changes[0].environmentScopedSecretNames, [REQUIRED_SIGNING_SECRET_NAMES[0]]);
    assert.deepEqual(changes[0].missingEnvironmentSecretNames, [REQUIRED_SIGNING_SECRET_NAMES[1]]);
    assert.deepEqual(changes[0].repositoryScopedSecretNames, REQUIRED_SIGNING_SECRET_NAMES);
    assert.throws(() => assertRepositoryChangesAutomatable(changes), /manual changes are required/i);
  });

  it("keeps repository duplicates manual after both environment secrets exist", () => {
    const state = protectedState();
    state.repositorySecrets = REQUIRED_SIGNING_SECRET_NAMES.map((name) => ({ name }));

    const changes = planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "manual");
    assert.deepEqual(changes[0].environmentScopedSecretNames, REQUIRED_SIGNING_SECRET_NAMES);
    assert.deepEqual(changes[0].missingEnvironmentSecretNames, []);
    assert.deepEqual(changes[0].repositoryScopedSecretNames, REQUIRED_SIGNING_SECRET_NAMES);
    assert.match(changes[0].migrationPlan.at(-1), /delete.*only after/i);
    assert.throws(() => assertRepositoryChangesAutomatable(changes), /manual changes are required/i);
  });

  it("performs zero mutations when a manual secret migration blocks apply", () => {
    const changes = [
      { kind: "repository" },
      {
        action: "manual",
        kind: "signing-secret-scope",
        requiredSecretNames: REQUIRED_SIGNING_SECRET_NAMES,
      },
    ];
    let mutations = 0;
    assert.throws(
      () =>
        applyRepositoryChangesWithRecovery({
          applyPlannedChange: () => {
            mutations += 1;
          },
          changes,
          planCurrentState: () => [],
          readCurrentState: () => ({}),
        }),
      /manual changes are required/i,
    );
    assert.equal(mutations, 0);
  });

  it("reports bounded value-free recovery state after a mid-apply failure", () => {
    const changes = [
      {
        kind: "repository",
        settings: { syntheticSensitiveValue: "must-not-appear" },
      },
      {
        action: "update",
        kind: "variable",
        name: "RELEASE_OPERATOR_LOGIN",
        value: "must-not-appear",
      },
    ];
    let mutationAttempts = 0;
    let postFailureReads = 0;
    assert.throws(
      () =>
        applyRepositoryChangesWithRecovery({
          applyPlannedChange: () => {
            mutationAttempts += 1;
            if (mutationAttempts === 2) throw new Error("synthetic failure must-not-appear");
          },
          changes,
          planCurrentState: () => [
            {
              action: "update",
              kind: "variable",
              name: "RELEASE_OPERATOR_LOGIN",
              value: "must-not-appear",
            },
          ],
          readCurrentState: () => {
            postFailureReads += 1;
            return { complete: true, secretValue: "must-not-appear" };
          },
        }),
      (error) => {
        assert.match(error.message, /partial apply/i);
        assert.match(error.message, /"stateRead":"complete"/);
        assert.match(error.message, /"appliedCount":1/);
        assert.match(error.message, /RELEASE_OPERATOR_LOGIN/);
        assert.equal(error.message.includes("must-not-appear"), false);
        return true;
      },
    );
    assert.equal(mutationAttempts, 2);
    assert.equal(postFailureReads, 1);
  });

  it("rechecks the exact protected remote and local head immediately before apply", () => {
    const context = {
      checkoutRoot: "/protected/checkout",
      defaultBranch: "main",
      repository: "solitude0429/CHZZK",
      sourceSha: "a".repeat(40),
    };
    const exactRepository = JSON.stringify({
      archived: false,
      default_branch: "main",
      full_name: "solitude0429/CHZZK",
      id: 1_275_903_171,
    });
    const exactBranch = JSON.stringify({
      commit: { sha: context.sourceSha },
      name: "main",
      protected: true,
    });
    const operations = [];
    const callGhApi = (_method, endpoint) => {
      operations.push(`gh:${endpoint}`);
      return endpoint.endsWith("/branches/main") ? exactBranch : exactRepository;
    };
    const exactGit = (_command, args) => {
      const operation = args.join(" ");
      operations.push(`git:${operation}`);
      if (operation === "rev-parse --show-toplevel") return context.checkoutRoot;
      if (operation === "rev-parse HEAD") return context.sourceSha;
      if (operation === "symbolic-ref --short HEAD") return context.defaultBranch;
      if (operation === "status --porcelain=v1 --untracked-files=all") return "";
      throw new Error(`unexpected git operation: ${operation}`);
    };

    assert.doesNotThrow(() =>
      assertProtectedBootstrapHeadCurrent(context, {
        callGhApi,
        canonicalize: (path) => path,
        runCommand: exactGit,
      }),
    );
    assert.equal(
      operations.at(-1),
      "gh:repos/solitude0429/CHZZK/branches/main",
      "the protected-head API read must be the final pre-mutation operation",
    );
    assert.equal(
      operations.indexOf("git:status --porcelain=v1 --untracked-files=all") <
        operations.indexOf("gh:repos/solitude0429/CHZZK/branches/main"),
      true,
    );
    assert.throws(
      () =>
        assertProtectedBootstrapHeadCurrent(context, {
          callGhApi: (_method, endpoint) =>
            endpoint.endsWith("/branches/main")
              ? JSON.stringify({
                  commit: { sha: "b".repeat(40) },
                  name: "main",
                  protected: true,
                })
              : exactRepository,
          canonicalize: (path) => path,
          runCommand: exactGit,
        }),
      /head changed before repository settings apply/i,
    );
    assert.throws(
      () =>
        assertProtectedBootstrapHeadCurrent(context, {
          callGhApi,
          canonicalize: (path) => path,
          runCommand: (command, args, options) =>
            args[0] === "status" ? " M protected-file\n" : exactGit(command, args, options),
        }),
      /checkout changed before apply/i,
    );
  });

  it("places the protected-head check after preparatory reads and before every mutation", () => {
    const repository = "solitude0429/CHZZK";
    const endpoints = {
      admins: `repos/${repository}/branches/main/protection/enforce_admins`,
      protection: `repos/${repository}/branches/main/protection`,
      status: `repos/${repository}/branches/main/protection/required_status_checks`,
    };
    const protection = {
      allow_deletions: { enabled: false },
      allow_force_pushes: { enabled: false },
      allow_fork_syncing: { enabled: false },
      block_creations: { enabled: false },
      enforce_admins: { enabled: true },
      lock_branch: { enabled: false },
      required_conversation_resolution: { enabled: false },
      required_linear_history: { enabled: false },
      required_pull_request_reviews: null,
      required_status_checks: null,
      restrictions: null,
    };
    const operations = [];
    const callGhApi = (method, endpoint) => {
      operations.push(`${method}:${endpoint}`);
      return method === "GET" ? JSON.stringify(protection) : "";
    };
    const assertHeadCurrent = () => operations.push("protected-head");

    applyRepositoryChange({ kind: "pull-request-protection" }, repository, endpoints, {
      assertHeadCurrent,
      callGhApi,
    });
    assert.deepEqual(operations, [
      `GET:${endpoints.protection}`,
      "protected-head",
      `PUT:${endpoints.protection}`,
    ]);

    operations.length = 0;
    applyRepositoryChange(
      {
        kind: "repository",
        settings: { allow_squash_merge: true },
      },
      repository,
      endpoints,
      { assertHeadCurrent, callGhApi },
    );
    assert.deepEqual(operations, ["protected-head", `PATCH:repos/${repository}`]);

    operations.length = 0;
    assert.throws(
      () =>
        applyRepositoryChange({ kind: "pull-request-protection" }, repository, endpoints, {
          assertHeadCurrent: () => {
            operations.push("protected-head");
            throw new Error("synthetic moved head");
          },
          callGhApi,
        }),
      /synthetic moved head/i,
    );
    assert.deepEqual(operations, [`GET:${endpoints.protection}`, "protected-head"]);
  });

  it("requires the firefox-signing environment to use protected branches", () => {
    const state = protectedState();
    state.signingEnvironment.deployment_branch_policy = null;

    const changes = planRepositorySettings(state, githubActionsAppId, releaseOperatorLogin);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "signing-secret-scope");
    assert.equal(changes[0].environmentProtected, false);
    assert.equal(changes[0].action, "manual");
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
