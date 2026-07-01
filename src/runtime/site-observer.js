const api = globalThis.browser ?? globalThis.chrome;

function isChzzkLivePageUrl(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "chzzk.naver.com" &&
      parsed.pathname.startsWith("/live/")
    );
  } catch {
    return false;
  }
}

if (isChzzkLivePageUrl(globalThis.location.href)) {
  api.runtime.sendMessage({ type: "chzzk.live-page-ready" }).catch(() => {});
}
