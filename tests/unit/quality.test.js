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
  playlistFamilyKey,
  parseQualityFromUrl,
  qualityNumber,
  redactMediaUrl,
  replaceQualityInUrl,
  urlQualityMarkersAreSafe,
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

  it("stores only an allowlisted host, quality, and media shape in diagnostics", () => {
    assert.equal(
      redactMediaUrl(
        "https://stream-account-identifier.edge.pstatic.net:8443/1080p/chunklist.m3u8?Policy=example#frag",
      ),
      "https://pstatic.net/[redacted-path]/1080p.m3u8?[redacted]",
    );
    assert.equal(
      redactMediaUrl(
        "https://session-identifier.live.gscdn.net/live/480p/hdntl=synthetic/synthetic_chunklist.m3u8",
      ),
      "https://gscdn.net/[redacted-path]/480p.m3u8",
    );
    assert.equal(
      redactMediaUrl("https://user:pass@example.test:8443/private/account/720p/chunklist.m3u8"),
      "https://other-media.invalid/[redacted-path]/720p.m3u8",
    );
    assert.equal(redactMediaUrl("not a URL with ?token=secret"), "[redacted-url]");
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

  it("preserves only the observed legacy multi-marker shape and rejects other contradictions", () => {
    const legacy =
      "https://edge.pstatic.net/chzzk/session-a/360p/segment/chunklist_480p.m3u8?Policy=example#fragment";
    const contradictory =
      "https://edge.pstatic.net/chzzk/session-a/1080p/segment/chunklist_2160p.m3u8?Policy=example#fragment";

    assert.equal(urlQualityMarkersAreSafe(legacy), true);
    assert.equal(
      replaceQualityInUrl(legacy, "1080p"),
      "https://edge.pstatic.net/chzzk/session-a/1080p/segment/chunklist_1080p.m3u8?Policy=example#fragment",
    );
    assert.equal(urlQualityMarkersAreSafe(contradictory), false);
    assert.equal(replaceQualityInUrl(contradictory, "2160p"), null);
    assert.equal(buildHighestQualityRedirectUrl(contradictory, { targetQuality: "2160p" }), null);
  });

  it("fails closed for a deterministic matrix of contradictory quality-marker pairs", () => {
    const qualities = ["360p", "480p", "720p", "1080p", "1440p", "2160p"];
    for (const directoryQuality of qualities) {
      for (const filenameQuality of qualities) {
        const url = `https://edge.pstatic.net/family/${directoryQuality}/segment/chunklist_${filenameQuality}.m3u8?Policy=example#tail`;
        const isLegacy = directoryQuality === "360p" && filenameQuality === "480p";
        const isConsistent = directoryQuality === filenameQuality;
        assert.equal(
          urlQualityMarkersAreSafe(url),
          isLegacy || isConsistent,
          `${directoryQuality}/${filenameQuality}`,
        );
        if (!isLegacy && !isConsistent) {
          assert.equal(replaceQualityInUrl(url, "4320p"), null, `${directoryQuality}/${filenameQuality}`);
        }
      }
    }
  });

  it("derives secret-free playlist family keys that isolate independent stream roots", () => {
    const first =
      "https://edge.pstatic.net/chzzk/session-a/hdntl=synthetic-a/360p/segment/chunklist_480p.m3u8?Policy=synthetic-a#fragment-a";
    const rewritten =
      "https://edge.pstatic.net/chzzk/session-a/hdntl=synthetic-b/1080p/segment/chunklist_1080p.m3u8?Signature=synthetic-b#fragment-b";
    const master = "https://edge.pstatic.net/chzzk/session-a/master.m3u8?Token=synthetic-c";
    const otherFamily =
      "https://edge.pstatic.net/chzzk/session-b/1080p/segment/chunklist_1080p.m3u8?Policy=synthetic-d";

    const family = playlistFamilyKey(first);
    assert.equal(family, playlistFamilyKey(rewritten));
    assert.equal(family, playlistFamilyKey(master));
    assert.notEqual(family, playlistFamilyKey(otherFamily));
    assert.doesNotMatch(family, /synthetic|Policy|Signature|Token|hdntl|360p|480p|1080p/i);
  });

  it("separates safe same-root playlist names while stripping signed path tails", () => {
    const generic =
      "https://edge.pstatic.net/chzzk/session-a/360p/segment/chunklist_480p.m3u8?Policy=synthetic";
    const signedPathTail =
      "https://edge.pstatic.net/chzzk/session-a/1080p/segment/chunklist_1080p.m3u8/Key-Pair-Id=synthetic/signature=synthetic#fragment";
    const ad =
      "https://edge.pstatic.net/chzzk/session-a/360p/segment/chunklist_480p_ad.m3u8?Policy=synthetic";
    const adAtAnotherQuality =
      "https://edge.pstatic.net/chzzk/session-a/1080p/segment/chunklist_1080p_ad.m3u8?Signature=synthetic";
    const dvr =
      "https://edge.pstatic.net/chzzk/session-a/360p/segment/chunklist_480p_dvr.m3u8?Policy=synthetic";
    const delimiterShapedDirectory =
      "https://edge.pstatic.net/chzzk/session-a::ad/360p/segment/chunklist_480p.m3u8?Policy=synthetic";

    assert.equal(playlistFamilyKey(generic), playlistFamilyKey(signedPathTail));
    assert.equal(playlistFamilyKey(ad), playlistFamilyKey(adAtAnotherQuality));
    assert.notEqual(playlistFamilyKey(generic), playlistFamilyKey(ad));
    assert.notEqual(playlistFamilyKey(ad), playlistFamilyKey(dvr));
    assert.notEqual(
      playlistFamilyKey(delimiterShapedDirectory),
      playlistFamilyKey(ad),
      "family serialization must not collide with safe filename discriminators",
    );
    for (const url of [generic, signedPathTail, ad, adAtAnotherQuality, dvr]) {
      assert.doesNotMatch(playlistFamilyKey(url), /synthetic|Policy|Signature|Key-Pair-Id|360p|480p|1080p/i);
    }
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

  it("rewrites suffix variants in pathname only and preserves the signed tail byte-for-byte", () => {
    const input =
      "https://cdn.test/live/360p/chunklist_480p_highbitrate.m3u8?next=/360p/chunklist_480p.m3u8&encoded=%2F360p%2F#fragment/480p/";

    assert.equal(
      replaceQualityInUrl(input, "1080p"),
      "https://cdn.test/live/1080p/chunklist_1080p_highbitrate.m3u8?next=/360p/chunklist_480p.m3u8&encoded=%2F360p%2F#fragment/480p/",
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

  it("rejects duplicate HLS attributes instead of applying last-wins parsing", () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,BANDWIDTH=2000000,RESOLUTION=1920x1080
chunklist_1080p_duplicate.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1",CODECS="avc2",RESOLUTION=1280x720
chunklist_720p_duplicate.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=854x480
chunklist_480p_valid.m3u8
`;

    assert.deepEqual(parseHlsMasterPlaylistVariants(playlist, "https://cdn.test/live/master.m3u8"), [
      {
        averageBandwidth: null,
        bandwidth: 3000000,
        frameRate: null,
        quality: "480p",
        resolution: { height: 480, width: 854 },
        url: "https://cdn.test/live/chunklist_480p_valid.m3u8",
      },
    ]);
  });

  it("accepts only bounded positive decimal bandwidth and frame-rate syntax", () => {
    const invalidMetrics = [
      "FRAME-RATE=60",
      "BANDWIDTH=0",
      "BANDWIDTH=-1",
      "BANDWIDTH=0x10",
      "BANDWIDTH=1e6",
      "BANDWIDTH=1000000001",
      "BANDWIDTH=1000,AVERAGE-BANDWIDTH=-1",
      "BANDWIDTH=1000,AVERAGE-BANDWIDTH=0x10",
      "BANDWIDTH=1000,AVERAGE-BANDWIDTH=1e3",
      "BANDWIDTH=1000,FRAME-RATE=0",
      "BANDWIDTH=1000,FRAME-RATE=-60",
      "BANDWIDTH=1000,FRAME-RATE=0x3c",
      "BANDWIDTH=1000,FRAME-RATE=6e1",
      "BANDWIDTH=1000,FRAME-RATE=.5",
      "BANDWIDTH=1000,FRAME-RATE=240.01",
    ];
    const malformed = invalidMetrics
      .map(
        (attributes, index) =>
          `#EXT-X-STREAM-INF:${attributes},RESOLUTION=640x360\nchunklist_360p_invalid-${index}.m3u8`,
      )
      .join("\n");
    const playlist = `#EXTM3U
${malformed}
#EXT-X-STREAM-INF:BANDWIDTH=1000000000,AVERAGE-BANDWIDTH=999999999,RESOLUTION=1920x1080,FRAME-RATE=240.0
chunklist_1080p_valid.m3u8
`;

    const variants = parseHlsMasterPlaylistVariants(playlist, "https://cdn.test/live/master.m3u8");
    assert.equal(variants.length, 1);
    assert.deepEqual(variants[0], {
      averageBandwidth: 999999999,
      bandwidth: 1000000000,
      frameRate: 240,
      quality: "1080p",
      resolution: { height: 1080, width: 1920 },
      url: "https://cdn.test/live/chunklist_1080p_valid.m3u8",
    });
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

    assert.equal(
      chooseBestHlsVariant(playlist, "https://cdn.test/live/master.m3u8", {
        excludedQualities: ["1080p"],
      })?.quality,
      "720p",
      "master re-resolution must skip every target still in failure backoff",
    );
  });
});
