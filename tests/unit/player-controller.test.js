import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLAYER_LAYOUT_SELECTOR,
  QUALITY_PANE_SELECTOR,
  QUALITY_STORAGE_KEY,
  createHighestQualityPlayerController,
  isPlayerPageLocation,
  selectHighestAllowedPlayerTrack,
} from "../../src/runtime/player-controller.js";

function playerFixture(trackValues, { filter = () => true } = {}) {
  const listeners = new Map();
  const selectionTrueWrites = [];
  const values = [];
  const videoTracks = values;
  videoTracks.selectedIndex = -1;
  videoTracks.addEventListener = (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  videoTracks.removeEventListener = (type, listener) => {
    listeners.get(type)?.delete(listener);
  };
  videoTracks.dispatchTrackEvent = (type) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      listener({ target: videoTracks, type });
    }
  };
  videoTracks.listenerCount = (type) => listeners.get(type)?.size ?? 0;

  function addTrack(value, { emit = true } = {}) {
    const index = values.length;
    const track = { ...value };
    let selected = value.selected === true;
    selectionTrueWrites[index] = 0;
    Object.defineProperty(track, "selected", {
      configurable: true,
      enumerable: true,
      get: () => selected,
      set(value) {
        selected = value === true;
        if (selected) selectionTrueWrites[index] += 1;
        if (selected) {
          videoTracks.selectedIndex = index;
          for (const [otherIndex, otherTrack] of values.entries()) {
            if (otherIndex !== index) otherTrack.selected = false;
          }
        }
      },
    });
    values.push(track);
    if (selected) videoTracks.selectedIndex = index;
    if (emit) videoTracks.dispatchTrackEvent("addtrack");
    return track;
  }
  for (const value of trackValues) addTrack(value, { emit: false });

  const player = { videoTracks };
  const pane = { filter };
  const stored = new Map();
  const storage = {
    getItem(key) {
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      stored.set(key, value);
    },
  };
  const documentRef = {
    querySelector(selector) {
      if (selector === PLAYER_LAYOUT_SELECTOR) return player;
      if (selector === QUALITY_PANE_SELECTOR) return pane;
      return null;
    },
  };
  return {
    addTrack,
    documentRef,
    pane,
    player,
    selectionTrueWrites,
    storage,
    stored,
    values,
  };
}

function controllerHarness(fixture, { pathname = "/live/test" } = {}) {
  const documentListeners = new Map();
  const locationRef = { pathname };
  const timers = new Map();
  const windowListeners = new Map();
  let nextTimerId = 0;

  function addListener(target, type, listener) {
    if (!target.has(type)) target.set(type, new Set());
    target.get(type).add(listener);
  }

  function removeListener(target, type, listener) {
    target.get(type)?.delete(listener);
  }

  class FakeMutationObserver {
    disconnect() {}

    observe() {}
  }

  const documentRef = {
    documentElement: {},
    addEventListener(type, listener) {
      addListener(documentListeners, type, listener);
    },
    querySelector(selector) {
      return fixture.documentRef.querySelector(selector);
    },
    removeEventListener(type, listener) {
      removeListener(documentListeners, type, listener);
    },
  };
  const windowRef = {
    addEventListener(type, listener) {
      addListener(windowListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(windowListeners, type, listener);
    },
  };
  const updatePath = (url) => {
    if (url != null) {
      locationRef.pathname = new globalThis.URL(String(url), "https://chzzk.naver.com").pathname;
    }
  };
  const historyRef = {
    pushState(_state, _title, url) {
      updatePath(url);
    },
    replaceState(_state, _title, url) {
      updatePath(url);
    },
  };
  const originalPushState = historyRef.pushState;
  const originalReplaceState = historyRef.replaceState;
  const controller = createHighestQualityPlayerController({
    MutationObserverImpl: FakeMutationObserver,
    clearTimeoutImpl(timerId) {
      timers.delete(timerId);
    },
    documentRef,
    historyRef,
    locationRef,
    setTimeoutImpl(callback) {
      const timerId = ++nextTimerId;
      timers.set(timerId, callback);
      return timerId;
    },
    storage: fixture.storage,
    windowRef,
  });

  return {
    controller,
    documentListeners,
    flushTimer() {
      const next = timers.entries().next().value;
      if (!next) return false;
      const [timerId, callback] = next;
      timers.delete(timerId);
      callback();
      return true;
    },
    historyRef,
    locationRef,
    originalPushState,
    originalReplaceState,
    windowListeners,
  };
}

describe("CHZZK player highest-quality controller", () => {
  it("accepts only live and lives paths while allowing real query strings", () => {
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/live/channel?foo=bar"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/lives?keyword=channel"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/livestream"), false);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/"), false);
  });

  it("selects and persists the highest allowed concrete track instead of ABR", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);

    assert.deepEqual(
      selectHighestAllowedPlayerTrack({
        documentRef: fixture.documentRef,
        storage: fixture.storage,
      }),
      {
        changed: true,
        height: 1080,
        label: "1080p",
        selected: true,
        width: 1920,
      },
    );
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      label: "1080p",
      width: 1920,
      height: 1080,
    });
  });

  it("honors the player quality filter and selects the highest permitted fallback", () => {
    const fixture = playerFixture(
      [
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      { filter: (track) => track.height <= 720 },
    );

    const result = selectHighestAllowedPlayerTrack({
      documentRef: fixture.documentRef,
      storage: fixture.storage,
    });

    assert.equal(result.label, "720p");
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      label: "720p",
      width: 1280,
      height: 720,
    });
  });

  it("fails closed until the official player filter is available", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    fixture.pane.filter = undefined;

    assert.deepEqual(
      selectHighestAllowedPlayerTrack({
        documentRef: fixture.documentRef,
        storage: fixture.storage,
      }),
      { reason: "quality-filter-missing", selected: false },
    );
    assert.equal(fixture.player.videoTracks.selectedIndex, -1);
    assert.equal(fixture.stored.size, 0);
  });

  it("fails closed when the player filter or track selector rejects access", () => {
    const throwingFilter = playerFixture([{ height: 1080, label: "1080p", width: 1920 }], {
      filter() {
        throw new Error("player filter unavailable");
      },
    });
    assert.deepEqual(
      selectHighestAllowedPlayerTrack({
        documentRef: throwingFilter.documentRef,
        storage: throwingFilter.storage,
      }),
      { reason: "allowed-track-missing", selected: false },
    );

    const throwingSelector = playerFixture([
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    Object.defineProperty(throwingSelector.values[1], "selected", {
      configurable: true,
      get: () => false,
      set() {
        throw new Error("selection rejected");
      },
    });
    assert.deepEqual(
      selectHighestAllowedPlayerTrack({
        documentRef: throwingSelector.documentRef,
        storage: throwingSelector.storage,
      }),
      { reason: "selection-failed", selected: false },
    );
    assert.equal(throwingSelector.stored.size, 0);
  });

  it("ignores page-owned track getters that throw", () => {
    const fixture = playerFixture([{ height: 720, label: "720p", width: 1280 }]);
    fixture.player.videoTracks.push(
      Object.defineProperty({}, "label", {
        get() {
          throw new Error("page getter rejected access");
        },
      }),
    );

    assert.equal(
      selectHighestAllowedPlayerTrack({
        documentRef: fixture.documentRef,
        storage: fixture.storage,
      }).label,
      "720p",
    );
  });

  it("does not persist a selection that the player silently ignores", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    Object.defineProperty(fixture.values[0], "selected", {
      configurable: true,
      get: () => false,
      set() {},
    });
    fixture.player.videoTracks.selectedIndex = -1;

    assert.deepEqual(
      selectHighestAllowedPlayerTrack({
        documentRef: fixture.documentRef,
        storage: fixture.storage,
      }),
      { reason: "selection-not-applied", selected: false },
    );
    assert.equal(fixture.stored.size, 0);
  });

  it("reselects the highest track after a player remount", () => {
    let fixture = playerFixture([{ height: 720, label: "720p", width: 1280 }]);
    const listeners = new Map();
    const timers = [];
    let observerCallback = null;
    class FakeMutationObserver {
      constructor(callback) {
        observerCallback = callback;
      }

      disconnect() {}

      observe() {}
    }
    const documentRef = {
      documentElement: {},
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      querySelector(selector) {
        return fixture.documentRef.querySelector(selector);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    };
    const controller = createHighestQualityPlayerController({
      MutationObserverImpl: FakeMutationObserver,
      clearTimeoutImpl() {},
      documentRef,
      locationRef: { pathname: "/live/test" },
      setTimeoutImpl(callback) {
        timers.push(callback);
        return timers.length;
      },
      storage: fixture.storage,
    });
    const flushTimer = () => timers.shift()?.();

    controller.start();
    flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    const firstStorage = fixture.storage;
    fixture = playerFixture([
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    fixture.storage = firstStorage;
    observerCallback([{ addedNodes: [{ tagName: "PZP-PC-LAYOUT" }], removedNodes: [] }]);
    flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(JSON.parse(firstStorage.getItem(QUALITY_STORAGE_KEY)).height, 1080);

    controller.stop();
    assert.equal(listeners.size, 0);
  });

  it("retries when the official quality pane mounts after the initial retry window", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    let paneReady = false;
    let observerCallback = null;
    const timers = [];
    class FakeMutationObserver {
      constructor(callback) {
        observerCallback = callback;
      }

      disconnect() {}

      observe() {}
    }
    const documentRef = {
      documentElement: {},
      addEventListener() {},
      querySelector(selector) {
        if (selector === PLAYER_LAYOUT_SELECTOR) return fixture.player;
        if (selector === QUALITY_PANE_SELECTOR) return paneReady ? fixture.pane : null;
        return null;
      },
      removeEventListener() {},
    };
    const controller = createHighestQualityPlayerController({
      MutationObserverImpl: FakeMutationObserver,
      clearTimeoutImpl() {},
      documentRef,
      locationRef: { pathname: "/live/test" },
      setTimeoutImpl(callback) {
        timers.push(callback);
        return timers.length;
      },
      storage: fixture.storage,
    });
    const flushTimer = () => timers.shift()?.();

    controller.start();
    flushTimer();
    flushTimer();
    flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, -1);

    paneReady = true;
    observerCallback([
      {
        addedNodes: [{ tagName: "PZP-PC-SETTING-QUALITY-PANE" }],
        removedNodes: [],
      },
    ]);
    flushTimer();

    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    controller.stop();
  });

  it("stays active across SPA routes while selecting only on exact player paths", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture, { pathname: "/" });

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    harness.historyRef.pushState({}, "", "/live/channel?from=home");
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    fixture.values[0].selected = true;
    harness.historyRef.pushState({}, "", "/livestream");
    harness.flushTimer();
    assert.equal(
      fixture.player.videoTracks.selectedIndex,
      0,
      "a lookalike route must not trigger player selection after an SPA transition",
    );

    harness.historyRef.replaceState({}, "", "/lives?keyword=channel");
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    harness.controller.stop();
    assert.equal(harness.historyRef.pushState, harness.originalPushState);
    assert.equal(harness.historyRef.replaceState, harness.originalReplaceState);
    assert.equal(harness.windowListeners.get("popstate")?.size ?? 0, 0);
  });

  it("promotes a delayed higher track and unbinds every track-list listener on stop", () => {
    const fixture = playerFixture([{ height: 720, label: "720p", width: 1280 }]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(fixture.player.videoTracks.listenerCount(eventType), 1);
    }

    fixture.addTrack({ height: 1080, label: "1080p", width: 1920 });
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    harness.controller.stop();
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(fixture.player.videoTracks.listenerCount(eventType), 0);
    }
  });

  it("reasserts the highest track after ABR returns without resetting an unchanged selection", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 1);

    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(
      fixture.selectionTrueWrites[1],
      1,
      "an already-selected highest track must not be assigned again",
    );

    fixture.values[0].selected = true;
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 2);

    harness.controller.stop();
  });
});
