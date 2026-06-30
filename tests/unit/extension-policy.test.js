import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildQualityRegexFilter } from "../../src/shared/quality.js";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const policy = JSON.parse(readFileSync(new URL("../../policy/quality-policy.json", import.meta.url), "utf8"));
const rules = JSON.parse(readFileSync(new URL("../../rules.json", import.meta.url), "utf8"));

describe("personal CHZZK extension policy", () => {
  it("does not inject into or depend on CHZZK player DOM", () => {
    assert.ok(manifest.permissions?.includes("declarativeNetRequest"));
    assert.ok(
      manifest.permissions?.includes("storage"),
      "storage permission should be used only for local diagnostics",
    );
    assert.ok(
      manifest.permissions?.includes("webRequest"),
      "webRequest permission should be used only for local diagnostics",
    );
    assert.ok(!manifest.permissions?.includes("scripting"), "scripting permission should not be needed");
    assert.equal(manifest.content_scripts, undefined, "content scripts should not be shipped");
    assert.equal(
      existsSync(new URL("../../inject.js", import.meta.url)),
      false,
      "no page script should be packaged",
    );
    assert.deepEqual(manifest.background, { scripts: ["background.js"] }, "background is diagnostics-only");
  });

  it("ships a generated static ruleset based on policy, not a hard-coded current quality list", () => {
    assert.deepEqual(manifest.declarative_net_request?.rule_resources, [
      {
        enabled: true,
        id: "ruleset_1",
        path: "rules.json",
      },
    ]);

    assert.equal(rules.length, 1);
    const [rule] = rules;
    assert.equal(rule.action?.type, "redirect");
    assert.equal(rule.action?.redirect?.regexSubstitution, `\\1${policy.targetQuality}\\3`);
    assert.equal(
      rule.condition?.regexFilter,
      buildQualityRegexFilter({
        minRedirectQuality: policy.minRedirectQuality,
        targetQuality: policy.targetQuality,
      }),
    );
    assert.equal(rule.condition.regexFilter.includes("360p|480p|720p"), false);
    assert.deepEqual([...rule.condition.resourceTypes].sort(), ["media", "xmlhttprequest"]);
  });

  it("does not display the old 480p relabel/badge concept anywhere in runtime files", () => {
    const runtimeText = [
      readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
      readFileSync(new URL("../../rules.json", import.meta.url), "utf8"),
      existsSync(new URL("../../background.js", import.meta.url))
        ? readFileSync(new URL("../../background.js", import.meta.url), "utf8")
        : "",
    ].join("\n");

    assert.equal(runtimeText.includes("with CHZZK GRID"), false);
    assert.equal(runtimeText.includes("pzp-setting-quality-pane"), false);
  });

  it("uses the official CHZZK favicon as the extension icon", () => {
    assert.equal(manifest.icons?.["32"], "icon.png");
    assert.equal(manifest.action?.default_icon?.["32"], "icon.png");
  });
});
