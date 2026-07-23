import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMasterVariantRedirectUrl,
  canonicalNetworkUrl,
  chooseBestHlsVariant,
  isHlsPlaylistUrl,
  parseHlsMasterPlaylistVariants,
  playlistFamilyKey,
} from "../../src/shared/quality.js";
import { analyzeHlsPlaylist } from "../../src/shared/playlist-evidence.js";

describe("edge-case primitives", () => {
  it("keeps semantic query, ordered path, and the final playlist segment in family identity", () => {
    const pairs = [
      [
        "https://edge.pstatic.net/chzzk/session/chunklist_480p.m3u8?stream=A",
        "https://edge.pstatic.net/chzzk/session/chunklist_480p.m3u8?stream=B",
      ],
      [
        "https://edge.pstatic.net/chzzk/session;stream=A/480p/segment/chunklist_480p.m3u8",
        "https://edge.pstatic.net/chzzk/session;stream=B/480p/segment/chunklist_480p.m3u8",
      ],
      [
        "https://edge.pstatic.net/chzzk/session/480p/segment/ad/chunklist_480p.m3u8",
        "https://edge.pstatic.net/chzzk/session/480p/ad/segment/chunklist_480p.m3u8",
      ],
      [
        "https://edge.pstatic.net/root/archive.m3u8/a/480p/chunklist_480p.m3u8",
        "https://edge.pstatic.net/root/archive.m3u8/b/480p/chunklist_480p.m3u8",
      ],
    ];
    for (const [left, right] of pairs) assert.notEqual(playlistFamilyKey(left), playlistFamilyKey(right));
    assert.notEqual(
      playlistFamilyKey("https://edge.pstatic.net/a/chunklist_480p.m3u8?a=1&b=2"),
      playlistFamilyKey("https://edge.pstatic.net/a/chunklist_480p.m3u8?b=2&a=1"),
    );
    assert.doesNotMatch(playlistFamilyKey(pairs[0][0]), /stream=A/);
  });

  it("recognizes allowlisted signed path tails as playlist URLs", () => {
    assert.equal(
      isHlsPlaylistUrl(
        "https://edge.pstatic.net/a/chunklist_480p.m3u8/Key-Pair-Id=synthetic/signature=synthetic",
      ),
      true,
    );
    assert.equal(
      isHlsPlaylistUrl("https://edge.pstatic.net/a/chunklist_480p.m3u8/unrelated=value"),
      false,
    );
  });

  it("filters invalid variants before ranking", () => {
    const playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\nhttps://untrusted.invalid/chunklist_2160p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nchunklist_1080p.m3u8\n`;
    const selected = chooseBestHlsVariant(playlist, "https://edge.pstatic.net/live/master.m3u8", {
      variantFilter: (variant) => new URL(variant.url).hostname.endsWith("pstatic.net"),
    });
    assert.equal(selected.quality, "1080p");
  });

  it("rejects poisoned HLS attributes and implausible resolution values", () => {
    const malformed = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH="1000",RESOLUTION=99999x99999\nchunklist_9999p.m3u8\n#ext-x-stream-inf:BANDWIDTH=1000,RESOLUTION=1920x1080\nchunklist_1080p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1920x1080,\nchunklist_1080p.m3u8\n`;
    assert.deepEqual(parseHlsMasterPlaylistVariants(malformed, "https://edge.pstatic.net/live/master.m3u8"), []);
  });

  it("rejects EXTM3U-prefixed non-HLS bodies but accepts temporarily empty live media playlists", () => {
    assert.deepEqual(analyzeHlsPlaylist("#EXTM3U\n<html>error</html>"), {
      kind: null,
      valid: false,
    });
    assert.deepEqual(analyzeHlsPlaylist("#EXTM3U\n#EXT-X-VERSION:3\n"), {
      kind: "media",
      valid: true,
    });
  });

  it("requires immediate master/media URI binding and validates inline LL-HLS URI attributes", () => {
    assert.deepEqual(
      analyzeHlsPlaylist(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\n# comment\nchunklist_360p.m3u8\n",
      ),
      { kind: null, valid: false },
    );
    assert.deepEqual(
      analyzeHlsPlaylist("#EXTM3U\n#EXTINF:4,\n#EXT-X-DISCONTINUITY\nsegment.ts\n"),
      { kind: null, valid: false },
    );
    assert.deepEqual(
      analyzeHlsPlaylist(
        '#EXTM3U\n#EXT-X-PART:DURATION=0.333,URI="part-1.m4s"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-2.m4s"\n',
      ),
      { kind: "media", valid: true },
    );
    assert.deepEqual(
      analyzeHlsPlaylist('#EXTM3U\n#EXT-X-PART:DURATION=0.333,URI=""\n'),
      { kind: null, valid: false },
    );
    assert.deepEqual(
      analyzeHlsPlaylist('#EXTM3U\n#EXT-X-PART:DURATION=0.333,URI="part,1.m4s"\n'),
      { kind: "media", valid: true },
    );
  });

  it("preserves an encoded slash exactly once when stripping a signed path suffix", () => {
    const key = playlistFamilyKey(
      "https://edge.pstatic.net/chzzk/session%2Fpart~Policy=secret/480p/chunklist_480p.m3u8",
    );
    assert.match(key, /session%2Fpart/i);
    assert.doesNotMatch(key, /session%252Fpart/i);
    assert.doesNotMatch(key, /secret/);
  });

  it("canonicalizes network identity and merges only live-control query fields into a master URI", () => {
    assert.equal(
      canonicalNetworkUrl("HTTPS://EDGE.PSTATIC.NET:443/a/../b.m3u8#client"),
      "https://edge.pstatic.net/b.m3u8",
    );
    assert.equal(
      buildMasterVariantRedirectUrl(
        "https://edge.pstatic.net/video/main.m3u8?Policy=master",
        "https://edge.pstatic.net/low.m3u8?Policy=low&_HLS_msn=42#tail",
      ),
      "https://edge.pstatic.net/video/main.m3u8?Policy=master&_HLS_msn=42#tail",
    );
  });
});
