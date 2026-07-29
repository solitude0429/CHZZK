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

function playerFixture(trackValues, { filter = () => true, onSelectionWrite = null } = {}) {
  const listeners = new Map();
  const selectionTrueWrites = [];
  const selectedStates = [];
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

  function selectTrack(index) {
    for (const [otherIndex] of values.entries()) {
      selectedStates[otherIndex] = otherIndex === index;
    }
    videoTracks.selectedIndex = index;
  }

  function addTrack(value, { emit = true } = {}) {
    const index = values.length;
    const track = { ...value };
    selectedStates[index] = value.selected === true;
    selectionTrueWrites[index] = 0;
    Object.defineProperty(track, "selected", {
      configurable: true,
      enumerable: true,
      get: () => selectedStates[index] === true,
      set(next) {
        if (next !== true) {
          selectedStates[index] = false;
          return;
        }
        selectionTrueWrites[index] += 1;
        const apply = () => selectTrack(index);
        if (typeof onSelectionWrite === "function") {
          onSelectionWrite({
            apply,
            index,
            track,
            videoTracks,
            writeCount: selectionTrueWrites[index],
          });
          return;
        }
        apply();
      },
    });
    values.push(track);
    if (selectedStates[index]) selectTrack(index);
    if (emit) videoTracks.dispatchTrackEvent("addtrack");
    return track;
  }
  for (const value of trackValues) addTrack(value, { emit: false });

  const pane = { filter };
  const root = { id: "live_player_layout" };
  const mediaNodes = new Set();
  let currentPrimaryMedia = null;
  const player = {
    querySelector(selector) {
      return selector === "video" ? currentPrimaryMedia : null;
    },
    videoTracks,
  };

  function createMedia(properties = {}) {
    const media = {
      ...properties,
      closest(selector) {
        return selector === "#live_player_layout" ? root : null;
      },
      parentPlayer: player,
      tagName: "VIDEO",
    };
    mediaNodes.add(media);
    return media;
  }

  const primaryMedia = createMedia();
  const unrelatedMedia = createMedia();
  currentPrimaryMedia = primaryMedia;
  root.contains = (node) => node === player || mediaNodes.has(node);
  root.querySelector = (selector) => (selector === "video" ? currentPrimaryMedia : null);
  let mountedPane = pane;
  let mountedPlayer = player;
  let mountedPrimaryMedia = primaryMedia;
  let mountedRoot = root;
  let storageSetCalls = 0;
  const stored = new Map();
  const storage = {
    getItem(key) {
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      storageSetCalls += 1;
      stored.set(key, value);
    },
  };
  const documentRef = {
    querySelector(selector) {
      if (selector === PLAYER_LAYOUT_SELECTOR) return mountedPlayer;
      if (selector === QUALITY_PANE_SELECTOR) return mountedPane;
      if (selector === "#live_player_layout") return mountedRoot;
      if (String(selector).includes("video")) return mountedPrimaryMedia;
      return null;
    },
  };
  return {
    addTrack,
    createMedia,
    get currentPrimaryMedia() {
      return currentPrimaryMedia;
    },
    documentRef,
    mountDocument(nextFixture) {
      mountedPane = nextFixture.pane;
      mountedPlayer = nextFixture.player;
      mountedPrimaryMedia = nextFixture.currentPrimaryMedia;
      mountedRoot = nextFixture.root;
    },
    pane,
    player,
    primaryMedia,
    root,
    selectTrack,
    selectionTrueWrites,
    setPane(nextPane) {
      mountedPane = nextPane;
    },
    setPrimaryMedia(properties = {}) {
      currentPrimaryMedia = properties === null ? null : createMedia(properties);
      if (mountedPlayer === player) mountedPrimaryMedia = currentPrimaryMedia;
      return currentPrimaryMedia;
    },
    setVideoTracks(nextTracks) {
      player.videoTracks = nextTracks;
    },
    storage,
    get storageSetCalls() {
      return storageSetCalls;
    },
    stored,
    unrelatedMedia,
    values,
  };
}

function controllerHarness(fixture, { omitStorage = false, pathname = "/live/test" } = {}) {
  let currentTime = 0;
  const documentListeners = new Map();
  const locationRef = { pathname };
  const timers = new Map();
  const visualViewportListeners = new Map();
  const windowListeners = new Map();
  let mutationObserverCallback = null;
  let nextTimerId = 0;

  function addListener(target, type, listener) {
    if (!target.has(type)) target.set(type, new Set());
    target.get(type).add(listener);
  }

  function removeListener(target, type, listener) {
    target.get(type)?.delete(listener);
  }

  class FakeMutationObserver {
    constructor(callback) {
      mutationObserverCallback = callback;
    }

    disconnect() {
      mutationObserverCallback = null;
    }

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
  const visualViewportRef = {
    addEventListener(type, listener) {
      addListener(visualViewportListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(visualViewportListeners, type, listener);
    },
  };
  windowRef.visualViewport = visualViewportRef;
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
  const controllerOptions = {
    MutationObserverImpl: FakeMutationObserver,
    clearTimeoutImpl(timerId) {
      timers.delete(timerId);
    },
    documentRef,
    historyRef,
    locationRef,
    nowImpl() {
      return currentTime;
    },
    setTimeoutImpl(callback, delay) {
      const timerId = ++nextTimerId;
      const normalizedDelay = Number(delay) || 0;
      timers.set(timerId, {
        callback,
        delay: normalizedDelay,
        dueAt: currentTime + Math.max(0, normalizedDelay),
      });
      return timerId;
    },
    visualViewportRef,
    windowRef,
  };
  if (!omitStorage) controllerOptions.storage = fixture.storage;
  const controller = createHighestQualityPlayerController(controllerOptions);

  return {
    advanceTime(milliseconds) {
      currentTime += milliseconds;
    },
    controller,
    dispatchDocument(type, target = fixture.player) {
      const player = target?.parentPlayer ?? (target === fixture.player ? fixture.player : null);
      const event = {
        composedPath: () =>
          [target, player, target?.closest?.("#live_player_layout") ?? fixture.root].filter(Boolean),
        target,
        type,
      };
      for (const listener of [...(documentListeners.get(type) ?? [])]) listener(event);
    },
    dispatchMutation(records) {
      mutationObserverCallback?.(records);
    },
    dispatchVisualViewport(type) {
      const event = { target: visualViewportRef, type };
      for (const listener of [...(visualViewportListeners.get(type) ?? [])]) listener(event);
    },
    dispatchWindow(type) {
      const event = { target: windowRef, type };
      for (const listener of [...(windowListeners.get(type) ?? [])]) listener(event);
    },
    documentListeners,
    flushTimer() {
      const next = [...timers.entries()].sort(
        ([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId,
      )[0];
      if (!next) return false;
      const [timerId, { callback, dueAt }] = next;
      timers.delete(timerId);
      currentTime = Math.max(currentTime, dueAt);
      callback();
      return true;
    },
    flushTimers(limit = 100) {
      let count = 0;
      while (count < limit && this.flushTimer()) count += 1;
      return count;
    },
    historyRef,
    locationRef,
    originalPushState,
    originalReplaceState,
    pendingTimerCount() {
      return timers.size;
    },
    pendingTimerDelay() {
      return (
        [...timers.entries()].sort(
          ([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId,
        )[0]?.[1].delay ?? null
      );
    },
    visualViewportListeners,
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

  it("keeps selecting when access to the default site storage is denied", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let harness;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        const error = new Error("site storage denied");
        error.name = "SecurityError";
        throw error;
      },
    });

    try {
      assert.equal(selectHighestAllowedPlayerTrack({ documentRef: fixture.documentRef }).label, "1080p");
      assert.equal(fixture.player.videoTracks.selectedIndex, 0);
      assert.equal(fixture.stored.size, 0);

      fixture.values[0].selected = false;
      fixture.player.videoTracks.selectedIndex = -1;
      harness = controllerHarness(fixture, { omitStorage: true });
      harness.controller.start();
      assert.equal(harness.flushTimer(), true);
      assert.equal(fixture.player.videoTracks.selectedIndex, 0);
      assert.equal(fixture.stored.size, 0);
    } finally {
      harness?.controller.stop();
      if (originalStorageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", originalStorageDescriptor);
      } else {
        delete globalThis.localStorage;
      }
    }
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
    flushTimer();

    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    controller.stop();
  });

  it("keeps a bounded slower retry when an existing pane initializes its filter late", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    fixture.pane.filter = undefined;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, -1);
    assert.equal(harness.pendingTimerDelay(), 1000);

    fixture.pane.filter = () => true;
    assert.equal(harness.flushTimer(), true, "a slower bounded retry must remain scheduled");
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    harness.controller.stop();
  });

  it("replaces a pending slow retry when fresh player evidence arrives", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    fixture.pane.filter = undefined;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    for (const expectedNextDelay of [50, 250, 1000, 3000]) {
      assert.equal(harness.flushTimer(), true);
      assert.equal(harness.pendingTimerDelay(), expectedNextDelay);
    }
    assert.equal(fixture.player.videoTracks.selectedIndex, -1);

    fixture.pane.filter = () => true;
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.pendingTimerDelay(), 0);
    assert.equal(harness.pendingTimerCount(), 1);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.pendingTimerDelay(), 0);
    assert.equal(harness.pendingTimerCount(), 1);

    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.controller.stop();
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(fixture.player.videoTracks.listenerCount(eventType), 0);
    }
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
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    fixture.values[0].selected = true;
    harness.historyRef.pushState({}, "", "/livestream");
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(
      fixture.player.videoTracks.selectedIndex,
      0,
      "a lookalike route must not trigger player selection after an SPA transition",
    );

    harness.historyRef.replaceState({}, "", "/lives?keyword=channel");
    harness.flushTimer();
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

  it("confirms one asynchronously applied highest-track write without setter churn", () => {
    let pendingApply = null;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        onSelectionWrite({ apply, videoTracks }) {
          pendingApply = apply;
          videoTracks.dispatchTrackEvent("change");
          videoTracks.dispatchTrackEvent("change");
        },
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    assert.equal(
      harness.flushTimer(),
      true,
      "synchronous change events should coalesce into a read-only scan",
    );
    assert.equal(fixture.selectionTrueWrites[1], 1);
    pendingApply();
    assert.equal(
      harness.flushTimer(),
      true,
      "the bounded confirmation should observe the asynchronous apply",
    );

    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("caps an ignored event-storm selection at two writes and then becomes quiescent", () => {
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        onSelectionWrite({ videoTracks }) {
          for (let index = 0; index < 5; index += 1) {
            videoTracks.dispatchTrackEvent("change");
          }
        },
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    assert.ok(harness.flushTimers(30) < 30, "the bounded confirmation cycle must terminate");
    assert.equal(fixture.selectionTrueWrites[1], 2);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(fixture.stored.size, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    for (let index = 0; index < 50; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    assert.equal(harness.pendingTimerCount(), 1, "the external event storm should coalesce into one scan");
    assert.equal(harness.flushTimers(10), 1);
    assert.equal(fixture.selectionTrueWrites[1], 2);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("coalesces responsive events and rebinds a same-node replacement VideoTrackList", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const replacement = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture, { pathname: "/lives" });

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);
    const previousTracks = fixture.player.videoTracks;
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(previousTracks.listenerCount(eventType), 1);
    }

    fixture.player.videoTracks = replacement.player.videoTracks;
    for (let index = 0; index < 20; index += 1) {
      harness.dispatchWindow("resize");
      harness.dispatchWindow("orientationchange");
      harness.dispatchVisualViewport("resize");
    }
    assert.equal(harness.pendingTimerCount(), 1);
    assert.equal(harness.pendingTimerDelay(), 250);

    harness.flushTimer();
    assert.equal(replacement.selectionTrueWrites[2], 0, "the responsive timer should only enqueue a scan");
    harness.flushTimer();
    assert.equal(replacement.selectionTrueWrites[2], 1);
    assert.equal(replacement.player.videoTracks.selectedIndex, 2);
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(previousTracks.listenerCount(eventType), 0);
      assert.equal(replacement.player.videoTracks.listenerCount(eventType), 1);
    }
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("bounds rapid ABR corrections and replenishes one write after five stable seconds", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 2);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    fixture.selectTrack(0);
    for (let index = 0; index < 20; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    harness.flushTimers();
    assert.equal(fixture.selectionTrueWrites[1], 2);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    fixture.selectTrack(1);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    harness.advanceTime(5000);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 3);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("holds a repeated correction while media is unsettled and resumes after playback settles", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);

    fixture.selectTrack(0);
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.dispatchDocument("stalled", fixture.primaryMedia);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.equal(harness.pendingTimerCount(), 1);
    assert.equal(harness.pendingTimerDelay(), 250);
    harness.flushTimer();
    assert.equal(
      fixture.selectionTrueWrites[1],
      1,
      "media settle should enqueue rather than perform a write",
    );
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 2);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("keeps the primary-media hold across a same-player VideoTrackList replacement", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const replacement = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture, { pathname: "/lives" });

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.player.videoTracks = replacement.player.videoTracks;
    harness.dispatchWindow("resize");

    harness.flushTimer();
    harness.flushTimer();
    assert.equal(
      replacement.selectionTrueWrites[1],
      0,
      "responsive discovery must not spend a first write while the primary media is waiting",
    );
    assert.equal(replacement.player.videoTracks.selectedIndex, 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(replacement.selectionTrueWrites[1], 1);
    assert.equal(replacement.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("settles migrated tracks when playback evidence beats the responsive rebind", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const replacement = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.setVideoTracks(replacement.player.videoTracks);
    harness.dispatchWindow("resize");
    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);

    assert.equal(replacement.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerDelay(), 250);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(replacement.selectionTrueWrites[1], 1);
    assert.equal(replacement.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("keeps a scheduled media settle valid while same-player tracks migrate", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const replacement = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);

    fixture.setVideoTracks(replacement.player.videoTracks);
    harness.dispatchWindow("resize");
    assert.equal(replacement.selectionTrueWrites[1], 0);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(replacement.selectionTrueWrites[1], 1);
    assert.equal(replacement.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("does not release a hold when the primary video disappears during settle", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);
    fixture.setPrimaryMedia(null);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(fixture.storageSetCalls, 0);
    assert.equal(harness.pendingTimerDelay(), 1000);
    harness.flushTimer();
    assert.equal(harness.pendingTimerCount(), 0);

    const replacementPrimaryMedia = fixture.setPrimaryMedia();
    harness.dispatchDocument("playing", replacementPrimaryMedia);
    harness.dispatchDocument("canplay", replacementPrimaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("preserves waiting and stalled holds while the eligible-route player is temporarily absent", () => {
    for (const eventType of ["waiting", "stalled"]) {
      const fixture = playerFixture([
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ]);
      const replacement = playerFixture([
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ]);
      const harness = controllerHarness(fixture);

      harness.controller.start();
      harness.dispatchDocument(eventType, fixture.primaryMedia);
      harness.flushTimer();
      assert.equal(fixture.selectionTrueWrites[1], 0);

      fixture.mountDocument({
        currentPrimaryMedia: null,
        pane: null,
        player: null,
        root: null,
      });
      harness.dispatchWindow("resize");
      harness.flushTimer();
      harness.flushTimer();
      assert.equal(fixture.selectionTrueWrites[1], 0);

      fixture.mountDocument(replacement);
      harness.dispatchWindow("resize");
      assert.ok(harness.flushTimers(30) < 30);
      assert.equal(
        replacement.selectionTrueWrites[1],
        0,
        `${eventType} must remain held after a player-less responsive gap`,
      );
      assert.equal(replacement.player.videoTracks.selectedIndex, 0);

      harness.dispatchDocument("playing", replacement.primaryMedia);
      harness.dispatchDocument("canplay", replacement.primaryMedia);
      assert.ok(harness.flushTimers(20) < 20);
      assert.equal(replacement.selectionTrueWrites[1], 1);
      assert.equal(replacement.player.videoTracks.selectedIndex, 1);
      assert.equal(harness.pendingTimerCount(), 0);
      harness.controller.stop();
    }
  });

  it("migrates a settling hold when the primary changes without another media event", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.flushTimer();
    harness.dispatchDocument("playing", fixture.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);

    fixture.setPrimaryMedia({ paused: false, readyState: 4 });
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerDelay(), 1000);

    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0, "the readiness check should only enqueue a scan");
    assert.equal(harness.pendingTimerDelay(), 0);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("bounds the readiness recheck across repeated primary replacement", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.flushTimer();
    harness.dispatchDocument("playing", fixture.primaryMedia);
    fixture.setPrimaryMedia({ paused: false, readyState: 0 });
    harness.flushTimer();
    assert.equal(harness.pendingTimerDelay(), 1000);

    fixture.setPrimaryMedia({ paused: false, readyState: 0 });
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerCount(), 0);

    fixture.setPrimaryMedia({ paused: false, readyState: 4 });
    harness.dispatchWindow("resize");
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerCount(), 0, "replacement churn must not create a timer chain");

    const currentPrimaryMedia = fixture.currentPrimaryMedia;
    harness.dispatchDocument("playing", currentPrimaryMedia);
    harness.dispatchDocument("canplay", currentPrimaryMedia);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("does not reset the readiness budget on replacement stalled events", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("stalled", fixture.primaryMedia);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerDelay(), 1000);

    const secondPrimary = fixture.setPrimaryMedia({ paused: false, readyState: 0 });
    harness.dispatchDocument("stalled", secondPrimary);
    assert.equal(harness.pendingTimerCount(), 1);
    assert.equal(harness.pendingTimerDelay(), 1000);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerCount(), 0);

    const thirdPrimary = fixture.setPrimaryMedia({ paused: false, readyState: 4 });
    harness.dispatchDocument("stalled", thirdPrimary);
    assert.equal(
      harness.pendingTimerCount(),
      0,
      "a replacement stalled event must not recreate the consumed readiness budget",
    );
    harness.dispatchDocument("playing", thirdPrimary);
    harness.dispatchDocument("canplay", thirdPrimary);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("uses the single readiness check when it discovers a ready replacement primary", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("stalled", fixture.primaryMedia);
    harness.flushTimer();
    assert.equal(harness.pendingTimerDelay(), 1000);

    fixture.setPrimaryMedia({ paused: false, readyState: 4 });
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0, "the readiness check should only enqueue a scan");
    assert.equal(harness.pendingTimerDelay(), 0);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("migrates a media hold to a replaced primary video and ignores unrelated video evidence", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);
    const oldPrimaryMedia = fixture.primaryMedia;

    harness.controller.start();
    harness.dispatchDocument("waiting", oldPrimaryMedia);
    const replacementPrimaryMedia = fixture.setPrimaryMedia();

    const pendingBeforeUnrelated = harness.pendingTimerCount();
    harness.dispatchDocument("playing", fixture.unrelatedMedia);
    harness.dispatchDocument("canplay", fixture.unrelatedMedia);
    assert.equal(harness.pendingTimerCount(), pendingBeforeUnrelated);

    harness.dispatchDocument("playing", replacementPrimaryMedia);
    harness.dispatchDocument("canplay", replacementPrimaryMedia);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerDelay(), 250);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("retains a primary-media hold captured before VideoTrackList attachment", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const tracks = fixture.player.videoTracks;
    fixture.setVideoTracks(null);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.setVideoTracks(tracks);
    harness.dispatchWindow("resize");
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("rechecks a stalled but playback-ready primary media once before correcting", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    fixture.primaryMedia.paused = false;
    fixture.primaryMedia.readyState = 4;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("stalled", fixture.primaryMedia);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerDelay(), 1000);

    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0, "the stalled recheck should enqueue the correction");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("never releases a waiting hold solely because time elapsed", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    fixture.primaryMedia.paused = false;
    fixture.primaryMedia.readyState = 4;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.advanceTime(10_000);
    harness.dispatchWindow("resize");
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("retains waiting history when a settle is interrupted by stalled", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    fixture.primaryMedia.paused = false;
    fixture.primaryMedia.readyState = 4;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);
    harness.dispatchDocument("stalled", fixture.primaryMedia);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(
      fixture.selectionTrueWrites[1],
      0,
      "a ready-state timeout must not release an interrupted waiting recovery",
    );
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("binds a media hold to the remounted primary media and ignores stale or nested media events", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const replacement = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture, { pathname: "/lives" });
    const oldPrimaryMedia = fixture.primaryMedia;

    harness.controller.start();
    harness.dispatchDocument("waiting", oldPrimaryMedia);
    fixture.mountDocument(replacement);
    harness.dispatchDocument("waiting", replacement.primaryMedia);
    harness.dispatchWindow("resize");
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(replacement.selectionTrueWrites[1], 0);

    harness.dispatchDocument("playing", oldPrimaryMedia);
    harness.dispatchDocument("canplay", oldPrimaryMedia);
    assert.equal(harness.pendingTimerCount(), 0, "the detached media must not release the remounted hold");

    harness.dispatchDocument("playing", replacement.unrelatedMedia);
    harness.dispatchDocument("canplay", replacement.unrelatedMedia);
    assert.equal(
      harness.pendingTimerCount(),
      0,
      "an unrelated video nested under the player root must not release the primary-media hold",
    );

    harness.dispatchDocument("playing", replacement.primaryMedia);
    harness.dispatchDocument("canplay", replacement.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(replacement.selectionTrueWrites[1], 1);
    assert.equal(replacement.player.videoTracks.selectedIndex, 1);
    harness.controller.stop();
  });

  it("preserves a filter-rejected selected 1080p without downgrade or storage commit", () => {
    const fixture = playerFixture(
      [
        { allowed: false, height: 1080, label: "1080p", selected: true, width: 1920 },
        { allowed: true, height: 720, label: "720p", width: 1280 },
      ],
      { filter: (track) => track.allowed === true },
    );

    selectHighestAllowedPlayerTrack({
      documentRef: fixture.documentRef,
      storage: fixture.storage,
    });

    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.deepEqual(fixture.selectionTrueWrites, [0, 0]);
    assert.equal(fixture.storageSetCalls, 0);
    assert.equal(fixture.stored.size, 0);
  });

  it("keeps the current track among equal allowed 1080p candidates", () => {
    const fixture = playerFixture([
      { height: 1080, label: "1080p", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
      { height: 720, label: "720p", width: 1280 },
    ]);

    selectHighestAllowedPlayerTrack({
      documentRef: fixture.documentRef,
      storage: fixture.storage,
    });

    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.deepEqual(fixture.selectionTrueWrites, [0, 0, 0]);
  });

  it("selects the highest allowed fallback after ABR replaces a rejected 1080p", () => {
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { allowed: false, height: 1080, label: "1080p", width: 1920 },
        { allowed: true, height: 720, label: "720p", width: 1280 },
      ],
      { filter: (track) => track.allowed === true },
    );

    selectHighestAllowedPlayerTrack({
      documentRef: fixture.documentRef,
      storage: fixture.storage,
    });

    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      height: 720,
      label: "720p",
      width: 1280,
    });
  });

  it("refills only one correction token during repeated benign stable changes", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 2);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 2);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    fixture.selectTrack(1);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    for (let second = 1; second <= 6; second += 1) {
      harness.advanceTime(1000);
      fixture.player.videoTracks.dispatchTrackEvent("change");
      harness.flushTimer();
    }
    assert.equal(fixture.selectionTrueWrites[1], 2);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 3);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 3);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("opens a fresh bounded attempt only when the pane and filter identity change", () => {
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      { onSelectionWrite() {} },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    assert.ok(harness.flushTimers(30) < 30);
    assert.equal(fixture.selectionTrueWrites[1], 2);

    for (let index = 0; index < 30; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    harness.flushTimers();
    assert.equal(fixture.selectionTrueWrites[1], 2);

    fixture.setPane({ filter: () => true });
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.ok(harness.flushTimers(30) < 30);
    assert.equal(
      fixture.selectionTrueWrites[1],
      4,
      "a new pane/filter identity should receive its own bounded two-write attempt",
    );

    for (let index = 0; index < 30; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    harness.flushTimers();
    assert.equal(fixture.selectionTrueWrites[1], 4);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("invalidates an in-setter remount before storage commit and selects the new generation once", () => {
    const replacement = playerFixture([
      { height: 1440, label: "ABR", selected: true, width: 2560 },
      { height: 1440, label: "1440p", width: 2560 },
    ]);
    let fixture;
    let harness;
    fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        onSelectionWrite() {
          fixture.mountDocument(replacement);
          harness.dispatchWindow("resize");
        },
      },
    );
    harness = controllerHarness(fixture);

    harness.controller.start();
    assert.ok(harness.flushTimers(30) < 30);

    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(replacement.selectionTrueWrites[1], 1);
    assert.equal(fixture.storageSetCalls, 1, "only the selected remounted generation may commit storage");
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      height: 1440,
      label: "1440p",
      width: 2560,
    });
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("fails a direct selection whose setter synchronously remounts the player before persistence", () => {
    const replacement = playerFixture([
      { height: 1440, label: "ABR", selected: true, width: 2560 },
      { height: 1440, label: "1440p", width: 2560 },
    ]);
    let fixture;
    fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        onSelectionWrite({ apply }) {
          apply();
          fixture.mountDocument(replacement);
        },
      },
    );

    const outcome = selectHighestAllowedPlayerTrack({
      documentRef: fixture.documentRef,
      storage: fixture.storage,
    });

    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(replacement.player.videoTracks.selectedIndex, 0);
    assert.equal(outcome.selected, false);
    assert.equal(typeof outcome.reason, "string");
    assert.equal(fixture.storageSetCalls, 0);
    assert.equal(fixture.stored.size, 0);
  });

  it("excludes ineligible-route time from the global refill baseline", () => {
    let fixture;
    let harness;
    let stormMode = false;
    let stormWrites = 0;

    function createGeneration() {
      return playerFixture(
        [
          { height: 1080, label: "ABR", selected: true, width: 1920 },
          { height: 1080, label: "1080p", width: 1920 },
        ],
        {
          onSelectionWrite({ apply }) {
            if (!stormMode) {
              apply();
              return;
            }
            stormWrites += 1;
            const replacement = createGeneration();
            fixture.mountDocument(replacement);
            harness.dispatchWindow("resize");
          },
        },
      );
    }

    fixture = createGeneration();
    harness = controllerHarness(fixture);
    harness.controller.start();
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    harness.historyRef.pushState({}, "", "/search");
    assert.ok(harness.flushTimers(20) < 20);
    fixture.selectTrack(0);
    harness.advanceTime(20_000);

    harness.historyRef.pushState({}, "", "/live/return");
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    harness.advanceTime(5000);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.ok(harness.flushTimers(20) < 20);

    stormMode = true;
    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.ok(harness.flushTimers(100) < 100);
    assert.equal(
      stormWrites,
      4,
      "only the post-confirmation five-second interval may replenish one global write",
    );
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("bounds one failed remount-storm recovery and later recovers on fresh healthy media evidence", () => {
    const generations = [];
    let fixture;
    let harness;

    function createIgnoredGeneration() {
      const generation = playerFixture(
        [
          { height: 1080, label: "ABR", selected: true, width: 1920 },
          { height: 1080, label: "1080p", width: 1920 },
        ],
        {
          onSelectionWrite() {
            const replacement = createIgnoredGeneration();
            generations.push(replacement);
            fixture.mountDocument(replacement);
            harness.dispatchWindow("resize");
            harness.dispatchMutation([
              {
                addedNodes: [replacement.root],
                removedNodes: [generation.root],
              },
            ]);
          },
        },
      );
      return generation;
    }

    fixture = createIgnoredGeneration();
    generations.push(fixture);
    harness = controllerHarness(fixture);
    const stormWrites = () =>
      generations.reduce((sum, generation) => sum + generation.selectionTrueWrites[1], 0);

    harness.controller.start();
    let initialFlushes = 0;
    while (
      initialFlushes < 100 &&
      (stormWrites() < 4 || harness.pendingTimerDelay() !== 5000) &&
      harness.flushTimer()
    ) {
      initialFlushes += 1;
    }
    assert.ok(initialFlushes < 100);
    assert.equal(stormWrites(), 4);
    assert.equal(harness.pendingTimerDelay(), 5000);

    harness.flushTimer();
    const recoveryFlushLimit = 100;
    assert.ok(harness.flushTimers(recoveryFlushLimit) < recoveryFlushLimit);
    assert.equal(stormWrites(), 5, "the fuse may spend only one delayed recovery write");
    assert.equal(generations.length, stormWrites() + 1);
    assert.equal(new Set(generations.map((generation) => generation.player)).size, generations.length);
    assert.equal(
      new Set(generations.map((generation) => generation.player.videoTracks)).size,
      generations.length,
    );
    assert.equal(new Set(generations.map((generation) => generation.pane)).size, generations.length);
    assert.equal(new Set(generations.map((generation) => generation.pane.filter)).size, generations.length);
    assert.equal(fixture.storageSetCalls, 0);
    assert.equal(fixture.stored.size, 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.advanceTime(20_000);
    assert.equal(harness.flushTimers(20), 0, "a failed recovery must not become a periodic retry");
    assert.equal(stormWrites(), 5);

    const healthy = playerFixture([
      { height: 1440, label: "ABR", selected: true, width: 2560 },
      { height: 1440, label: "1440p", width: 2560 },
    ]);
    const previousRoot = generations.at(-1).root;
    fixture.mountDocument(healthy);
    harness.dispatchDocument("waiting", healthy.primaryMedia);
    harness.dispatchWindow("resize");
    harness.dispatchMutation([
      {
        addedNodes: [healthy.root],
        removedNodes: [previousRoot],
      },
    ]);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(healthy.selectionTrueWrites[1], 0);
    assert.equal(harness.pendingTimerCount(), 0);

    harness.dispatchDocument("playing", healthy.primaryMedia);
    harness.dispatchDocument("canplay", healthy.primaryMedia);
    assert.equal(harness.pendingTimerDelay(), 250);
    assert.ok(harness.flushTimers(50) < 50);
    assert.equal(healthy.selectionTrueWrites[1], 1);
    assert.equal(healthy.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.storageSetCalls, 1);
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      height: 1440,
      label: "1440p",
      width: 2560,
    });
    assert.equal(stormWrites(), 5);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("removes responsive, viewport, media, track, and timer state on stop", () => {
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      { onSelectionWrite() {} },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    for (const eventType of [
      "loadedmetadata",
      "change",
      "waiting",
      "stalled",
      "playing",
      "canplay",
      "timeupdate",
    ]) {
      assert.equal(harness.documentListeners.get(eventType)?.size ?? 0, 1);
    }
    for (const eventType of ["popstate", "resize", "orientationchange"]) {
      assert.equal(harness.windowListeners.get(eventType)?.size ?? 0, 1);
    }
    assert.equal(harness.visualViewportListeners.get("resize")?.size ?? 0, 1);
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(fixture.player.videoTracks.listenerCount(eventType), 1);
    }

    harness.dispatchWindow("resize");
    harness.dispatchWindow("orientationchange");
    harness.dispatchVisualViewport("resize");
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.dispatchDocument("playing", fixture.primaryMedia);
    assert.ok(harness.pendingTimerCount() > 0);
    const writesBeforeStop = fixture.selectionTrueWrites[1];

    harness.controller.stop();
    for (const eventType of [
      "loadedmetadata",
      "change",
      "waiting",
      "stalled",
      "playing",
      "canplay",
      "timeupdate",
    ]) {
      assert.equal(harness.documentListeners.get(eventType)?.size ?? 0, 0);
    }
    for (const eventType of ["popstate", "resize", "orientationchange"]) {
      assert.equal(harness.windowListeners.get(eventType)?.size ?? 0, 0);
    }
    assert.equal(harness.visualViewportListeners.get("resize")?.size ?? 0, 0);
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(fixture.player.videoTracks.listenerCount(eventType), 0);
    }
    assert.equal(harness.pendingTimerCount(), 0);
    assert.equal(harness.flushTimers(), 0);
    assert.equal(fixture.selectionTrueWrites[1], writesBeforeStop);
  });
});
