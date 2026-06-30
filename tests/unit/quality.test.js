import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseHighestQuality,
  normalizeQualityLabel,
  parseQualitiesFromPlaylist,
  parseQualityFromUrl,
  redactMediaUrl,
} from "../../src/shared/quality.js";

describe("quality helpers", () => {
  it("normalizes common CHZZK quality labels", () => {
    assert.equal(normalizeQualityLabel("1080p"), "1080p");
    assert.equal(normalizeQualityLabel("1080P with badge"), "1080p");
    assert.equal(normalizeQualityLabel("1920x1080"), "1080p");
    assert.equal(normalizeQualityLabel("source"), null);
  });

  it("selects the highest available quality from unordered labels", () => {
    assert.equal(chooseHighestQuality(["360p", "1080p", "720p"]), "1080p");
    assert.equal(chooseHighestQuality(["480p", "720p"]), "720p");
    assert.equal(chooseHighestQuality([]), null);
  });

  it("parses quality labels from known HLS URL shapes", () => {
    assert.equal(parseQualityFromUrl("https://example.test/live/chunklist_1080p.m3u8?token=secret"), "1080p");
    assert.equal(parseQualityFromUrl("https://example.test/abc/1080p/segment.m3u8"), "1080p");
    assert.equal(parseQualityFromUrl("https://example.test/abc/playlist.m3u8"), null);
  });

  it("parses available variants from an HLS master playlist", () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=854x480
chunklist_480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6500000,RESOLUTION=1920x1080
/1080p/chunklist.m3u8
`;
    assert.deepEqual(parseQualitiesFromPlaylist(playlist), ["480p", "1080p"]);
  });

  it("redacts query strings and fragments from media URLs before logging", () => {
    assert.equal(
      redactMediaUrl("https://example.test/1080p/chunklist.m3u8?Policy=secret#frag"),
      "https://example.test/1080p/chunklist.m3u8?[redacted]",
    );
  });
});
