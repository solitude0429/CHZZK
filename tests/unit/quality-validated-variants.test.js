import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseBestHlsVariant,
  chooseBestHlsVariantFromVariants,
  parseHlsMasterPlaylistVariants,
} from "../../src/shared/quality.js";

const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,FRAME-RATE=60.0
https://outside.example/2160p/chunklist_2160p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=2560x1440,FRAME-RATE=60.0
https://edge.pstatic.net/live/1440p/chunklist_1440p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.0
https://edge.pstatic.net/live/1080p/chunklist_1080p.m3u8
`;

describe("validated HLS variant scoring", () => {
  it("scores an already validated candidate set without reparsing it", () => {
    const variants = parseHlsMasterPlaylistVariants(playlist, "https://edge.pstatic.net/live/master.m3u8");
    assert.equal(chooseBestHlsVariant(playlist)?.quality, "2160p");
    assert.equal(chooseBestHlsVariantFromVariants(variants.slice(1))?.quality, "1440p");
  });

  it("retains minimum-quality and failure-backoff filtering", () => {
    const variants = parseHlsMasterPlaylistVariants(playlist);
    assert.equal(
      chooseBestHlsVariantFromVariants(variants, { excludedQualities: ["2160p", "1440p"] })?.quality,
      "1080p",
    );
    assert.equal(chooseBestHlsVariantFromVariants(variants, { minRedirectQuality: "2161p" }), null);
  });

  it("fails closed for non-array candidate input", () => {
    assert.equal(chooseBestHlsVariantFromVariants(null), null);
    assert.equal(chooseBestHlsVariantFromVariants({}), null);
  });
});
