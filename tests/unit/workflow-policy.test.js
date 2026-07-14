import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateWorkflowDocument } from "../../scripts/validate-workflows.js";

const PINNED_CHECKOUT = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";

function validReadOnlyWorkflow() {
  return {
    concurrency: { "cancel-in-progress": true, group: "ci-${{ github.ref }}" },
    jobs: {
      verify: {
        permissions: { contents: "read" },
        "runs-on": "ubuntu-latest",
        steps: [{ uses: PINNED_CHECKOUT, with: { "persist-credentials": false } }, { run: "npm ci" }],
        "timeout-minutes": 10,
      },
    },
    name: "Fixture",
    on: ["push"],
    permissions: { contents: "read" },
  };
}

describe("semantic workflow policy", () => {
  it("accepts an explicitly permissioned read-only workflow", () => {
    assert.doesNotThrow(() => validateWorkflowDocument(validReadOnlyWorkflow(), "fixture.yml"));
  });

  it("rejects package installation or project builds in a write-capable job", () => {
    const workflow = validReadOnlyWorkflow();
    workflow.jobs.verify.permissions = { contents: "write" };
    assert.throws(() => validateWorkflowDocument(workflow, "fixture.yml"), /privileged|npm ci|write/i);
  });

  it("rejects checkout credentials and unpinned action references", () => {
    const workflow = validReadOnlyWorkflow();
    workflow.jobs.verify.steps[0] = { uses: "actions/checkout@v4" };
    assert.throws(
      () => validateWorkflowDocument(workflow, "fixture.yml"),
      /commit SHA|persist.credentials|pinned/i,
    );
  });

  it("rejects secrets in jobs that also hold repository or OIDC write authority", () => {
    const workflow = validReadOnlyWorkflow();
    workflow.jobs.verify.permissions = { actions: "read", contents: "write" };
    workflow.jobs.verify.steps = [
      {
        env: { AMO_API_KEY: "${{ secrets.AMO_API_KEY }}" },
        run: "node scripts/sign-unlisted.js",
      },
    ];
    assert.throws(() => validateWorkflowDocument(workflow, "fixture.yml"), /secret|privilege|write/i);
  });

  it("requires workflow concurrency and per-job timeout/permissions", () => {
    const workflow = validReadOnlyWorkflow();
    delete workflow.concurrency;
    delete workflow.jobs.verify["timeout-minutes"];
    delete workflow.jobs.verify.permissions;
    assert.throws(
      () => validateWorkflowDocument(workflow, "fixture.yml"),
      /concurrency|permissions|timeout/i,
    );
  });
});
