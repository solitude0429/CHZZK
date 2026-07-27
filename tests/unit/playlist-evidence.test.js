import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isLikelyHlsPlaylist,
  isUsableHlsPlaylist,
  isUtf8TextWithinByteLimit,
} from "../../src/shared/playlist-evidence.js";

describe("bounded HLS response evidence", () => {
  it("retains the exact first-meaningful-line header classifier", () => {
    assert.equal(isLikelyHlsPlaylist("\uFEFF\n  #EXTM3U  \n#EXT-X-VERSION:3"), true);
    assert.equal(isLikelyHlsPlaylist("# comment\n#EXTM3U"), false);
    assert.equal(isLikelyHlsPlaylist("#extm3u\n"), false);
  });

  it("rejects header-only and metadata-only responses", () => {
    for (const text of [
      "#EXTM3U\n",
      "#EXTM3U\n#EXT-X-VERSION:3\n",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n",
      "#EXTM3U\n#EXTINF:4,\n",
    ]) {
      assert.equal(isUsableHlsPlaylist(text), false);
    }
  });

  it("accepts structurally usable media playlists, including byte-range media", () => {
    assert.equal(
      isUsableHlsPlaylist("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nsegment-001.ts?Policy=x\n"),
      true,
    );
    assert.equal(
      isUsableHlsPlaylist(
        "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:1024@0\nmedia.mp4\n",
      ),
      true,
    );
  });

  it("accepts usable LL-HLS parts and part preload hints", () => {
    assert.equal(
      isUsableHlsPlaylist(
        '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART:DURATION=0.333,URI="part-1.m4s?token=x"\n',
      ),
      true,
    );
    assert.equal(
      isUsableHlsPlaylist(
        '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-next.m4s"\n',
      ),
      true,
    );
  });

  it("rejects GAP-only LL-HLS evidence but accepts a later usable part", () => {
    const gapPart = '#EXT-X-PART:DURATION=0.333,URI="part-gap.m4s",GAP=YES\n';
    assert.equal(isUsableHlsPlaylist(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n${gapPart}`), false);
    assert.equal(
      isUsableHlsPlaylist(
        `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${gapPart}#EXT-X-PART:DURATION=0.333,URI="part-live.m4s"\n`,
      ),
      true,
    );
  });

  it("accepts a master playlist only when a variant URI follows its tag", () => {
    assert.equal(
      isUsableHlsPlaylist(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nchunklist_1080p.m3u8\n",
      ),
      true,
    );
    assert.equal(
      isUsableHlsPlaylist(
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n#EXT-X-DISCONTINUITY\nchunklist_1080p.m3u8\n",
      ),
      false,
    );
  });

  it("rejects unsafe or malformed media URIs and attributes", () => {
    for (const text of [
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:0,\nsegment.ts\n",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n#EXT-X-BYTERANGE:0@0\nmedia.mp4\n",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n<script>\n",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ndata:text/plain,x\n",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttp://edge.example.invalid/segment.ts\n",
      "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment\u0000.ts\n",
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART:DURATION=0.3,URI="unterminated\n',
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-PRELOAD-HINT:TYPE=MAP,URI="part.m4s"\n',
    ]) {
      assert.equal(isUsableHlsPlaylist(text), false);
    }
  });

  it("enforces the UTF-8 byte cap rather than JavaScript character length", () => {
    assert.equal(isUtf8TextWithinByteLimit("가", 2), false);
    assert.equal(isUtf8TextWithinByteLimit("가", 3), true);
    assert.equal(isUtf8TextWithinByteLimit("😀", 4), true);
  });
});
