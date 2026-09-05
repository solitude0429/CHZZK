import { normalizeDiagnostics } from "../shared/diagnostics.js";

export function createDiagnosticsStore({ storage, maxSamples, maxPendingMutations = 50 }) {
  const key = "chzzkDiagnostics";
  const options = { maxSamples };
  const configuredLimit = Number(maxPendingMutations);
  const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 50;
  let queue = Promise.resolve();
  let depth = 0;
  let pendingClear = null;

  function enqueue(operation) {
    const result = queue.then(operation);
    // A failed write must not poison later mutations or expose raw storage errors.
    queue = result.catch(() => {});
    return result;
  }

  function mutate(mutator) {
    if (depth >= limit) return Promise.resolve({ diagnostics: null, dropped: true, result: false });
    depth += 1;
    return enqueue(async () => {
      const stored = await storage.get(key);
      const diagnostics = normalizeDiagnostics(stored?.[key], options);
      const result = mutator(diagnostics);
      const normalized = normalizeDiagnostics(diagnostics, options);
      await storage.set({ [key]: normalized });
      return { diagnostics: normalized, result };
    }).finally(() => {
      depth -= 1;
    });
  }

  function clear() {
    if (pendingClear) return pendingClear;
    // The user's clear follows all accepted writes, even when the telemetry
    // queue is full. Coalesce repeated clicks to keep this path bounded too.
    pendingClear = enqueue(async () => {
      await storage.remove(key);
      return normalizeDiagnostics(null, options);
    }).finally(() => {
      pendingClear = null;
    });
    return pendingClear;
  }

  return Object.freeze({ clear, mutate });
}
