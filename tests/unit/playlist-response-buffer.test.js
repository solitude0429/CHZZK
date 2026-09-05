import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlaylistResponseBuffer } from "../../src/runtime/playlist-response-buffer.js";

describe("playlist response evidence buffer", () => {
  it("preserves UTF-8 characters split across response chunks at the byte limit", () => {
    const text = "#EXTM3U\n# 치지직\nsegment.ts\n";
    const bytes = new TextEncoder().encode(text);
    const body = createPlaylistResponseBuffer(bytes.byteLength);
    for (const byte of bytes) body.append(Uint8Array.of(byte).buffer);

    assert.equal(body.totalBytes, bytes.byteLength);
    assert.equal(body.oversized, false);
    assert.equal(body.finish(), text);
  });

  it("discards oversized evidence even when later chunks contain a valid playlist", () => {
    const bytes = new TextEncoder().encode("#EXTM3U\nsegment.ts\n");
    const body = createPlaylistResponseBuffer(bytes.byteLength);
    body.append(bytes.buffer);
    body.append(Uint8Array.of(10).buffer);
    body.append(bytes.buffer);

    assert.equal(body.oversized, true);
    assert.equal(body.totalBytes, bytes.byteLength + 1);
    assert.equal(body.finish(), null);
  });

  it("distinguishes an empty cache response from oversized evidence", () => {
    const body = createPlaylistResponseBuffer(100);
    body.append(new ArrayBuffer(0));

    assert.equal(body.totalBytes, 0);
    assert.equal(body.oversized, false);
    assert.equal(body.finish(), "");
  });
});
