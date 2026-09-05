import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDiagnosticsStore } from "../../src/runtime/diagnostics-store.js";

function fixture({ beforeSet = async () => {}, maxPendingMutations = 50 } = {}) {
  const values = {};
  let removals = 0;
  const store = createDiagnosticsStore({
    maxSamples: 200,
    maxPendingMutations,
    storage: {
      async get(key) {
        return structuredClone({ [key]: values[key] });
      },
      async set(value) {
        await beforeSet();
        Object.assign(values, structuredClone(value));
      },
      async remove(key) {
        removals += 1;
        delete values[key];
      },
    },
  });
  return { store, values, removals: () => removals };
}

describe("serialized diagnostics storage", () => {
  it("clears after a pending write instead of allowing old data to reappear", async () => {
    let releaseWrite;
    let writeStarted;
    const started = new Promise((resolve) => {
      writeStarted = resolve;
    });
    const blocked = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const { store, values } = fixture({
      beforeSet: () => {
        writeStarted();
        return blocked;
      },
    });
    const write = store.mutate((value) => {
      value.totalHlsRequests = 7;
    });
    await started;
    const cleared = store.clear();
    releaseWrite();
    await write;
    assert.equal((await cleared).totalHlsRequests, 0);
    assert.equal(values.chzzkDiagnostics, undefined);
    await store.mutate((value) => {
      value.totalHlsRequests += 1;
    });
    assert.equal(values.chzzkDiagnostics.totalHlsRequests, 1);
  });

  it("coalesces repeated clears without dropping the clear when writes saturate the queue", async () => {
    const { store, removals } = fixture({ maxPendingMutations: 1 });
    const write = store.mutate(() => {});
    assert.equal((await store.mutate(() => {})).dropped, true);
    const first = store.clear();
    assert.equal(store.clear(), first);
    await Promise.all([write, first]);
    assert.equal(removals(), 1);
  });

  it("continues after failed writes and normalizes unknown fields before saving", async () => {
    let fail = true;
    const { store, values } = fixture({
      beforeSet: () => {
        if (fail) throw new Error("synthetic");
      },
    });
    await assert.rejects(
      store.mutate(() => {}),
      /synthetic/,
    );
    fail = false;
    await store.mutate((value) => {
      value.unknown = "discard";
      value.totalHlsRequests = 1;
    });
    assert.equal(values.chzzkDiagnostics.totalHlsRequests, 1);
    assert.equal(Object.hasOwn(values.chzzkDiagnostics, "unknown"), false);
  });
});
