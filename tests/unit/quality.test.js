import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHighestQualityRedirectUrl,
  buildQualityRegexFilter,
  chooseBestHlsVariant,
  lowerQualityNumberRegex,
  normalizeQualityCandidates,
  normalizeQualityLabel,
  parseHlsMasterPlaylistVariants,
  parseQualityFromUrl,
  qualityNumber,
  redactMediaUrl,
  replaceQualityInUrl,
} from "../../src/shared/quality.js";

describe("highest-supported-quality helpers", () => {
  it("normalizes common CHZZK quality labels", () => {
    assert.equal(normalizeQualityLabel("1080p"), "1080p");
    assert.equal(normalizeQualityLabel("1080P with badge"), "1080p");
    assert.equal(normalizeQualityLabel("2560x1440"), "1440p");
    assert.equal(normalizeQualityLabel("source"), null);
    assert.equal(qualityNumber("1080p"), 1080);
  });

  it("parses quality labels from known HLS URL shapes", () => {
    assert.equal(
      parseQualityFromUrl("https://example.test/live/chunklist_1080p.m3u8?token=example"),
      "1080p",
    );
    assert.equal(parseQualityFromUrl("https://example.test/abc/1080p/segment.m3u8"), "1080p");
    assert.equal(
      parseQualityFromUrl("https://example.test/live/chunklist_1080p_low.m3u8?token=example"),
      "1080p",
    );
    assert.equal(parseQualityFromUrl("https://example.test/asset/foo-1080p-preview/chunklist.m3u8"), null);
    assert.equal(parseQualityFromUrl("https://example.test/abc/playlist.m3u8"), null);
  });

  it("redacts query strings and fragments from media URLs before logging", () => {
    assert.equal(
      redactMediaUrl("https://example.test/1080p/chunklist.m3u8?Policy=example#frag"),
      "https://example.test/1080p/chunklist.m3u8?[redacted]",
    );
    assert.equal(
      redactMediaUrl(
        "https://example.test/live/480p/hdntl=st%3d1%7ehmac%3dabcdefabcdefabcdefabcdef/signedtoken1234567890abcdef_chunklist.m3u8",
      ),
      "https://example.test/live/480p/[redacted-path]/[redacted-path]",
    );
  });

  it("orders configured quality candidates by numeric quality", () => {
    assert.deepEqual(
      normalizeQualityCandidates(["480p", "1440p", "1080p", "1440P"], { include: ["2160p"] }),
      ["2160p", "1440p", "1080p", "480p"],
    );
  });

  it("generates a range regex instead of enumerating current CHZZK qualities", () => {
    const lowerRange = lowerQualityNumberRegex("1440p", "100p");
    assert.equal(lowerRange.includes("360p|480p|720p"), false);
    for (const quality of ["360", "540", "900", "1079", "1080", "1439"]) {
      assert.match(quality, new RegExp(`^${lowerRange}$`));
    }
    assert.doesNotMatch("1440", new RegExp(`^${lowerRange}$`));
    assert.doesNotMatch("2160", new RegExp(`^${lowerRange}$`));

    const filter = buildQualityRegexFilter({ targetQuality: "1440p", minRedirectQuality: "100p" });
    assert.equal(filter.includes("360p|480p|720p"), false);
    assert.match("https://cdn.test/live/chunklist_540p.m3u8", new RegExp(filter));
    assert.match("https://cdn.test/live/1080p/chunklist.m3u8", new RegExp(filter));
    assert.doesNotMatch("https://cdn.test/live/chunklist_1440p.m3u8", new RegExp(filter));
    assert.doesNotMatch("https://cdn.test/live/chunklist_2160p.m3u8", new RegExp(filter));
  });

  it("rewrites every lower quality marker in observed CHZZK multi-quality HLS paths", () => {
    const url =
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/cflexnmss2u0003/360p/segment/chunklist_480p.m3u8?Policy=redacted";

    assert.equal(
      buildHighestQualityRedirectUrl(url, { targetQuality: "1080p" }),
      "https://nvelop-livecloud.pstatic.net/chzzk/lip2_kr/cflexnmss2u0003/1080p/segment/chunklist_1080p.m3u8?Policy=redacted",
    );
  });

  it("rewrites any lower numeric HLS quality to the resolved maximum while preserving signed tails", () => {
    for (const quality of ["144p", "270p", "360p", "480p", "540p", "720p", "900p", "1000p", "1080p"]) {
      assert.equal(
        buildHighestQualityRedirectUrl(
          `https://cdn.test/live/chunklist_${quality}.m3u8?Policy=example#frag`,
          {
            targetQuality: "1440p",
          },
        ),
        "https://cdn.test/live/chunklist_1440p.m3u8?Policy=example#frag",
      );
      assert.equal(
        buildHighestQualityRedirectUrl(`https://cdn.test/live/${quality}/chunklist.m3u8?Policy=example`, {
          targetQuality: "1440p",
        }),
        "https://cdn.test/live/1440p/chunklist.m3u8?Policy=example",
      );
    }
  });

  it("does not rewrite the resolved maximum or higher playlist requests", () => {
    assert.equal(
      buildHighestQualityRedirectUrl("https://cdn.test/live/chunklist_1440p.m3u8?Policy=example", {
        targetQuality: "1440p",
      }),
      null,
    );
    assert.equal(
      buildHighestQualityRedirectUrl("https://cdn.test/live/chunklist_2160p.m3u8?Policy=example", {
        targetQuality: "1440p",
      }),
      null,
    );
  });

  it("can replace the URL quality directly for availability probes", () => {
    assert.equal(
      replaceQualityInUrl("https://cdn.test/live/chunklist_720p.m3u8?Policy=example", "2160p"),
      "https://cdn.test/live/chunklist_2160p.m3u8?Policy=example",
    );
  });

  it("parses HLS master playlist variants with resolution, frame rate, and bitrate", () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,FRAME-RATE=30.00
chunklist_1080p_low.m3u8?Policy=redacted
#EXT-X-STREAM-INF:BANDWIDTH=8384000,AVERAGE-BANDWIDTH=7000000,RESOLUTION=1920x1080,FRAME-RATE=60.00
chunklist_1080p_high.m3u8?Policy=redacted
#EXT-X-STREAM-INF:BANDWIDTH=9500000,RESOLUTION=1280x720,FRAME-RATE=60.00
chunklist_720p_highbitrate.m3u8?Policy=redacted
`;

    assert.deepEqual(parseHlsMasterPlaylistVariants(playlist, "https://cdn.test/live/master.m3u8"), [
      {
        averageBandwidth: null,
        bandwidth: 4500000,
        frameRate: 30,
        quality: "1080p",
        resolution: { height: 1080, width: 1920 },
        url: "https://cdn.test/live/chunklist_1080p_low.m3u8?Policy=redacted",
      },
      {
        averageBandwidth: 7000000,
        bandwidth: 8384000,
        frameRate: 60,
        quality: "1080p",
        resolution: { height: 1080, width: 1920 },
        url: "https://cdn.test/live/chunklist_1080p_high.m3u8?Policy=redacted",
      },
      {
        averageBandwidth: null,
        bandwidth: 9500000,
        frameRate: 60,
        quality: "720p",
        resolution: { height: 720, width: 1280 },
        url: "https://cdn.test/live/chunklist_720p_highbitrate.m3u8?Policy=redacted",
      },
    ]);
  });

  it("skips malformed HLS master variants when another tag appears before the URI", () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,FRAME-RATE=30.00
#EXT-X-DISCONTINUITY
chunklist_1080p.m3u8?Policy=redacted
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=30.00
chunklist_720p.m3u8?Policy=redacted
`;

    assert.deepEqual(parseHlsMasterPlaylistVariants(playlist, "https://cdn.test/live/master.m3u8"), [
      {
        averageBandwidth: null,
        bandwidth: 3000000,
        frameRate: 30,
        quality: "720p",
        resolution: { height: 720, width: 1280 },
        url: "https://cdn.test/live/chunklist_720p.m3u8?Policy=redacted",
      },
    ]);
  });

  it("chooses the best HLS variant by resolution, then frame rate, then bitrate", () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,FRAME-RATE=30.00
chunklist_1080p_low.m3u8?Policy=redacted
#EXT-X-STREAM-INF:BANDWIDTH=8384000,AVERAGE-BANDWIDTH=7000000,RESOLUTION=1920x1080,FRAME-RATE=60.00
chunklist_1080p_high.m3u8?Policy=redacted
#EXT-X-STREAM-INF:BANDWIDTH=9500000,RESOLUTION=1280x720,FRAME-RATE=60.00
chunklist_720p_highbitrate.m3u8?Policy=redacted
`;

    assert.deepEqual(chooseBestHlsVariant(playlist, "https://cdn.test/live/master.m3u8"), {
      averageBandwidth: 7000000,
      bandwidth: 8384000,
      frameRate: 60,
      quality: "1080p",
      resolution: { height: 1080, width: 1920 },
      url: "https://cdn.test/live/chunklist_1080p_high.m3u8?Policy=redacted",
    });
  });
});
