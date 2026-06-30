import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const rules = JSON.parse(readFileSync(new URL("../../rules.json", import.meta.url), "utf8"));

describe("personal CHZZK extension policy", () => {
  it("uses network-level redirect only, so player DOM changes cannot break the core behavior", () => {
    assert.ok(manifest.permissions?.includes("declarativeNetRequest"));
    assert.ok(!manifest.permissions?.includes("scripting"), "scripting permission should not be needed");
    assert.equal(manifest.background, undefined, "no background injection script should be shipped");
    assert.equal(
      existsSync(new URL("../../inject.js", import.meta.url)),
      false,
      "no page script should be packaged",
    );
  });

  it("ships a single static ruleset that redirects any lower selected quality to the highest target", () => {
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
    assert.equal(rule.action?.redirect?.regexSubstitution, "\\11080p\\3");
    assert.equal(rule.condition?.regexFilter, "(.*)(144p|240p|270p|360p|480p|720p)(.*\\.m3u8.*)");
    assert.deepEqual([...rule.condition.resourceTypes].sort(), ["media", "xmlhttprequest"]);
  });

  it("does not display the old 480p relabel/badge concept anywhere in runtime files", () => {
    const runtimeText = [
      readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
      readFileSync(new URL("../../rules.json", import.meta.url), "utf8"),
    ].join("\n");

    assert.equal(runtimeText.includes("with CHZZK GRID"), false);
    assert.equal(runtimeText.includes("pzp-setting-quality-pane"), false);
  });

  it("uses the official CHZZK favicon as the extension icon", () => {
    assert.equal(manifest.icons?.["32"], "icon.png");
    assert.equal(manifest.action?.default_icon?.["32"], "icon.png");
  });
});
