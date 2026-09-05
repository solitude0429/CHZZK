import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLAYER_LAYOUT_SELECTOR,
  QUALITY_PANE_SELECTOR,
  createHighestQualityPlayerController,
} from "../../src/runtime/player-controller.js";
import { createPlayerSelectionGuards } from "../../src/runtime/player-selection-guards.js";
import { createDiagnosticsStore } from "../../src/runtime/diagnostics-store.js";
import { createPlaylistProbe } from "../../src/runtime/playlist-probe.js";
import {
  createDiagnosticsSnapshot,
  createEmptyDiagnostics,
  normalizeDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
  updateRuntimeRedirectDiagnostics,
} from "../../src/shared/diagnostics.js";
import { isLikelyHlsPlaylist, isUsableHlsPlaylist } from "../../src/shared/playlist-evidence.js";

// Only the page and clock are test doubles. Selection discovery, guards,
// scheduling, write budgets, persistence and playlist validation are real modules.
function selectionHarness({ mode = "ignore", initiallyHigh = false } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const pendingApplies = [];
  const writes = [0, 0];
  const selected = [!initiallyHigh, initiallyHigh];
  const tracks = [
    { height: 360, width: 640, label: "360p" },
    { height: 1080, width: 1920, label: "1080p" },
  ];
  tracks.selectedIndex = initiallyHigh ? 1 : 0;
  for (const [index, track] of tracks.entries()) {
    Object.defineProperty(track, "selected", {
      configurable: true,
      get: () => selected[index],
      set(value) {
        if (value !== true) {
          selected[index] = false;
          return;
        }
        writes[index] += 1;
        const apply = () => {
          selected[0] = index === 0;
          selected[1] = index === 1;
          tracks.selectedIndex = index;
        };
        if (index === 0 || mode === "apply") apply();
        else if (mode === "throw") throw new Error("synthetic selection rejection");
        else if (mode === "delay") pendingApplies.push(apply);
      },
    });
  }
  const player = { videoTracks: tracks };
  const pane = { filter: () => true };
  const documentRef = new EventTarget();
  documentRef.querySelector = (selector) => {
    if (selector === PLAYER_LAYOUT_SELECTOR) return player;
    if (selector === QUALITY_PANE_SELECTOR) return pane;
    return null;
  };
  documentRef.querySelectorAll = () => [];
  const stored = new Map();
  const controller = createHighestQualityPlayerController({
    MutationObserverImpl: undefined,
    clearTimeoutImpl: (id) => timers.delete(id),
    documentRef,
    historyRef: {},
    locationRef: { hostname: "chzzk.naver.com", pathname: "/live/test" },
    nowImpl: () => now,
    setTimeoutImpl(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
    windowRef: new EventTarget(),
  });
  function advanceTo(target) {
    assert.ok(target >= now);
    for (let steps = 0; steps < 1000; steps += 1) {
      const next = [...timers].sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
      if (!next || next[1].at > target) {
        now = target;
        return;
      }
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
    }
    assert.fail("selection timers failed to settle within the bounded test clock");
  }
  function requestLowerRepeatedly() {
    for (let index = 0; index < 100; index += 1) tracks[0].selected = true;
  }
  return {
    advanceTo,
    controller,
    documentRef,
    pendingApplies,
    requestLowerRepeatedly,
    timers,
    tracks,
    writes,
  };
}

describe("review: intercepted selection uses the controller write path", () => {
  it("coalesces repeated lower requests while an ignored high write awaits confirmation", () => {
    const h = selectionHarness();
    try {
      h.controller.start();
      h.advanceTo(0);
      assert.equal(h.writes[1], 1);
      h.requestLowerRepeatedly();
      assert.equal(h.writes[1], 1, "a page setter must not synchronously write the high track");
      h.advanceTo(1000);
      assert.equal(h.writes[1], 2, "only the controller confirmation retry may write");
      h.requestLowerRepeatedly();
      h.advanceTo(4999);
      assert.equal(h.writes[1], 2, "guard requests must not replenish the candidate budget");
      h.advanceTo(6000);
      assert.equal(h.writes[1], 3, "one retry becomes available after the existing cooldown");
      assert.equal(h.writes[0], 0);
    } finally {
      h.controller.stop();
    }
  });

  it("does not propagate high-track rejection into the page's lower-track setter", () => {
    const h = selectionHarness({ mode: "throw" });
    try {
      h.controller.start();
      h.advanceTo(0);
      assert.doesNotThrow(h.requestLowerRepeatedly);
      assert.doesNotThrow(() => h.advanceTo(2000));
      assert.equal(h.writes[1], 2);
    } finally {
      h.controller.stop();
    }
  });

  it("confirms a delayed selection once without duplicate writes from the guard", () => {
    const h = selectionHarness({ mode: "delay" });
    try {
      h.controller.start();
      h.advanceTo(0);
      h.requestLowerRepeatedly();
      h.advanceTo(0);
      assert.equal(h.pendingApplies.length, 1);
      h.pendingApplies[0]();
      h.advanceTo(50);
      h.requestLowerRepeatedly();
      h.advanceTo(1000);
      assert.equal(h.writes[1], 1);
      assert.equal(h.tracks.selectedIndex, 1);
    } finally {
      h.controller.stop();
    }
  });

  it("does not rewrite an already selected high track", () => {
    const h = selectionHarness({ initiallyHigh: true });
    try {
      h.controller.start();
      h.advanceTo(0);
      h.requestLowerRepeatedly();
      h.advanceTo(1000);
      assert.deepEqual(h.writes, [0, 0]);
    } finally {
      h.controller.stop();
    }
  });

  it("cancels a guard-requested scan on stop and restores the original lower setter", () => {
    const h = selectionHarness();
    h.controller.start();
    h.advanceTo(0);
    h.requestLowerRepeatedly();
    h.controller.stop();
    assert.equal(h.timers.size, 0);
    h.advanceTo(10000);
    assert.equal(h.writes[1], 1);
    h.tracks[0].selected = true;
    assert.equal(h.writes[0], 1);
  });

  it("contains errors from the injected scheduling boundary", () => {
    const h = selectionHarness();
    const guards = createPlayerSelectionGuards(h.documentRef, {
      requestSelection() {
        throw new Error("synthetic scheduler rejection");
      },
    });
    try {
      guards.resolve();
      assert.doesNotThrow(h.requestLowerRepeatedly);
      assert.deepEqual(h.writes, [0, 0]);
    } finally {
      guards.restore();
    }
  });
});

const header = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n";
const hint = '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"\n';
const part = '#EXT-X-PART:DURATION=0.5,URI="current.m4s"\n';

describe("review: hints are not available media evidence", () => {
  for (const [name, body] of [
    ["hint only", header + hint],
    ["gap segment and hint", header + "#EXTINF:2,\n#EXT-X-GAP\nmissing.ts\n" + hint],
    ["gap part and hint", header + '#EXT-X-PART:DURATION=0.5,URI="missing.m4s",GAP=YES\n' + hint],
    ["endlist and hint", header + hint + "#EXT-X-ENDLIST\n"],
    ["published part plus contradictory endlist and hint", header + part + "#EXT-X-ENDLIST\n" + hint],
  ]) {
    it(`rejects ${name} for selection while retaining HLS header recognition`, () => {
      assert.equal(isLikelyHlsPlaylist(body), true);
      assert.equal(isUsableHlsPlaylist(body), false);
    });
  }

  it("accepts real parts alongside a future hint and completed media without hints", () => {
    assert.equal(isUsableHlsPlaylist(header + part + hint), true);
    assert.equal(isUsableHlsPlaylist(header + "#EXTINF:2,\navailable.ts\n#EXT-X-ENDLIST\n"), true);
  });

  it("does not promote a numeric probe from a hint until an actual part is published", async () => {
    let body = header + hint;
    const requests = [];
    const url = "https://nvelop-livecloud.pstatic.net/chzzk/test/chunklist_1080p.m3u8";
    const probe = createPlaylistProbe({
      policy: { qualityCandidates: ["1080p"], minRedirectQuality: "100p" },
      fetchImpl: async (request) => {
        requests.push(request);
        return new Response(body, { status: 200 });
      },
    });
    assert.equal(await probe.fetchPlaylistEvidence(url), null);
    body = header + part + hint;
    const evidence = await probe.fetchPlaylistEvidence(url);
    assert.equal(probe.playlistEvidenceSupportsExpectedQuality(evidence, "1080p"), true);
    assert.deepEqual(requests, [url, url], "validation must not download media or hinted resources");
  });
});

function assertNoTabIdentifiers(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!["tabId", "activeTabIds", "targetsByTab"].includes(key), `unexpected persisted key: ${key}`);
    assertNoTabIdentifiers(entry);
  }
}

function legacyDiagnostics() {
  const timestamp = "2026-09-05T00:00:00.000Z";
  return {
    ...createEmptyDiagnostics(),
    samples: [{ quality: "720p", seenAt: timestamp, tabId: 987654321, type: "media", url: "" }],
    runtimeRedirects: {
      activeTabIds: [987654321, 987654322, 987654321, -1],
      targetsByTab: { 987654321: "1080p", 987654322: "720p", bad: "2160p" },
      lastError: null,
      updatedAt: timestamp,
    },
  };
}

describe("review: diagnostics persist aggregates without browser tab IDs", () => {
  it("migrates legacy IDs to bounded counts and sorted quality values", () => {
    const normalized = normalizeDiagnostics(legacyDiagnostics());
    assertNoTabIdentifiers(normalized);
    assert.equal(normalized.samples.length, 1);
    assert.equal(normalized.runtimeRedirects.activeTabCount, 2);
    assert.deepEqual(normalized.runtimeRedirects.targetQualities, ["1080p", "720p"]);
    assert.doesNotMatch(JSON.stringify(normalized), /98765432[12]/);
    assert.deepEqual(normalizeDiagnostics(normalized), normalized);
    assert.deepEqual(createDiagnosticsSnapshot(normalized), normalized);
  });

  it("records new samples, decisions and targets without retaining request tab IDs", () => {
    const diagnostics = createEmptyDiagnostics();
    const url = "https://nvelop-livecloud.pstatic.net/chzzk/test/chunklist_720p.m3u8";
    recordDiagnosticUrl(diagnostics, url, { context: { tabId: 987654321, type: "media" } });
    recordDecision(
      diagnostics,
      { ok: true, reason: "eligible-chzzk-hls-quality", tabId: 987654321 },
      { url },
    );
    updateRuntimeRedirectDiagnostics(diagnostics, {
      activeTabIds: [987654321],
      targetsByTab: { 987654321: "1080p" },
    });
    assertNoTabIdentifiers(diagnostics);
    assert.equal(diagnostics.samples.length, 1);
    assert.equal(diagnostics.decisions.length, 1);
    assert.equal(diagnostics.runtimeRedirects.activeTabCount, 1);
    assert.deepEqual(diagnostics.runtimeRedirects.targetQualities, ["1080p"]);
  });

  it("bounds the new aggregate schema and preserves multiple tabs at the same quality", () => {
    const value = normalizeDiagnostics({
      maxSamples: 2,
      runtimeRedirects: {
        activeTabCount: Number.MAX_SAFE_INTEGER,
        targetQualities: ["1080p", "1080p", "720p", "bad"],
      },
    });
    assert.equal(value.runtimeRedirects.activeTabCount, 2);
    assert.deepEqual(value.runtimeRedirects.targetQualities, ["1080p", "1080p"]);
    assertNoTabIdentifiers(value);
    const invalid = normalizeDiagnostics({
      runtimeRedirects: { activeTabCount: -1, targetQualities: { bad: "1080p" } },
    });
    assert.equal(invalid.runtimeRedirects.activeTabCount, 0);
    assert.deepEqual(invalid.runtimeRedirects.targetQualities, []);
  });

  it("scrubs legacy storage before mutation and again before saving or exporting", async () => {
    let saved = legacyDiagnostics();
    const store = createDiagnosticsStore({
      maxSamples: 200,
      storage: {
        get: async (key) => ({ [key]: structuredClone(saved) }),
        set: async (value) => {
          saved = structuredClone(value.chzzkDiagnostics);
        },
        remove: async () => {
          saved = undefined;
        },
      },
    });
    const result = await store.mutate((value) => {
      assertNoTabIdentifiers(value);
      value.totalHlsRequests += 1;
      // Even a stale producer using the old schema must not leak identifiers.
      value.decisions.push({
        ok: true,
        quality: null,
        reason: "test",
        redirectedCurrentRequest: false,
        seenAt: "2026-09-05T00:00:00.000Z",
        tabId: 987654321,
        targetQuality: null,
        type: null,
        url: "",
      });
    });
    assertNoTabIdentifiers(saved);
    assertNoTabIdentifiers(result.diagnostics);
    assert.equal(saved.totalHlsRequests, 1);
    assert.equal(saved.samples.length, 1);
    assert.equal(saved.decisions.length, 1);
    await store.clear();
    assert.equal(saved, undefined);
  });
});
