import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlaylistProbe, networkRequestUrl } from "../../src/runtime/playlist-probe.js";
import { playlistFamilyKey } from "../../src/shared/quality.js";

const policy = Object.freeze({
  minRedirectQuality: "100p",
  probeMaxBytes: 256_000,
  probeTimeoutMs: 1500,
  qualityCandidates: ["2160p", "1440p", "1080p", "720p", "480p"],
  trustedRequestDomains: ["pstatic.net"],
});

function playlistResponse(url, body, headers = {}) {
  return {
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    ok: true,
    status: 200,
    text: async () => body,
    url,
  };
}

function mediaPlaylist(segment = "segment.ts") {
  return `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n${segment}\n`;
}

describe("runtime playlist probe", () => {
  it("strips only a client-side fragment from network event URLs", () => {
    assert.equal(
      networkRequestUrl("https://edge.pstatic.net/live.m3u8?Policy=one#tail"),
      "https://edge.pstatic.net/live.m3u8?Policy=one",
    );
    assert.equal(
      networkRequestUrl("https://edge.pstatic.net/live.m3u8?Policy=one"),
      "https://edge.pstatic.net/live.m3u8?Policy=one",
    );
    assert.equal(networkRequestUrl(""), null);
  });

  it("continues candidate resolution after unusable higher-quality evidence", async () => {
    const requested = [];
    const probe = createPlaylistProbe({
      fetchImpl: async (url) => {
        requested.push(url);
        if (url.includes("2160p")) return playlistResponse(networkRequestUrl(url), "#EXTM3U\n");
        if (url.includes("1440p")) return playlistResponse(networkRequestUrl(url), mediaPlaylist());
        throw new Error(`unexpected candidate ${url}`);
      },
      policy,
    });
    const details = {
      url: "https://edge.pstatic.net/chzzk/channel/chunklist_480p.m3u8?Policy=synthetic#tail",
    };

    assert.deepEqual(await probe.resolveHighestSupportedQuality(details, "480p"), {
      evidenceKind: "url-marker",
      targetQuality: "1440p",
      validatedNetworkUrl: "https://edge.pstatic.net/chzzk/channel/chunklist_1440p.m3u8?Policy=synthetic",
    });
    assert.equal(
      requested.some((url) => url.includes("2160p")),
      true,
    );
    assert.equal(
      requested.some((url) => url.includes("1440p")),
      true,
    );
    assert.equal(
      requested.every((url) => url.endsWith("#tail")),
      true,
      "the probe input should retain the client fragment while Fetch response URLs omit it",
    );
  });

  it("compares exact network URLs after removing only the client-side fragment", async () => {
    const url = "https://edge.pstatic.net/chzzk/channel/chunklist_1080p.m3u8?Policy=synthetic#tail";
    const accepted = createPlaylistProbe({
      fetchImpl: async () => playlistResponse(networkRequestUrl(url), mediaPlaylist()),
      policy,
    });
    assert.deepEqual(await accepted.fetchPlaylistEvidence(url), {
      finalUrl: "https://edge.pstatic.net/chzzk/channel/chunklist_1080p.m3u8?Policy=synthetic",
      text: mediaPlaylist(),
    });

    const changedQuery = createPlaylistProbe({
      fetchImpl: async () =>
        playlistResponse(
          "https://edge.pstatic.net/chzzk/channel/chunklist_1080p.m3u8?Policy=changed",
          mediaPlaylist(),
        ),
      policy,
    });
    assert.equal(await changedQuery.fetchPlaylistEvidence(url), null);
  });

  it("ranks only trusted, quality-consistent master variants", async () => {
    const masterUrl = "https://edge.pstatic.net/chzzk/channel/master.m3u8?Policy=synthetic";
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,FRAME-RATE=60.0
https://untrusted.example.invalid/chunklist_2160p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,FRAME-RATE=60.0
chunklist_1440p.m3u8?Policy=synthetic
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.0
chunklist_1080p.m3u8?Policy=synthetic
`;
    const probe = createPlaylistProbe({
      fetchImpl: async (url) => playlistResponse(url, master),
      policy,
    });

    const expected = {
      evidenceKind: "master",
      targetDedicatedHls: false,
      targetFamilyKey: playlistFamilyKey(
        "https://edge.pstatic.net/chzzk/channel/chunklist_1440p.m3u8?Policy=synthetic",
      ),
      targetQuality: "1440p",
    };
    assert.deepEqual(await probe.resolveBestVariantFromMaster({ url: masterUrl }), expected);
    assert.deepEqual(
      probe.resolveBestVariantFromEvidence({
        finalUrl: masterUrl,
        text: master,
      }),
      expected,
    );
    assert.equal(
      probe.resolveBestVariantFromEvidence({
        finalUrl: "https://untrusted.example.invalid/master.m3u8",
        text: master,
      }),
      null,
    );
  });

  it("does not cap an advertised master quality to the numeric fallback candidate grid", async () => {
    const masterUrl = "https://edge.pstatic.net/chzzk/channel/hls_playlist.m3u8?Policy=synthetic";
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=40000000,RESOLUTION=7680x4320,FRAME-RATE=60.0
chunklist_4320p.m3u8?Policy=synthetic
#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,FRAME-RATE=60.0
chunklist_2160p.m3u8?Policy=synthetic
`;
    const probe = createPlaylistProbe({
      fetchImpl: async (url) => playlistResponse(url, master),
      policy,
    });

    assert.deepEqual(await probe.resolveBestVariantFromMaster({ url: masterUrl }), {
      evidenceKind: "master",
      targetDedicatedHls: false,
      targetFamilyKey: playlistFamilyKey(
        "https://edge.pstatic.net/chzzk/channel/chunklist_4320p.m3u8?Policy=synthetic",
      ),
      targetQuality: "4320p",
    });
  });

  it("rejects oversized streamed bodies and cancels the reader", async () => {
    let cancelled = false;
    const reader = {
      async cancel() {
        cancelled = true;
      },
      async read() {
        return { done: false, value: new Uint8Array([1, 2, 3, 4, 5]) };
      },
    };
    const url = "https://edge.pstatic.net/chzzk/channel/chunklist_1080p.m3u8";
    const probe = createPlaylistProbe({
      fetchImpl: async () => ({
        body: { getReader: () => reader },
        headers: { get: () => null },
        ok: true,
        url,
      }),
      policy: { ...policy, probeMaxBytes: 4 },
    });

    assert.equal(await probe.fetchPlaylistEvidence(url), null);
    assert.equal(cancelled, true);
  });

  it("rejects obvious non-playlist MIME types before reading the body", async () => {
    let read = false;
    const url = "https://edge.pstatic.net/chzzk/channel/chunklist_1080p.m3u8";
    const probe = createPlaylistProbe({
      fetchImpl: async () => ({
        headers: { get: (name) => (name === "content-type" ? "text/html; charset=utf-8" : null) },
        ok: true,
        text: async () => {
          read = true;
          return mediaPlaylist();
        },
        url,
      }),
      policy,
    });

    assert.equal(await probe.fetchPlaylistEvidence(url), null);
    assert.equal(read, false);
  });
});
