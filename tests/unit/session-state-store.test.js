import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSessionStateStore } from "../../src/runtime/session-state-store.js";

function state(key, tabId, extra = {}) {
  return { familyKey: key, key, tabId, ...extra };
}

describe("runtime session-state store", () => {
  it("counts a family once and uses its most recent state across all registries", () => {
    const store = createSessionStateStore({ maxStates: 2, maxStatesPerTab: 2 });
    const controller = new AbortController();
    store.activeTargetsBySession.set("shared", store.touch(state("shared", 1)));
    store.resolutionBySession.set("older", store.touch(state("older", 1, { controller })));
    store.failedTargetsBySession.set(
      "shared",
      store.touch(state("shared", 1, { targets: new Map([["1080p", Date.now() + 60_000]]) })),
    );
    store.masterLineageBySession.set("shared", store.touch(state("shared", 1)));
    store.enforceLimits();
    assert.equal(controller.signal.aborted, false);

    store.activeTargetsBySession.set("new", store.touch(state("new", 1)));
    store.enforceLimits("new");

    assert.deepEqual([...store.activeTargetsBySession.keys()], ["shared", "new"]);
    assert.equal(store.failedTargetsBySession.has("shared"), true);
    assert.equal(store.masterLineageBySession.has("shared"), true);
    assert.equal(store.resolutionBySession.has("older"), false);
    assert.equal(controller.signal.aborted, true);
  });

  it("evicts the least-recently-used family and forgets its redirected requests", () => {
    let activeChanges = 0;
    const redirectedRequestsById = new Map([["old-request", { key: "family-b", settled: false }]]);
    const store = createSessionStateStore({
      maxStates: 2,
      maxStatesPerTab: 2,
      onActiveTargetsChanged: () => {
        activeChanges += 1;
      },
      redirectedRequestsById,
    });

    const familyA = store.touch(state("family-a", 1));
    const familyB = store.touch(state("family-b", 1));
    store.activeTargetsBySession.set(familyA.key, familyA);
    store.activeTargetsBySession.set(familyB.key, familyB);
    store.touch(familyA);
    const familyC = store.touch(state("family-c", 1));
    store.activeTargetsBySession.set(familyC.key, familyC);

    assert.equal(store.enforceLimits("family-c"), true);
    assert.deepEqual([...store.activeTargetsBySession.keys()].sort(), ["family-a", "family-c"]);
    assert.equal(redirectedRequestsById.has("old-request"), false);
    assert.equal(activeChanges, 1);
  });

  it("sweeps expired targets, failed qualities, and aborted resolutions", () => {
    const redirected = { key: "expired", settled: false };
    const redirectedRequestsById = new Map([["expired-request", redirected]]);
    const store = createSessionStateStore({ redirectedRequestsById });
    store.activeTargetsBySession.set("expired", state("expired", 1, { expiresAt: 10 }));
    store.failedTargetsBySession.set(
      "failed",
      state("failed", 1, {
        targets: new Map([
          ["2160p", 10],
          ["1080p", 20],
        ]),
      }),
    );
    const controller = new AbortController();
    controller.abort();
    store.resolutionBySession.set("aborted", state("aborted", 1, { controller }));

    assert.equal(store.sweepExpired(10), true);
    assert.equal(store.activeTargetsBySession.has("expired"), false);
    assert.equal(redirected.settled, true);
    assert.equal(redirectedRequestsById.size, 0);
    assert.deepEqual([...store.failedTargetsBySession.get("failed").targets.keys()], ["1080p"]);
    assert.equal(store.resolutionBySession.has("aborted"), false);
  });

  it("protects the current family while enforcing a global limit", () => {
    const store = createSessionStateStore({ maxStates: 1, maxStatesPerTab: 4 });
    const protectedState = store.touch(state("protected", 1));
    const removableState = store.touch(state("removable", 2));
    store.activeTargetsBySession.set(protectedState.key, protectedState);
    store.activeTargetsBySession.set(removableState.key, removableState);

    store.enforceLimits("protected");

    assert.deepEqual([...store.activeTargetsBySession.keys()], ["protected"]);
  });

  it("aborts an in-flight resolution when removing a session", () => {
    const store = createSessionStateStore();
    const controller = new AbortController();
    store.masterLineageBySession.set(
      "pending",
      state("pending", 1, { advertisedTargetQuality: "1080p", epoch: {} }),
    );
    store.resolutionBySession.set("pending", state("pending", 1, { controller }));

    assert.equal(store.remove("pending"), false);
    assert.equal(controller.signal.aborted, true);
    assert.equal(store.masterLineageBySession.has("pending"), false);
    assert.equal(store.resolutionBySession.has("pending"), false);
  });

  it("rejects invalid collaborators", () => {
    assert.throws(() => createSessionStateStore({ redirectedRequestsById: {} }), /registry must be a Map/i);
    assert.throws(
      () => createSessionStateStore({ onActiveTargetsChanged: null }),
      /callback must be a function/i,
    );
  });
});
