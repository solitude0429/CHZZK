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
    querySelectorAll() {
      return [];
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

function reactFiberPlayerFixture(trackValues, options) {
  const fixture = playerFixture(trackValues, options);
  const baseDocumentRef = fixture.documentRef;
  const video = fixture.primaryMedia;
  const fiberProperty = "__reactFiber$chzzkTest";
  let descendants = [video];
  const layout = {
    id: "live_player_layout",
    parentElement: null,
    querySelector(selector) {
      return String(selector).includes("video") ? video : null;
    },
    querySelectorAll(selector) {
      if (selector === "*") return descendants;
      return [];
    },
    tagName: "DIV",
  };
  video.parentElement = layout;

  function installFiberPlayer(player) {
    const wrapper = { _internalPlayer: player };
    const effect = { deps: [wrapper] };
    const ancestorFiber = {
      memoizedState: {
        memoizedState: effect,
      },
      updateQueue: {
        lastEffect: effect,
      },
    };
    const fiber = { return: ancestorFiber };
    layout[fiberProperty] = fiber;
    video.parentElement = layout;
    descendants = [video];
    return { ancestorFiber, effect, fiber, wrapper };
  }

  function installAncestorPlayer(player) {
    delete layout[fiberProperty];
    const ancestor = {
      parentElement: layout,
      querySelector(selector) {
        return String(selector).includes("video") ? video : null;
      },
      tagName: "DIV",
      videoTracks: player.videoTracks,
    };
    video.parentElement = ancestor;
    descendants = [ancestor, video];
    return ancestor;
  }

  function installAncestorFiberPlayer(player) {
    delete layout[fiberProperty];
    const ancestor = {
      parentElement: layout,
      querySelector(selector) {
        return String(selector).includes("video") ? video : null;
      },
      tagName: "DIV",
    };
    const wrapper = { _internalPlayer: player };
    const effect = { deps: [wrapper] };
    effect.next = effect;
    const ancestorFiber = {
      return: null,
      updateQueue: { lastEffect: effect },
    };
    const fiber = { return: ancestorFiber };
    Object.defineProperty(ancestor, fiberProperty, {
      configurable: true,
      value: fiber,
    });
    video.parentElement = ancestor;
    descendants = [ancestor, video];
    return { ancestor, ancestorFiber, effect, fiber, wrapper };
  }

  const initialFiber = installFiberPlayer(fixture.player);
  layout.contains = (node) =>
    node === layout || node === video || descendants.includes(node) || node === fixture.player;
  fixture.documentRef = {
    querySelector(selector) {
      if (selector === PLAYER_LAYOUT_SELECTOR) return null;
      if (selector === QUALITY_PANE_SELECTOR) return baseDocumentRef.querySelector(selector);
      if (selector === "#live_player_layout") return layout;
      if (String(selector).includes("video")) return video;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "#live_player_layout video, video.webplayer-internal-video") return [video];
      return [];
    },
  };
  fixture.fiberProperty = fiberProperty;
  fixture.initialFiber = initialFiber;
  fixture.installAncestorFiberPlayer = installAncestorFiberPlayer;
  fixture.installAncestorPlayer = installAncestorPlayer;
  fixture.installFiberPlayer = installFiberPlayer;
  fixture.layout = layout;
  fixture.root = layout;
  fixture.video = video;
  return fixture;
}

function controllerHarness(
  fixture,
  { omitStorage = false, pathname = "/live/test", watchdogIntervalMs = 0 } = {},
) {
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
    querySelectorAll(selector) {
      return fixture.documentRef.querySelectorAll?.(selector) ?? [];
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
    watchdogIntervalMs,
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
    now() {
      return currentTime;
    },
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
  it("keeps the player controller eligible on every CHZZK same-site path", () => {
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/live/channel?foo=bar"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/lives?keyword=channel"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/following"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/search?keyword=channel"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/category/GAME"), true);
    assert.equal(isPlayerPageLocation("https://chzzk.naver.com/livestream"), true);
    assert.equal(
      isPlayerPageLocation({
        get pathname() {
          throw new Error("unreadable location");
        },
        toString() {
          throw new Error("unreadable location");
        },
      }),
      false,
    );
  });

  it("protects a 1080p storage baseline immediately while preserving a higher stored intent", () => {
    const cases = [
      { initial: null, expectedHeight: 1080, name: "missing" },
      {
        initial: { height: 720, label: "720p", width: 1280 },
        expectedHeight: 1080,
        name: "720p",
      },
      {
        initial: { height: 1440, label: "1440p", width: 2560 },
        expectedHeight: 1440,
        name: "1440p",
      },
    ];

    for (const { expectedHeight, initial, name } of cases) {
      const fixture = playerFixture([]);
      if (initial) fixture.stored.set(QUALITY_STORAGE_KEY, JSON.stringify(initial));
      const harness = controllerHarness(fixture);

      harness.controller.start();
      assert.equal(
        JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height,
        expectedHeight,
        `${name} storage must be protected synchronously at controller start`,
      );
      harness.controller.stop();
    }
  });

  it("restores the 1080p storage baseline within one watchdog tick when no player API exists", () => {
    const fixture = playerFixture([]);
    fixture.documentRef = {
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.now(), 300);

    fixture.storage.setItem(QUALITY_STORAGE_KEY, JSON.stringify({ height: 720, label: "720p", width: 1280 }));
    harness.advanceTime(699);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 720);
    harness.advanceTime(1);
    assert.equal(harness.flushTimer(), true);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
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

  it("selects the highest concrete track on a cold compact load even when the pane filter vetoes it", () => {
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

    assert.equal(result.label, "1080p");
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      label: "1080p",
      width: 1920,
      height: 1080,
    });
  });

  it("selects the highest concrete track when the quality filter is missing", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    fixture.pane.filter = undefined;

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
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
  });

  it("wraps compact quality filters, rewraps replacements, and restores the current filter on stop", () => {
    let currentPane;
    let fixture;
    const originalFilter = (track) => track.height <= 720;
    fixture = playerFixture(
      [
        { height: 720, label: "720p", selected: true, width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: originalFilter,
        onSelectionWrite({ apply, track }) {
          if (currentPane.filter(track)) apply();
        },
      },
    );
    currentPane = fixture.pane;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    assert.equal(fixture.pane.filter, originalFilter);
    assert.equal(harness.flushTimer(), true);
    const firstWrapper = fixture.pane.filter;
    assert.notEqual(firstWrapper, originalFilter);
    assert.equal(firstWrapper[Symbol.for("chzzk.highest-quality-filter-wrapper")], true);
    assert.equal(originalFilter(fixture.values[1]), false);
    assert.equal(firstWrapper(fixture.values[1]), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    const replacementFilter = (track) => track.height <= 480;
    fixture.pane.filter = replacementFilter;
    const replacementDescriptor = Object.getOwnPropertyDescriptor(fixture.pane, "filter");
    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.flushTimer(), true);
    const replacementWrapper = fixture.pane.filter;
    assert.notEqual(replacementWrapper, replacementFilter);
    assert.notEqual(replacementWrapper, firstWrapper);
    assert.equal(replacementWrapper(fixture.values[1]), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    harness.controller.stop();
    assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.pane, "filter"), replacementDescriptor);
  });

  it("removes an own filter wrapper on stop when the original filter was inherited", () => {
    const inheritedFilter = (track) => track.height <= 720;
    const panePrototype = { filter: inheritedFilter };
    const pane = Object.create(panePrototype);
    const fixture = playerFixture([
      { height: 720, label: "720p", selected: true, width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    fixture.setPane(pane);
    const harness = controllerHarness(fixture);

    assert.equal(Object.hasOwn(pane, "filter"), false);
    harness.controller.start();
    harness.flushTimer();
    assert.equal(Object.hasOwn(pane, "filter"), true);
    assert.notEqual(pane.filter, inheritedFilter);

    harness.controller.stop();
    assert.equal(Object.hasOwn(pane, "filter"), false);
    assert.equal(pane.filter, inheritedFilter);
  });

  it("ignores throwing filters but still fails safely when the track setter rejects access", () => {
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
      {
        changed: true,
        height: 1080,
        label: "1080p",
        selected: true,
        width: 1920,
      },
    );
    assert.equal(throwingFilter.player.videoTracks.selectedIndex, 0);
    assert.equal(JSON.parse(throwingFilter.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

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
    for (let index = 0; index < 10 && fixture.player.videoTracks.selectedIndex !== 1; index += 1) {
      flushTimer();
    }
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(JSON.parse(firstStorage.getItem(QUALITY_STORAGE_KEY)).height, 1080);

    controller.stop();
    assert.equal(listeners.size, 0);
  });

  it("recovers the highest descriptor after a remount replaces every track object", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const replacement = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      { filter: (track) => track.height <= 720 },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.notEqual(fixture.values[2], replacement.values[2]);

    fixture.mountDocument(replacement);
    harness.dispatchMutation([
      {
        addedNodes: [replacement.root],
        removedNodes: [fixture.root],
      },
    ]);
    assert.ok(harness.flushTimers(20) < 20);

    assert.equal(replacement.player.videoTracks.selectedIndex, 2);
    assert.equal(replacement.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    harness.controller.stop();
  });

  it("finds the internal player through the real layout React fiber and recovers a remounted fiber", () => {
    const fixture = reactFiberPlayerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const replacement = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    assert.equal(fixture.documentRef.querySelector(PLAYER_LAYOUT_SELECTOR), null);
    assert.deepEqual(fixture.documentRef.querySelectorAll("pzp-pc-layout"), []);
    assert.equal(fixture.layout.tagName, "DIV");
    assert.equal(
      fixture.layout[fixture.fiberProperty].return.updateQueue.lastEffect.deps[0]._internalPlayer,
      fixture.player,
    );

    harness.controller.start();
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);

    const oldFiber = fixture.layout[fixture.fiberProperty];
    const remounted = fixture.installFiberPlayer(replacement.player);
    assert.notEqual(remounted.fiber, oldFiber);
    harness.dispatchMutation([
      {
        addedNodes: [fixture.layout],
        removedNodes: [],
      },
    ]);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(replacement.player.videoTracks.selectedIndex, 2);
    assert.equal(replacement.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    harness.controller.stop();
  });

  it("prioritizes the live layout React player over an earlier global preview video", () => {
    const fixture = reactFiberPlayerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const preview = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
    ]);
    const previewVideo = {
      parentElement: null,
      tagName: "VIDEO",
      videoTracks: preview.player.videoTracks,
    };
    const baseDocumentRef = fixture.documentRef;
    fixture.documentRef = {
      querySelector: (selector) => baseDocumentRef.querySelector(selector),
      querySelectorAll(selector) {
        if (selector === "#live_player_layout video") return [fixture.video];
        if (selector === "video.webplayer-internal-video") return [previewVideo];
        return baseDocumentRef.querySelectorAll(selector);
      },
    };
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();

    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(preview.player.videoTracks.selectedIndex, 0);
    assert.deepEqual(preview.selectionTrueWrites, [0, 0]);
    harness.controller.stop();
  });

  it("falls back to a video ancestor that directly exposes VideoTrackList", () => {
    const fixture = reactFiberPlayerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const ancestor = fixture.installAncestorPlayer(fixture.player);
    const harness = controllerHarness(fixture);

    assert.equal(Object.hasOwn(fixture.layout, fixture.fiberProperty), false);
    assert.equal(fixture.video.parentElement, ancestor);
    assert.equal(ancestor.parentElement, fixture.layout);
    assert.equal(fixture.documentRef.querySelector(PLAYER_LAYOUT_SELECTOR), null);

    harness.controller.start();
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    harness.controller.stop();
  });

  it("finds a bounded React bridge owned only by an intermediate video ancestor", () => {
    const fixture = reactFiberPlayerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const bridge = fixture.installAncestorFiberPlayer(fixture.player);
    const harness = controllerHarness(fixture);

    assert.equal(Object.hasOwn(fixture.layout, fixture.fiberProperty), false);
    assert.equal(Object.hasOwn(bridge.ancestor, "videoTracks"), false);
    assert.equal(bridge.wrapper._internalPlayer, fixture.player);
    assert.equal(bridge.effect.next, bridge.effect);

    harness.controller.start();
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    harness.controller.stop();
  });

  it("does not wait for the quality pane before selecting the highest concrete track", () => {
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
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(fixture.selectionTrueWrites[0], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

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
    assert.equal(fixture.selectionTrueWrites[0], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    controller.stop();
  });

  it("does not wait for an existing pane to initialize its filter", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    fixture.pane.filter = undefined;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(fixture.selectionTrueWrites[0], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    fixture.pane.filter = () => true;
    fixture.player.videoTracks.dispatchTrackEvent("change");
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(fixture.selectionTrueWrites[0], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    harness.controller.stop();
  });

  it("coalesces fresh player evidence while the pane filter remains unavailable", () => {
    const fixture = playerFixture([{ height: 1080, label: "1080p", width: 1920 }]);
    fixture.pane.filter = undefined;
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(fixture.selectionTrueWrites[0], 1);

    for (let index = 0; index < 20; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }

    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(fixture.selectionTrueWrites[0], 1);

    harness.controller.stop();
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(fixture.player.videoTracks.listenerCount(eventType), 0);
    }
  });

  it("stays active and enforces highest quality across every same-site SPA route", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture, { pathname: "/" });

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    fixture.selectTrack(0);
    harness.historyRef.pushState({}, "", "/live/channel?from=home");
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    for (const path of [
      "/following",
      "/search?keyword=channel",
      "/category/GAME",
      "/livestream",
      "/lives?keyword=channel",
      "/",
    ]) {
      harness.advanceTime(5000);
      fixture.selectTrack(0);
      harness.historyRef.pushState({}, "", path);
      harness.flushTimer();
      harness.flushTimer();
      assert.equal(
        fixture.player.videoTracks.selectedIndex,
        1,
        `the player must remain highest quality on ${path}`,
      );
    }

    harness.advanceTime(5000);
    fixture.selectTrack(0);
    harness.historyRef.replaceState({}, "", "/following?tab=live");
    harness.flushTimer();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    harness.controller.stop();
    assert.equal(harness.historyRef.pushState, harness.originalPushState);
    assert.equal(harness.historyRef.replaceState, harness.originalReplaceState);
    assert.equal(harness.windowListeners.get("popstate")?.size ?? 0, 0);
  });

  it("retries a newly ready setter after same-site navigation without changing player identity", () => {
    let setterReady = false;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        onSelectionWrite({ apply }) {
          if (setterReady) apply();
        },
      },
    );
    const harness = controllerHarness(fixture, { pathname: "/live/channel-a" });

    harness.controller.start();
    assert.ok(harness.flushTimers(30) < 30);
    assert.equal(fixture.selectionTrueWrites[1], 2);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    setterReady = true;
    harness.historyRef.pushState({}, "", "/live/channel-b");
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.selectionTrueWrites[1], 3);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("never lets initial waiting or stalled events block the first highest-track write", () => {
    for (const eventType of ["waiting", "stalled"]) {
      const fixture = playerFixture([
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ]);
      const harness = controllerHarness(fixture);

      harness.controller.start();
      harness.dispatchDocument(eventType, fixture.primaryMedia);
      assert.equal(harness.flushTimer(), true);
      assert.equal(
        fixture.player.videoTracks.selectedIndex,
        1,
        `${eventType} must not delay the initial highest-track write`,
      );
      assert.equal(fixture.selectionTrueWrites[1], 1);
      assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
      harness.controller.stop();
      assert.equal(harness.pendingTimerCount(), 0);
    }
  });

  it("never lets waiting or stalled events block a remounted player's highest-track write", () => {
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
      assert.equal(harness.flushTimer(), true);
      fixture.mountDocument(replacement);
      harness.dispatchDocument(eventType, replacement.primaryMedia);
      harness.dispatchMutation([
        {
          addedNodes: [replacement.root],
          removedNodes: [fixture.root],
        },
      ]);
      assert.ok(harness.flushTimers(20) < 20);
      assert.equal(
        replacement.player.videoTracks.selectedIndex,
        1,
        `${eventType} must not delay the remounted highest-track write`,
      );
      assert.equal(replacement.selectionTrueWrites[1], 1);
      harness.controller.stop();
      assert.equal(harness.pendingTimerCount(), 0);
    }
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

  it("observes a same-pane option mutation after a confirmed high selection", () => {
    const fixture = playerFixture([
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", selected: true, width: 1920 },
    ]);
    const harness = controllerHarness(fixture);
    const optionContainer = {
      closest(selector) {
        return String(selector).includes("pzp-pc-setting-quality-pane") ? fixture.pane : null;
      },
      tagName: "DIV",
    };

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);

    fixture.addTrack({ height: 1440, label: "1440p", width: 2560 }, { emit: false });
    assert.equal(harness.pendingTimerCount(), 0);
    for (let index = 0; index < 20; index += 1) {
      harness.dispatchMutation([
        {
          addedNodes: [{ tagName: "DIV" }],
          removedNodes: [],
          target: optionContainer,
        },
      ]);
    }

    assert.equal(harness.pendingTimerCount(), 1);
    assert.equal(harness.pendingTimerDelay(), 250);
    assert.equal(harness.flushTimers(20), 2);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1440);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("ignores an initial compact filter contraction instead of selecting its fallback", () => {
    let allowHigh = false;
    const fixture = playerFixture(
      [
        { height: 720, label: "720p", selected: true, width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.label === "720p" || allowHigh,
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    allowHigh = true;
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.ok(harness.flushTimers(10) < 10);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("does not rewrite an unchanged sole concrete track when the watchdog is disabled", () => {
    const fixture = playerFixture([{ height: 720, label: "720p", selected: true, width: 1280 }]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    const baselineStorageWrites = fixture.storageSetCalls;
    const baselineSelectionWrites = fixture.selectionTrueWrites[0];

    for (let index = 0; index < 20; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    assert.ok(harness.flushTimers(10) < 10);

    assert.equal(fixture.selectionTrueWrites[0], baselineSelectionWrites);
    assert.equal(fixture.storageSetCalls, baselineStorageWrites);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("uses the watchdog to discover a silent 1080p track more than five seconds later", () => {
    const fixture = playerFixture([{ height: 720, label: "720p", selected: true, width: 1280 }]);
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount() >= 1, true);

    harness.advanceTime(6000);
    fixture.addTrack({ height: 1080, label: "1080p", width: 1920 }, { emit: false });

    for (let step = 0; step < 20 && fixture.player.videoTracks.selectedIndex !== 1; step += 1) {
      assert.equal(harness.flushTimer(), true);
    }
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount() >= 1, true);
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
  });

  it("uses the watchdog to reverse a silent demotion more than five seconds later", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    harness.advanceTime(6000);
    fixture.selectTrack(1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    for (let step = 0; step < 20 && fixture.player.videoTracks.selectedIndex !== 2; step += 1) {
      assert.equal(harness.flushTimer(), true);
    }
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
  });

  it("selects 1080p immediately when a cold compact filter rejects every higher track", () => {
    let maximumHeight = 480;
    const fixture = playerFixture(
      [
        { height: 480, label: "480p", width: 854 },
        { height: 720, label: "720p", selected: true, width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.height <= maximumHeight,
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    maximumHeight = 1080;
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.ok(harness.flushTimers(10) < 10);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("suppresses repeated lower-track setters without reassigning an already selected highest track", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.deepEqual(fixture.selectionTrueWrites, [0, 0, 1]);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      fixture.values[1].selected = true;
    }

    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.deepEqual(fixture.selectionTrueWrites, [0, 0, 1]);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    harness.controller.stop();
  });

  it("rewraps a page-replaced selected descriptor and restores that exact replacement on stop", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);

    let pageSetterCalls = 0;
    const replacementDescriptor = {
      configurable: true,
      enumerable: false,
      get() {
        return fixture.player.videoTracks.selectedIndex === 1;
      },
      set(next) {
        if (next !== true) return;
        pageSetterCalls += 1;
        fixture.selectTrack(1);
      },
    };
    Object.defineProperty(fixture.values[1], "selected", replacementDescriptor);
    harness.dispatchWindow("resize");
    assert.ok(harness.flushTimers(10) < 10);

    fixture.values[1].selected = true;
    assert.equal(pageSetterCalls, 0);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);

    harness.controller.stop();
    const restoredDescriptor = Object.getOwnPropertyDescriptor(fixture.values[1], "selected");
    assert.equal(restoredDescriptor.configurable, replacementDescriptor.configurable);
    assert.equal(restoredDescriptor.enumerable, replacementDescriptor.enumerable);
    assert.equal(restoredDescriptor.get, replacementDescriptor.get);
    assert.equal(restoredDescriptor.set, replacementDescriptor.set);

    fixture.values[1].selected = true;
    assert.equal(pageSetterCalls, 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
  });

  it("recovers every repeated compact demotion without ever persisting the lower track", () => {
    let maximumHeight = 1080;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.label !== "ABR" && track.height <= maximumHeight,
      },
    );
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    maximumHeight = 720;
    fixture.pane.filter = (track) => track.label !== "ABR" && track.height <= maximumHeight;
    harness.dispatchWindow("resize");
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.flushTimer(), true);

    for (let demotion = 0; demotion < 5; demotion += 1) {
      fixture.selectTrack(1);
      harness.dispatchDocument("waiting", fixture.primaryMedia);
      fixture.player.videoTracks.dispatchTrackEvent("change");
      let steps = 0;
      while (steps < 30 && fixture.player.videoTracks.selectedIndex !== 2) {
        assert.equal(harness.flushTimer(), true);
        steps += 1;
      }

      assert.ok(steps < 30, `compact demotion ${demotion + 1} must recover within the retry budget`);
      assert.equal(
        fixture.player.videoTracks.selectedIndex,
        2,
        `compact demotion ${demotion + 1} must recover to the highest track`,
      );
      assert.equal(
        JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height,
        1080,
        "a lower page-owned selection must never become persisted intent",
      );
    }

    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(fixture.selectionTrueWrites[2] >= 6, true);
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
  });

  it("keeps exact high intent when the quality pane is replaced after physical resize evidence", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    const compactPane = {
      filter: (track) => track.label !== "ABR" && track.height <= 720,
    };
    fixture.setPane(null);
    harness.dispatchWindow("resize");
    fixture.setPane(compactPane);
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.selectTrack(1);
    assert.ok(harness.flushTimers(20) < 20);

    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("restores remembered high quality when the compact current track is also filter-rejected", () => {
    let maximumHeight = 1080;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 480, label: "480p", width: 854 },
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.label !== "ABR" && track.height <= maximumHeight,
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    maximumHeight = 480;
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.selectTrack(2);
    harness.dispatchWindow("resize");
    assert.ok(harness.flushTimers(20) < 20);

    assert.equal(fixture.player.videoTracks.selectedIndex, 3);
    assert.equal(fixture.selectionTrueWrites[1], 0);
    assert.equal(fixture.selectionTrueWrites[2], 0);
    assert.equal(fixture.selectionTrueWrites[3], 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("immediately restores a confirmed highest track despite waiting without resize evidence", () => {
    let maximumHeight = 1080;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 480, label: "480p", width: 854 },
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.label !== "ABR" && track.height <= maximumHeight,
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    maximumHeight = 480;
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.selectTrack(2);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.ok(harness.flushTimers(10) < 10);

    assert.equal(fixture.player.videoTracks.selectedIndex, 3);
    assert.equal(fixture.selectionTrueWrites[2], 0);
    assert.equal(fixture.selectionTrueWrites[3], 2);
    assert.equal(
      JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height,
      1080,
      "a buffering-only demotion must neither survive nor replace high-quality intent",
    );

    maximumHeight = 720;
    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.ok(harness.flushTimers(10) < 10);
    assert.equal(fixture.player.videoTracks.selectedIndex, 3);
    assert.equal(fixture.selectionTrueWrites[3], 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("restores a confirmed highest track after the responsive evidence window expires", () => {
    let maximumHeight = 1080;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.label !== "ABR" && track.height <= maximumHeight,
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    harness.dispatchWindow("resize");
    assert.ok(harness.flushTimers(20) < 20);

    maximumHeight = 720;
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.selectTrack(1);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.ok(harness.flushTimers(10) < 10);

    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("promotes a newly discovered 1440p track even while media is waiting", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.addTrack({ height: 1440, label: "1440p", width: 2560 });
    assert.ok(harness.flushTimers(20) < 20);

    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1440);

    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1440);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("recovers on wide expansion when a compact correction was ignored", () => {
    let maximumHeight = 1080;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.label !== "ABR" && track.height <= maximumHeight,
        onSelectionWrite({ apply }) {
          if (maximumHeight === 1080) apply();
        },
      },
    );
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    harness.flushTimer();
    maximumHeight = 720;
    harness.dispatchDocument("waiting", fixture.primaryMedia);
    fixture.selectTrack(1);
    harness.dispatchWindow("resize");
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[2] >= 2, true);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    maximumHeight = 1080;
    harness.dispatchWindow("resize");
    for (let step = 0; step < 20 && fixture.player.videoTracks.selectedIndex !== 2; step += 1) {
      assert.equal(harness.flushTimer(), true);
    }
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
  });

  it("retains high intent while its track disappears and restores a replacement track object", () => {
    let maximumHeight = 1080;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 720, label: "720p", width: 1280 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        filter: (track) => track.label !== "ABR" && track.height <= maximumHeight,
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    maximumHeight = 720;
    fixture.selectTrack(1);
    harness.dispatchWindow("resize");
    assert.ok(harness.flushTimers(20) < 20);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);

    const originalHighTrack = fixture.values[2];
    fixture.values.splice(2, 1);
    fixture.player.videoTracks.dispatchTrackEvent("removetrack");
    assert.ok(harness.flushTimers(10) < 10);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(fixture.selectionTrueWrites[1], 1);

    const replacementHighTrack = fixture.addTrack({
      height: 1080,
      label: "1080p",
      width: 1920,
    });
    assert.notEqual(replacementHighTrack, originalHighTrack);
    assert.ok(harness.flushTimers(10) < 10);
    assert.equal(fixture.player.videoTracks.selectedIndex, 2);
    assert.equal(fixture.selectionTrueWrites[2], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("suppresses an ABR setter before it can reset an unchanged highest selection", () => {
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
    assert.equal(fixture.selectionTrueWrites[0], 0);
    assert.equal(fixture.selectionTrueWrites[1], 1);

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

  it("preserves an in-flight highest-track confirmation across player-root mutation evidence", () => {
    let pendingApply = null;
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        onSelectionWrite({ apply }) {
          pendingApply = apply;
        },
      },
    );
    const harness = controllerHarness(fixture);

    harness.controller.start();
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    harness.dispatchMutation([
      {
        addedNodes: [fixture.root],
        removedNodes: [],
      },
    ]);
    assert.equal(harness.flushTimer(), true, "player-root evidence should enqueue an urgent scan");
    assert.equal(harness.flushTimer(), true, "the urgent scan should observe the applying transaction");
    assert.equal(
      fixture.selectionTrueWrites[1],
      1,
      "the urgent scan must not duplicate the in-flight highest-track setter",
    );
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    pendingApply();
    assert.equal(harness.flushTimer(), true, "the original confirmation should observe the apply");
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("rate-limits ignored writes but keeps retrying until the highest track is accepted", () => {
    let harness;
    const writeTimes = [];
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      {
        onSelectionWrite({ apply, videoTracks, writeCount }) {
          writeTimes.push(harness.now());
          for (let index = 0; index < 5; index += 1) {
            videoTracks.dispatchTrackEvent("change");
          }
          if (writeCount >= 6) apply();
        },
      },
    );
    harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    let steps = 0;
    while (steps < 100 && fixture.player.videoTracks.selectedIndex !== 1) {
      assert.equal(harness.flushTimer(), true);
      steps += 1;
    }

    assert.ok(steps < 100, "the rate-limited watchdog must eventually recover");
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 6);
    assert.equal(writeTimes.length, 6);
    assert.equal(writeTimes[1] < 5000, true, "the candidate receives one bounded confirmation write");
    for (let index = 2; index < writeTimes.length; index += 1) {
      assert.equal(
        writeTimes[index] - writeTimes[index - 1] >= 5000,
        true,
        `ignored write ${index + 1} must wait for the five-second retry interval`,
      );
    }
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    assert.equal(harness.pendingTimerCount() >= 1, true);

    for (let index = 0; index < 50; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    assert.equal(harness.flushTimer(), true, "the event storm should coalesce into one scan");
    assert.equal(fixture.selectionTrueWrites[1], 6);

    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
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
    assert.equal(harness.pendingTimerDelay(), 0);

    harness.flushTimer();
    assert.equal(replacement.selectionTrueWrites[2], 0, "the responsive timer should only enqueue a scan");
    harness.flushTimer();
    assert.equal(replacement.selectionTrueWrites[2], 1);
    assert.equal(replacement.player.videoTracks.selectedIndex, 2);
    for (const eventType of ["addtrack", "removetrack", "change"]) {
      assert.equal(previousTracks.listenerCount(eventType), 0);
      assert.equal(replacement.player.videoTracks.listenerCount(eventType), 1);
    }
    assert.ok(harness.flushTimers(10) < 10, "responsive follow-up scans must remain bounded");
    assert.equal(replacement.selectionTrueWrites[2], 1);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
  });

  it("bounds confirmed ABR corrections and replenishes one write after five seconds", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    harness.flushTimer();
    assert.equal(fixture.selectionTrueWrites[1], 1);

    for (let correction = 0; correction < 3; correction += 1) {
      fixture.selectTrack(0);
      for (let index = 0; index < 20; index += 1) {
        fixture.player.videoTracks.dispatchTrackEvent("change");
      }
      assert.equal(harness.flushTimer(), true);
      assert.equal(fixture.selectionTrueWrites[1], correction + 2);
      assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    }

    fixture.selectTrack(0);
    for (let index = 0; index < 20; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 4);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    harness.advanceTime(5000);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    let recoverySteps = 0;
    while (recoverySteps < 20 && fixture.selectionTrueWrites[1] < 5) {
      assert.equal(harness.flushTimer(), true);
      recoverySteps += 1;
    }
    assert.ok(recoverySteps < 20);
    assert.equal(fixture.selectionTrueWrites[1], 5);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
  });

  it("coalesces media evidence without a timeupdate listener or an early fifth write", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    assert.equal(harness.flushTimer(), true);
    for (let correction = 0; correction < 3; correction += 1) {
      fixture.selectTrack(0);
      fixture.player.videoTracks.dispatchTrackEvent("change");
      assert.equal(harness.flushTimer(), true);
      assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    }
    assert.equal(fixture.selectionTrueWrites[1], 4);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    harness.dispatchDocument("waiting", fixture.primaryMedia);
    harness.dispatchDocument("stalled", fixture.primaryMedia);
    harness.dispatchDocument("playing", fixture.primaryMedia);
    harness.dispatchDocument("canplay", fixture.primaryMedia);
    harness.dispatchDocument("timeupdate", fixture.primaryMedia);
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.flushTimer(), false);
    assert.equal(harness.documentListeners.get("timeupdate")?.size ?? 0, 0);
    assert.equal(fixture.selectionTrueWrites[1], 4);
    assert.equal(
      fixture.player.videoTracks.selectedIndex,
      0,
      "media evidence must not manufacture a fifth write token",
    );

    harness.advanceTime(5000);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 5);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    harness.controller.stop();
  });

  it("persists a selected highest track even when the pane filter rejects it", () => {
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
    assert.equal(fixture.storageSetCalls, 1);
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      height: 1080,
      label: "1080p",
      width: 1920,
    });
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

  it("selects the highest bitrate when concrete tracks have equal dimensions", () => {
    const fixture = playerFixture([
      {
        height: 1080,
        label: "1080p",
        selected: true,
        videoBitrate: 4_000_000,
        width: 1920,
      },
      {
        height: 1080,
        label: "1080p",
        videoBitrate: 8_000_000,
        width: 1920,
      },
    ]);

    selectHighestAllowedPlayerTrack({
      documentRef: fixture.documentRef,
      storage: fixture.storage,
    });

    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.deepEqual(fixture.selectionTrueWrites, [0, 1]);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
  });

  it("selects a filter-rejected 1080p after ABR replaces the manual selection", () => {
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

    assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    assert.equal(fixture.selectionTrueWrites[1], 1);
    assert.equal(fixture.selectionTrueWrites[2], 0);
    assert.deepEqual(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)), {
      height: 1080,
      label: "1080p",
      width: 1920,
    });
  });

  it("stable high events preserve only the single correction refilled after five seconds", () => {
    const fixture = playerFixture([
      { height: 1080, label: "ABR", selected: true, width: 1920 },
      { height: 1080, label: "1080p", width: 1920 },
    ]);
    const harness = controllerHarness(fixture);

    harness.controller.start();
    harness.flushTimer();
    for (let correction = 0; correction < 3; correction += 1) {
      fixture.selectTrack(0);
      fixture.player.videoTracks.dispatchTrackEvent("change");
      assert.equal(harness.flushTimer(), true);
      assert.equal(fixture.selectionTrueWrites[1], correction + 2);
      assert.equal(fixture.player.videoTracks.selectedIndex, 1);
    }

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 4);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);

    fixture.selectTrack(1);
    for (let second = 1; second <= 6; second += 1) {
      harness.advanceTime(1000);
      fixture.player.videoTracks.dispatchTrackEvent("change");
      assert.equal(harness.flushTimer(), true);
    }
    assert.equal(fixture.selectionTrueWrites[1], 4);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 5);
    assert.equal(fixture.player.videoTracks.selectedIndex, 1);

    fixture.selectTrack(0);
    fixture.player.videoTracks.dispatchTrackEvent("change");
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 5);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 0);
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
  });

  it("does not reset a candidate retry budget when pane and filter identity change", () => {
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      { onSelectionWrite() {} },
    );
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    let steps = 0;
    while (steps < 20 && fixture.selectionTrueWrites[1] < 2) {
      assert.equal(harness.flushTimer(), true);
      steps += 1;
    }
    assert.ok(steps < 20);
    assert.equal(fixture.selectionTrueWrites[1], 2);

    fixture.setPane({ filter: () => true });
    for (let index = 0; index < 30; index += 1) {
      fixture.player.videoTracks.dispatchTrackEvent("change");
    }
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.selectionTrueWrites[1], 2, "pane/filter replacement must not retry early");

    harness.advanceTime(5000);
    steps = 0;
    while (steps < 20 && fixture.selectionTrueWrites[1] < 3) {
      assert.equal(harness.flushTimer(), true);
      steps += 1;
    }
    assert.ok(steps < 20);
    assert.equal(fixture.selectionTrueWrites[1], 3, "only elapsed cooldown may rearm the candidate");
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
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
    assert.equal(
      fixture.storageSetCalls,
      2,
      "startup baseline plus only the selected remounted generation may commit storage",
    );
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

  it("does not reset the global write bucket across same-site route changes", () => {
    const fixture = playerFixture(
      [
        { height: 1080, label: "ABR", selected: true, width: 1920 },
        { height: 1080, label: "1080p", width: 1920 },
      ],
      { onSelectionWrite() {} },
    );
    const harness = controllerHarness(fixture, {
      pathname: "/",
      watchdogIntervalMs: 1000,
    });

    harness.controller.start();
    let steps = 0;
    while (steps < 20 && fixture.selectionTrueWrites[1] < 2) {
      assert.equal(harness.flushTimer(), true);
      steps += 1;
    }
    assert.ok(steps < 20);
    assert.equal(fixture.selectionTrueWrites[1], 2);

    for (const path of ["/following", "/search?keyword=live", "/category/GAME", "/lives"]) {
      harness.historyRef.pushState({}, "", path);
      assert.equal(harness.flushTimer(), true);
      assert.equal(
        fixture.selectionTrueWrites[1],
        2,
        `same-site navigation to ${path} must not refill the global bucket`,
      );
    }

    harness.advanceTime(5000);
    harness.historyRef.pushState({}, "", "/live/return");
    steps = 0;
    while (steps < 20 && fixture.selectionTrueWrites[1] < 3) {
      assert.equal(harness.flushTimer(), true);
      steps += 1;
    }
    assert.ok(steps < 20);
    assert.equal(fixture.selectionTrueWrites[1], 3);
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
  });

  it("rate-limits a remount storm without resetting the controller-global bucket", () => {
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
    harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });
    const stormWrites = () =>
      generations.reduce((sum, generation) => sum + generation.selectionTrueWrites[1], 0);

    harness.controller.start();
    let steps = 0;
    while (steps < 20 && stormWrites() < 4) {
      assert.equal(harness.flushTimer(), true);
      steps += 1;
    }
    assert.ok(steps < 20);
    assert.equal(stormWrites(), 4);
    assert.equal(generations.length, 5);

    for (let index = 0; index < 30; index += 1) {
      harness.dispatchWindow("resize");
      harness.dispatchMutation([
        {
          addedNodes: [generations.at(-1).root],
          removedNodes: [],
        },
      ]);
    }
    assert.equal(harness.flushTimer(), true);
    assert.equal(harness.flushTimer(), true);
    assert.equal(stormWrites(), 4, "player, track, pane, and filter churn must not refill writes");

    harness.advanceTime(5000);
    harness.dispatchMutation([
      {
        addedNodes: [generations.at(-1).root],
        removedNodes: [],
      },
    ]);
    steps = 0;
    while (steps < 20 && stormWrites() < 5) {
      assert.equal(harness.flushTimer(), true);
      steps += 1;
    }
    assert.ok(steps < 20);
    assert.equal(stormWrites(), 5, "only elapsed cooldown may refill one write");
    assert.equal(generations.length, 6);
    assert.equal(new Set(generations.map((generation) => generation.player)).size, generations.length);
    assert.equal(
      new Set(generations.map((generation) => generation.player.videoTracks)).size,
      generations.length,
    );
    assert.equal(new Set(generations.map((generation) => generation.pane)).size, generations.length);
    assert.equal(new Set(generations.map((generation) => generation.pane.filter)).size, generations.length);
    assert.equal(fixture.storageSetCalls, 1);
    assert.equal(JSON.parse(fixture.stored.get(QUALITY_STORAGE_KEY)).height, 1080);
    harness.controller.stop();
  });

  it("cancels the always-high watchdog on stop", () => {
    const fixture = playerFixture([
      { height: 1080, label: "1080p", selected: true, width: 1920 },
      { height: 720, label: "720p", width: 1280 },
    ]);
    const harness = controllerHarness(fixture, { watchdogIntervalMs: 1000 });

    harness.controller.start();
    assert.equal(harness.flushTimer(), true);
    assert.equal(fixture.player.videoTracks.selectedIndex, 0);
    assert.equal(harness.pendingTimerCount(), 1);
    assert.equal(harness.pendingTimerDelay(), 1000);

    const writesBeforeStop = fixture.selectionTrueWrites[0];
    harness.controller.stop();
    assert.equal(harness.pendingTimerCount(), 0);
    harness.advanceTime(10_000);
    assert.equal(harness.flushTimers(), 0);
    assert.equal(fixture.selectionTrueWrites[0], writesBeforeStop);
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
    for (const eventType of ["loadedmetadata", "change", "waiting", "stalled", "playing", "canplay"]) {
      assert.equal(harness.documentListeners.get(eventType)?.size ?? 0, 1);
    }
    assert.equal(harness.documentListeners.get("timeupdate")?.size ?? 0, 0);
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
