import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { planExactHeadReviewCheck } from "../../scripts/configure-exact-head-review.js";

const githubActionsAppId = 15368;

function statusProtection() {
  return {
    checks: [
      { app_id: githubActionsAppId, context: "analyze" },
      { app_id: githubActionsAppId, context: "dependency-review" },
      { app_id: githubActionsAppId, context: "firefox-e2e" },
      { app_id: githubActionsAppId, context: "verify" },
    ],
    strict: true,
  };
}

describe("exact-head review branch protection", () => {
  it("adds one GitHub-Actions-bound exact-head-review check", () => {
    const plan = planExactHeadReviewCheck(statusProtection());
    assert.equal(plan.changed, true);
    assert.equal(plan.strict, true);
    assert.deepEqual(
      plan.checks.find((check) => check.context === "exact-head-review"),
      { app_id: githubActionsAppId, context: "exact-head-review" },
    );
  });

  it("is idempotent and fails closed without a source-bound verify check", () => {
    const configured = statusProtection();
    configured.checks.push({
      app_id: githubActionsAppId,
      context: "exact-head-review",
    });
    assert.equal(planExactHeadReviewCheck(configured).changed, false);

    assert.throws(
      () => planExactHeadReviewCheck({ checks: [], strict: true }),
      /GitHub Actions app|verify check/i,
    );
  });

  it("routes the public configure command through both protection stages", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const orchestrator = readFileSync(
      new URL("../../scripts/configure-repository-all.js", import.meta.url),
      "utf8",
    );
    assert.equal(packageJson.scripts["configure:repository"], "node scripts/configure-repository-all.js");
    assert.match(orchestrator, /configure-repository\.js/);
    assert.match(orchestrator, /configure-exact-head-review\.js/);
  });
});
