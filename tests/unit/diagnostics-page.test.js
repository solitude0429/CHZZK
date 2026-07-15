import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

async function renderStoredDiagnostics(storedDiagnostics) {
  const elements = new Map(
    ["#summary", "#payload", "#refresh", "#copy", "#clear"].map((selector) => [
      selector,
      {
        addEventListener(_type, listener) {
          this.listener = listener;
        },
        textContent: "",
        value: "",
      },
    ]),
  );
  const context = {
    browser: {
      storage: {
        local: {
          async get() {
            return { chzzkDiagnostics: storedDiagnostics };
          },
          async remove() {},
        },
      },
    },
    console,
    document: {
      querySelector(selector) {
        return elements.get(selector);
      },
    },
    globalThis: null,
    navigator: { clipboard: { async writeText() {} } },
    setTimeout,
    URL,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../../diagnostics.js", import.meta.url), "utf8"), context, {
    filename: "diagnostics.js",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return JSON.parse(elements.get("#payload").value);
}

describe("diagnostics popup", () => {
  it("renders only the shared normalized local diagnostics schema", async () => {
    const timestamp = "2026-07-15T00:00:00.000Z";
    const rendered = await renderStoredDiagnostics({
      decisions: [],
      generatedAt: timestamp,
      maxSamples: Number.MAX_SAFE_INTEGER,
      qualities: { "720p": 1 },
      runtimeRedirects: {
        activeTabIds: [7],
        lastError: null,
        targetsByTab: { 7: "1080p" },
        updatedAt: timestamp,
      },
      samples: [
        {
          quality: "720p",
          seenAt: timestamp,
          tabId: 7,
          type: "media",
          unknown: "drop-me",
          url: "https://account-stream-identifier.pstatic.net:8443/private/720p/chunklist.m3u8?Policy=synthetic",
        },
      ],
      totalHlsRequests: "1",
      unknownTopLevel: "drop-me",
    });

    assert.deepEqual(Object.keys(rendered), [
      "decisions",
      "generatedAt",
      "maxSamples",
      "qualities",
      "runtimeRedirects",
      "samples",
      "totalHlsRequests",
    ]);
    assert.equal(rendered.maxSamples, 200);
    assert.equal(rendered.totalHlsRequests, 0);
    assert.equal(rendered.samples[0].url, "https://pstatic.net/[redacted-path]/720p.m3u8?[redacted]");
    assert.equal("unknown" in rendered.samples[0], false);
  });
});
