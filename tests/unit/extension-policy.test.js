import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

describe("personal CHZZK extension policy", () => {
  it("does not inject into or control CHZZK player DOM", () => {
    assert.equal(manifest.manifest_version, 2);
    assert.ok(!manifest.permissions?.includes("declarativeNetRequest"));
    assert.ok(
      manifest.permissions?.includes("storage"),
      "storage permission should be used only for local diagnostics",
    );
    assert.ok(
      manifest.permissions?.includes("webRequest"),
      "webRequest permission should be used only for local diagnostics and required HLS redirect handling",
    );
    assert.ok(!manifest.permissions?.includes("scripting"), "scripting permission should not be needed");
    assert.deepEqual(
      manifest.content_scripts,
      [
        {
          js: ["site-observer.js"],
          matches: ["https://*.chzzk.naver.com/live", "https://*.chzzk.naver.com/live/*"],
          run_at: "document_start",
        },
      ],
      "MV2 content script must prewarm exact and nested CHZZK live pages only",
    );
    assert.equal(
      existsSync(new URL("../../inject.js", import.meta.url)),
      false,
      "no page script should be packaged",
    );
    assert.equal(
      readFileSync(new URL("../../src/runtime/site-observer.js", import.meta.url), "utf8").includes(
        "querySelector",
      ),
      false,
      "site observer must not query or control the player DOM",
    );
    assert.deepEqual(
      manifest.background,
      { scripts: ["background.js"], persistent: true },
      "MV2 background handles required-permission webRequest redirects directly",
    );
  });

  it("does not ship declarativeNetRequest or optional site-permission surfaces", () => {
    assert.equal(manifest.declarative_net_request, undefined);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    assert.equal(manifest.optional_host_permissions, undefined);
    assert.equal(manifest.content_scripts?.[0]?.js?.[0], "site-observer.js");
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

  it("declares CHZZK and HLS origins as required MV2 permissions", () => {
    assert.deepEqual(manifest.permissions, [
      "https://*.akamaized.net/*",
      "https://*.chzzk.naver.com/*",
      "https://*.gscdn.net/*",
      "https://*.navercdn.com/*",
      "https://*.pstatic.net/*",
      "storage",
      "webRequest",
      "webRequestBlocking",
    ]);
    assert.deepEqual(manifest.browser_specific_settings?.gecko?.data_collection_permissions, {
      required: ["none"],
    });

    const runtimeText = [
      readFileSync(new URL("../../src/runtime/background.js", import.meta.url), "utf8"),
      readFileSync(new URL("../../src/runtime/site-observer.js", import.meta.url), "utf8"),
      readFileSync(new URL("../../diagnostics.html", import.meta.url), "utf8"),
    ].join("\n");
    assert.equal(runtimeText.includes("chzzk-report"), false);
    assert.equal(runtimeText.includes("Telemetry collector"), false);
    assert.equal(runtimeText.includes("MutationObserver"), false);
  });

  it("uses size-matched official CHZZK favicon PNGs as extension icons", () => {
    assert.deepEqual(manifest.icons, {
      32: "icon-32.png",
      48: "icon-48.png",
      96: "icon-96.png",
      128: "icon.png",
    });
    assert.equal(manifest.action, undefined);
    assert.deepEqual(manifest.browser_action?.default_icon, manifest.icons);
  });
});
