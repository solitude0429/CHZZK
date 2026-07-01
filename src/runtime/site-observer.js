const api = globalThis.browser ?? globalThis.chrome;

function notifyLivePageReady() {
  try {
    api.runtime.sendMessage({ type: "chzzk.live-page-ready" }).catch?.(() => {});
  } catch {
    // Firefox may tear down extension contexts during reload/update. The next page load will retry.
    return false;
  }
}

if (document.readyState === "loading") {
  notifyLivePageReady();
  document.addEventListener("DOMContentLoaded", notifyLivePageReady, { once: true });
} else {
  notifyLivePageReady();
}
