import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SOURCE_QUALITY,
  TARGET_QUALITY,
  buildGridBypassRedirectUrl,
  normalizeQualityLabel,
  parseQualityFromUrl,
  redactMediaUrl,
} from "../../src/shared/quality.js";

describe("grid bypass quality helpers", () => {
  it("normalizes common CHZZK quality labels", () => {
    assert.equal(normalizeQualityLabel("1080p"), "1080p");
    assert.equal(normalizeQualityLabel("1080P with badge"), "1080p");
    assert.equal(normalizeQualityLabel("1920x1080"), "1080p");
    assert.equal(normalizeQualityLabel("source"), null);
  });

  it("parses quality labels from known HLS URL shapes", () => {
    assert.equal(parseQualityFromUrl("https://example.test/live/chunklist_1080p.m3u8?token=secret"), "1080p");
    assert.equal(parseQualityFromUrl("https://example.test/abc/1080p/segment.m3u8"), "1080p");
    assert.equal(parseQualityFromUrl("https://example.test/abc/playlist.m3u8"), null);
  });

  it("redacts query strings and fragments from media URLs before logging", () => {
    assert.equal(
      redactMediaUrl("https://example.test/1080p/chunklist.m3u8?Policy=secret#frag"),
      "https://example.test/1080p/chunklist.m3u8?[redacted]",
    );
  });

  it("builds the same unconditional 480p→1080p redirect that the DNR rule applies", () => {
    assert.equal(SOURCE_QUALITY, "480p");
    assert.equal(TARGET_QUALITY, "1080p");
    assert.equal(
      buildGridBypassRedirectUrl("https://cdn.test/live/chunklist_480p.m3u8?Policy=secret#frag"),
      "https://cdn.test/live/chunklist_1080p.m3u8?Policy=secret#frag",
    );
    assert.equal(
      buildGridBypassRedirectUrl("https://cdn.test/live/480p/chunklist.m3u8?Policy=secret"),
      "https://cdn.test/live/1080p/chunklist.m3u8?Policy=secret",
    );
  });

  it("does not depend on observing an already available 1080p variant", () => {
    assert.equal(
      buildGridBypassRedirectUrl("https://cdn.test/live/chunklist_480p.m3u8?Policy=secret"),
      "https://cdn.test/live/chunklist_1080p.m3u8?Policy=secret",
    );
  });
});
