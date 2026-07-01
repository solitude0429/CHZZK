import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

describe("personal CHZZK extension policy", () => {
  it("does not inject into or control CHZZK player DOM", () => {
    assert.ok(manifest.permissions?.includes("declarativeNetRequest"));
    assert.ok(
      manifest.permissions?.includes("storage"),
      "storage permission should be used only for local diagnostics",
    );
    assert.ok(
      manifest.permissions?.includes("webRequest"),
      "webRequest permission should be used only for local diagnostics and session-rule bootstrap",
    );
    assert.ok(!manifest.permissions?.includes("scripting"), "scripting permission should not be needed");
    assert.deepEqual(
      manifest.content_scripts,
      [
        {
          matches: ["https://chzzk.naver.com/live/*"],
          js: ["site-observer.js"],
          run_at: "document_start",
        },
      ],
      "the only content script must be the CHZZK live-site observer",
    );
    assert.equal(
      existsSync(new URL("../../inject.js", import.meta.url)),
      false,
      "no page script should be packaged",
    );
    assert.deepEqual(
      manifest.background,
      { scripts: ["background.js"] },
      "background manages diagnostics and session DNR only",
    );
  });

  it("does not ship a global static DNR ruleset", () => {
    assert.equal(
      manifest.declarative_net_request,
      undefined,
      "redirect rules should be installed as tab-scoped session rules, not as always-on static rules",
    );
    assert.equal(
      existsSync(new URL("../../rules.json", import.meta.url)),
      false,
      "rules.json should not be a runtime source of truth or packaged static ruleset",
    );
  });

  it("does not display the old 480p relabel/badge concept anywhere in runtime files", () => {
    const runtimeText = [
      readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
      existsSync(new URL("../../background.js", import.meta.url))
        ? readFileSync(new URL("../../background.js", import.meta.url), "utf8")
        : "",
    ].join("\n");

    assert.equal(runtimeText.includes("with CHZZK GRID"), false);
    assert.equal(runtimeText.includes("pzp-setting-quality-pane"), false);
  });

  it("uses size-matched official CHZZK favicon PNGs as extension icons", () => {
    assert.deepEqual(manifest.icons, {
      32: "icon-32.png",
      48: "icon-48.png",
      96: "icon-96.png",
      128: "icon.png",
    });
    assert.deepEqual(manifest.action?.default_icon, manifest.icons);
  });
});
