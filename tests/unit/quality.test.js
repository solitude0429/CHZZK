import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HIGHEST_QUALITY,
  LOWER_QUALITIES,
  buildHighestQualityRedirectUrl,
  normalizeQualityLabel,
  parseQualityFromUrl,
  redactMediaUrl,
} from "../../src/shared/quality.js";

describe("highest-quality redirect helpers", () => {
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

  it("redirects every lower CHZZK HLS quality to the highest target while preserving signed URL tails", () => {
    assert.equal(HIGHEST_QUALITY, "1080p");
    assert.ok(LOWER_QUALITIES.includes("360p"));
    assert.ok(LOWER_QUALITIES.includes("480p"));
    assert.ok(LOWER_QUALITIES.includes("720p"));

    for (const quality of LOWER_QUALITIES) {
      assert.equal(
        buildHighestQualityRedirectUrl(`https://cdn.test/live/chunklist_${quality}.m3u8?Policy=secret#frag`),
        "https://cdn.test/live/chunklist_1080p.m3u8?Policy=secret#frag",
      );
      assert.equal(
        buildHighestQualityRedirectUrl(`https://cdn.test/live/${quality}/chunklist.m3u8?Policy=secret`),
        "https://cdn.test/live/1080p/chunklist.m3u8?Policy=secret",
      );
    }
  });

  it("does not rewrite an already-highest playlist request", () => {
    assert.equal(
      buildHighestQualityRedirectUrl("https://cdn.test/live/chunklist_1080p.m3u8?Policy=secret"),
      null,
    );
    assert.equal(
      buildHighestQualityRedirectUrl("https://cdn.test/live/1080p/chunklist.m3u8?Policy=secret"),
      null,
    );
  });
});
