import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

async function renderStoredDiagnostics(
  storedDiagnostics,
  {
    get = async () => ({ chzzkDiagnostics: storedDiagnostics }),
    sendMessage = async () => ({ ok: true, diagnostics: null }),
    copy = async () => {},
    returnElements = false,
  } = {},
) {
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
      runtime: { sendMessage },
      storage: {
        local: {
          get,
          async remove() {
            throw new Error("Clear must use the background queue");
          },
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
    navigator: { clipboard: { writeText: copy } },
    setTimeout,
    URL,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../../diagnostics.js", import.meta.url), "utf8"), context, {
    filename: "diagnostics.js",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return returnElements ? elements : JSON.parse(elements.get("#payload").value);
}

describe("diagnostics popup", () => {
  it("does not let a delayed refresh restore the screen after clearing", async () => {
    let finishRead;
    const delayed = new Promise((resolve) => {
      finishRead = resolve;
    });
    let messageType;
    const elements = await renderStoredDiagnostics(null, {
      get: () => delayed,
      sendMessage: async (message) => {
        messageType = message.type;
        return { ok: true, diagnostics: null };
      },
      returnElements: true,
    });
    await elements.get("#clear").listener();
    assert.equal(messageType, "chzzk.clear-diagnostics");
    assert.equal(JSON.parse(elements.get("#payload").value).totalHlsRequests, 0);
    finishRead({ chzzkDiagnostics: { totalHlsRequests: 7 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(JSON.parse(elements.get("#payload").value).totalHlsRequests, 0);
  });

  it("handles failed popup actions without showing raw exception details", async () => {
    const fail = async () => {
      throw new Error("synthetic-private-error");
    };
    const elements = await renderStoredDiagnostics(null, {
      get: fail,
      sendMessage: fail,
      copy: fail,
      returnElements: true,
    });
    assert.equal(elements.get("#summary").textContent, "Unable to load diagnostics. Try again.");
    for (const [selector, action] of [
      ["#refresh", "load"],
      ["#copy", "copy"],
      ["#clear", "clear"],
    ]) {
      await elements.get(selector).listener();
      assert.equal(elements.get("#summary").textContent, `Unable to ${action} diagnostics. Try again.`);
    }
  });

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
      runtimeTransitions: [
        {
          action: "ignored",
          fromQuality: "1080p",
          reason: "client-cancelled",
          seenAt: timestamp,
          source: "redirect-response",
          toQuality: "1080p",
          unknown: "drop-me",
        },
      ],
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
      "runtimeTransitions",
      "samples",
      "totalHlsRequests",
    ]);
    assert.equal(rendered.maxSamples, 200);
    assert.equal(rendered.totalHlsRequests, 0);
    assert.equal(rendered.samples[0].url, "https://pstatic.net/[redacted-path]/720p.m3u8?[redacted]");
    assert.equal("unknown" in rendered.samples[0], false);
    assert.equal("unknown" in rendered.runtimeTransitions[0], false);
  });
});
