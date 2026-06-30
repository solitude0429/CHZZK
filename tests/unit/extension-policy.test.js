import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

describe("extension safety policy", () => {
  it("does not ship a broad static DNR redirect ruleset", () => {
    assert.ok(
      !manifest.permissions?.includes("declarativeNetRequest"),
      "DNR permission should not be enabled for static redirects",
    );
    assert.equal(manifest.declarative_net_request, undefined, "static DNR rulesets should not be declared");

    const rulesPath = new URL("../../rules.json", import.meta.url);
    if (existsSync(rulesPath)) {
      const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
      assert.deepEqual(rules, [], "rules.json must stay empty until safe dynamic rules are implemented");
    }
  });
});
