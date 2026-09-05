const DEFAULT_HARD_MAX_STATES = 1024;
const DEFAULT_HARD_MAX_STATES_PER_TAB = 128;

function boundedPositiveInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function compareSessionAccess(left, right) {
  if (left.lastTouchedOrder !== right.lastTouchedOrder) {
    return left.lastTouchedOrder - right.lastTouchedOrder;
  }
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

export function createSessionStateStore({
  hardMaxStates = DEFAULT_HARD_MAX_STATES,
  hardMaxStatesPerTab = DEFAULT_HARD_MAX_STATES_PER_TAB,
  maxStates = 256,
  maxStatesPerTab = 64,
  onActiveTargetsChanged = () => {},
  redirectedRequestsById = new Map(),
} = {}) {
  const normalizedHardMaxStates = boundedPositiveInteger(
    hardMaxStates,
    DEFAULT_HARD_MAX_STATES,
    Number.MAX_SAFE_INTEGER,
  );
  const normalizedHardMaxStatesPerTab = boundedPositiveInteger(
    hardMaxStatesPerTab,
    DEFAULT_HARD_MAX_STATES_PER_TAB,
    Number.MAX_SAFE_INTEGER,
  );
  const normalizedMaxStates = boundedPositiveInteger(
    maxStates,
    Math.min(256, normalizedHardMaxStates),
    normalizedHardMaxStates,
  );
  const normalizedMaxStatesPerTab = boundedPositiveInteger(
    maxStatesPerTab,
    Math.min(64, normalizedHardMaxStatesPerTab),
    normalizedHardMaxStatesPerTab,
  );
  if (!(redirectedRequestsById instanceof Map)) {
    throw new TypeError("Session-state redirected request registry must be a Map");
  }
  if (typeof onActiveTargetsChanged !== "function") {
    throw new TypeError("Session-state change callback must be a function");
  }

  const activeTargetsBySession = new Map();
  const failedTargetsBySession = new Map();
  const masterLineageBySession = new Map();
  const resolutionBySession = new Map();
  const stateMaps = [
    activeTargetsBySession,
    failedTargetsBySession,
    masterLineageBySession,
    resolutionBySession,
  ];
  let sessionAccessSequence = 0;

  function sessionStateEntries() {
    const byKey = new Map();
    for (const map of stateMaps) {
      for (const [key, state] of map) {
        const entry = byKey.get(key) ?? {
          key,
          lastTouchedOrder: 0,
          states: [],
          tabId: state.tabId,
        };
        entry.lastTouchedOrder = Math.max(
          entry.lastTouchedOrder,
          Number.isSafeInteger(state.lastTouchedOrder) ? state.lastTouchedOrder : 0,
        );
        entry.states.push(state);
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()];
  }

  function normalizeAccessOrder() {
    sessionAccessSequence = 0;
    for (const group of sessionStateEntries().sort(compareSessionAccess)) {
      sessionAccessSequence += 1;
      for (const state of group.states) state.lastTouchedOrder = sessionAccessSequence;
    }
  }

  function nextAccessOrder() {
    if (sessionAccessSequence >= Number.MAX_SAFE_INTEGER - normalizedHardMaxStates) {
      normalizeAccessOrder();
    }
    sessionAccessSequence += 1;
    return sessionAccessSequence;
  }

  function touch(state) {
    if (!state || typeof state !== "object") return state;
    state.lastTouchedOrder = nextAccessOrder();
    return state;
  }

  function forgetRedirectedRequests(sessionKey) {
    for (const [requestId, record] of redirectedRequestsById) {
      if (record.key !== sessionKey) continue;
      record.settled = true;
      redirectedRequestsById.delete(requestId);
    }
  }

  function remove(sessionKey) {
    const removedActiveTarget = activeTargetsBySession.delete(sessionKey);
    failedTargetsBySession.delete(sessionKey);
    masterLineageBySession.delete(sessionKey);
    const resolution = resolutionBySession.get(sessionKey);
    resolution?.controller.abort();
    resolutionBySession.delete(sessionKey);
    forgetRedirectedRequests(sessionKey);
    return removedActiveTarget;
  }

  function sweepExpired(now = Date.now()) {
    let removedActiveTarget = false;
    for (const [key, state] of activeTargetsBySession) {
      if (state.expiresAt == null || state.expiresAt > now) continue;
      activeTargetsBySession.delete(key);
      forgetRedirectedRequests(key);
      removedActiveTarget = true;
    }
    for (const [key, state] of failedTargetsBySession) {
      if (!(state.targets instanceof Map)) {
        failedTargetsBySession.delete(key);
        continue;
      }
      for (const [quality, expiresAt] of state.targets) {
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
          state.targets.delete(quality);
        }
      }
      if (state.targets.size === 0) failedTargetsBySession.delete(key);
    }
    for (const [key, state] of resolutionBySession) {
      if (state.controller?.signal?.aborted) resolutionBySession.delete(key);
    }
    return removedActiveTarget;
  }

  function enforceLimits(protectedKey = null) {
    let removedActiveTarget = sweepExpired();
    function evictExcess(entries, limit) {
      entries.sort(compareSessionAccess);
      let excess = entries.length - limit;
      for (const entry of entries) {
        if (excess <= 0) break;
        if (entry.key === protectedKey) continue;
        removedActiveTarget = remove(entry.key) || removedActiveTarget;
        excess -= 1;
      }
    }

    const byTab = new Map();
    for (const entry of sessionStateEntries()) {
      const entries = byTab.get(entry.tabId) ?? [];
      entries.push(entry);
      byTab.set(entry.tabId, entries);
    }
    for (const entries of byTab.values()) {
      evictExcess(entries, normalizedMaxStatesPerTab);
    }

    evictExcess(sessionStateEntries(), normalizedMaxStates);
    if (removedActiveTarget) onActiveTargetsChanged();
    return removedActiveTarget;
  }

  return Object.freeze({
    activeTargetsBySession,
    enforceLimits,
    failedTargetsBySession,
    forgetRedirectedRequests,
    masterLineageBySession,
    remove,
    resolutionBySession,
    sweepExpired,
    touch,
  });
}
