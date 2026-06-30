(() => {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "chzzkDiagnostics";
  const summary = document.querySelector("#summary");
  const payload = document.querySelector("#payload");

  function emptyDiagnostics() {
    return {
      generatedAt: new Date(0).toISOString(),
      qualities: {},
      samples: [],
      totalHlsRequests: 0,
    };
  }

  async function loadDiagnostics() {
    const stored = await api.storage.local.get(STORAGE_KEY);
    return stored?.[STORAGE_KEY] ?? emptyDiagnostics();
  }

  function render(diagnostics) {
    const qualities = Object.entries(diagnostics.qualities ?? {})
      .sort(([a], [b]) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
      .map(([quality, count]) => `${quality}: ${count}`)
      .join("\n");
    summary.textContent = `generatedAt: ${diagnostics.generatedAt}\ntotalHlsRequests: ${diagnostics.totalHlsRequests ?? 0}\n${qualities}`;
    payload.value = JSON.stringify(diagnostics, null, 2);
  }

  async function refresh() {
    render(await loadDiagnostics());
  }

  document.querySelector("#refresh").addEventListener("click", refresh);
  document.querySelector("#copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(payload.value);
  });
  document.querySelector("#clear").addEventListener("click", async () => {
    await api.storage.local.remove(STORAGE_KEY);
    await refresh();
  });

  refresh().catch((error) => {
    summary.textContent = String(error?.stack ?? error);
  });
})();
