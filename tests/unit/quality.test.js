import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHighestQualityRedirectUrl,
  buildQualityRegexFilter,
  lowerQualityNumberRegex,
  normalizeQualityLabel,
  parseQualityFromUrl,
  qualityNumber,
  redactMediaUrl,
} from "../../src/shared/quality.js";

describe("highest-quality redirect helpers", () => {
  it("normalizes common CHZZK quality labels", () => {
    assert.equal(normalizeQualityLabel("1080p"), "1080p");
    assert.equal(normalizeQualityLabel("1080P with badge"), "1080p");
    assert.equal(normalizeQualityLabel("1920x1080"), "1080p");
    assert.equal(normalizeQualityLabel("source"), null);
    assert.equal(qualityNumber("1080p"), 1080);
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

  it("generates a range regex instead of enumerating current CHZZK qualities", () => {
    const lowerRange = lowerQualityNumberRegex("1080p", "100p");
    assert.equal(lowerRange.includes("360p|480p|720p"), false);
    assert.match("360", new RegExp(`^${lowerRange}$`));
    assert.match("540", new RegExp(`^${lowerRange}$`));
    assert.match("900", new RegExp(`^${lowerRange}$`));
    assert.match("1079", new RegExp(`^${lowerRange}$`));
    assert.doesNotMatch("1080", new RegExp(`^${lowerRange}$`));
    assert.doesNotMatch("1440", new RegExp(`^${lowerRange}$`));

    const filter = buildQualityRegexFilter({ targetQuality: "1080p", minRedirectQuality: "100p" });
    assert.equal(filter.includes("360p|480p|720p"), false);
    assert.match("https://cdn.test/live/chunklist_540p.m3u8", new RegExp(filter));
    assert.match("https://cdn.test/live/900p/chunklist.m3u8", new RegExp(filter));
    assert.doesNotMatch("https://cdn.test/live/chunklist_1080p.m3u8", new RegExp(filter));
    assert.doesNotMatch("https://cdn.test/live/chunklist_1440p.m3u8", new RegExp(filter));
  });

  it("redirects current and future lower numeric HLS qualities while preserving signed URL tails", () => {
    for (const quality of ["144p", "270p", "360p", "480p", "540p", "720p", "900p", "1000p", "1079p"]) {
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

  it("does not rewrite target-or-higher playlist requests", () => {
    assert.equal(
      buildHighestQualityRedirectUrl("https://cdn.test/live/chunklist_1080p.m3u8?Policy=secret"),
      null,
    );
    assert.equal(
      buildHighestQualityRedirectUrl("https://cdn.test/live/1080p/chunklist.m3u8?Policy=secret"),
      null,
    );
    assert.equal(
      buildHighestQualityRedirectUrl("https://cdn.test/live/chunklist_1440p.m3u8?Policy=secret"),
      null,
    );
  });
});
