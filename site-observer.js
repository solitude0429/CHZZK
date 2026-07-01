(() => {
  // src/runtime/site-observer.js
  var api = globalThis.browser ?? globalThis.chrome;
  function notifyLivePageReady() {
    try {
      api.runtime.sendMessage({ type: "chzzk.live-page-ready" }).catch?.(() => {});
    } catch {
      return false;
    }
  }
  if (document.readyState === "loading") {
    notifyLivePageReady();
    document.addEventListener("DOMContentLoaded", notifyLivePageReady, { once: true });
  } else {
    notifyLivePageReady();
  }
})();
