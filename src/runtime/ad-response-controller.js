const GFP_SCHEDULE_DESCRIPTION = "GFP Video Ad Schedule";
const NAVER_WATERFALL_DESCRIPTION = "Naver SSP Waterfall List";
const AD_PROTOCOL_VERSION = "0.0.1";
const CHZZK_VIDEO_SCHEDULE_IDS = new Set(["LIVE_CHZZK_NDP_SCH", "LIVE_CHZZK_NDP_SCH_EVENT"]);
const CHZZK_LIVE_AD_UNIT = /^(?:event_)?w_live_chzzk_naver_va(?:_[a-z0-9]+)*$/i;
const MAX_MARKER_SCAN_BYTES = 16_384;
const CONTROLLER_SLOT = Symbol.for("chzzk.ad-response-controller");
const STYLE_ATTRIBUTE = "data-chzzk-extension-ad-guard";

const AD_UI_STYLE = `
[data-nlog-area="ad_blocking_info_layer"] {
  display: none !important;
}

.webplayer-internal-core-dimmed {
  display: none !important;
}

.webplayer-internal-core-ad-ui {
  clip-path: inset(50%) !important;
  pointer-events: none !important;
}
`;

function ignoreAdGuardFailure() {
  return false;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChzzkLiveAdUnit(value) {
  return typeof value === "string" && CHZZK_LIVE_AD_UNIT.test(value);
}

function isNeutralSchedule(adBreaks) {
  if (adBreaks.length !== 1 || !isRecord(adBreaks[0])) return false;
  const adBreak = adBreaks[0];
  return (
    adBreak.id === "" &&
    adBreak.startDelay === 0 &&
    adBreak.preFetch === 0 &&
    adBreak.adUnitId === "" &&
    Array.isArray(adBreak.adSources) &&
    adBreak.adSources.length === 0
  );
}

export function sanitizeChzzkAdResponse(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.head) ||
    value.head.version !== AD_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" ||
    value.requestId === ""
  ) {
    return null;
  }

  if (
    value.head.description === GFP_SCHEDULE_DESCRIPTION &&
    CHZZK_VIDEO_SCHEDULE_IDS.has(value.videoAdScheduleId) &&
    Array.isArray(value.adBreaks) &&
    value.adBreaks.length > 0 &&
    value.adBreaks.some((adBreak) => isRecord(adBreak) && isChzzkLiveAdUnit(adBreak.adUnitId)) &&
    !isNeutralSchedule(value.adBreaks)
  ) {
    return {
      ...value,
      adBreaks: [
        {
          id: "",
          startDelay: 0,
          preFetch: 0,
          adUnitId: "",
          adSources: [],
        },
      ],
    };
  }

  if (
    value.head.description === NAVER_WATERFALL_DESCRIPTION &&
    isChzzkLiveAdUnit(value.adUnit) &&
    isRecord(value.eventTracking) &&
    Number.isFinite(value.randomNumber) &&
    Array.isArray(value.ads) &&
    value.ads.length > 0
  ) {
    return { ...value, ads: [] };
  }

  return null;
}

function firstMeaningfulByteIsObject(bytes) {
  let index = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    index = 3;
  }
  while (
    index < bytes.length &&
    (bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d || bytes[index] === 0x20)
  ) {
    index += 1;
  }
  return bytes[index] === 0x7b;
}

function bytesInclude(bytes, marker) {
  const limit = Math.min(bytes.length, MAX_MARKER_SCAN_BYTES);
  if (marker.length === 0 || marker.length > limit) return false;
  const lastStart = limit - marker.length;
  outer: for (let start = 0; start <= lastStart; start += 1) {
    for (let index = 0; index < marker.length; index += 1) {
      if (bytes[start + index] !== marker[index]) continue outer;
    }
    return true;
  }
  return false;
}

export function rewriteChzzkAdResponseBytes(
  bytes,
  {
    decoder = new globalThis.TextDecoder("utf-8", { fatal: true }),
    encoder = new globalThis.TextEncoder(),
    parse = globalThis.JSON.parse,
    stringify = globalThis.JSON.stringify,
  } = {},
) {
  if (!bytes || bytes.byteLength === 0 || !firstMeaningfulByteIsObject(bytes)) return null;

  const scheduleMarker = encoder.encode(GFP_SCHEDULE_DESCRIPTION);
  const waterfallMarker = encoder.encode(NAVER_WATERFALL_DESCRIPTION);
  if (!bytesInclude(bytes, scheduleMarker) && !bytesInclude(bytes, waterfallMarker)) return null;

  try {
    const parsed = parse(decoder.decode(bytes));
    const sanitized = sanitizeChzzkAdResponse(parsed);
    return sanitized ? encoder.encode(stringify(sanitized)) : null;
  } catch {
    return null;
  }
}

export function createChzzkAdResponseController({
  documentRef = globalThis.document,
  globalRef = globalThis,
} = {}) {
  const OriginalUint8Array = globalRef.Uint8Array;
  const ProxyImpl = globalRef.Proxy;
  const ReflectImpl = globalRef.Reflect;
  const TextDecoderImpl = globalRef.TextDecoder;
  const TextEncoderImpl = globalRef.TextEncoder;
  const parse = globalRef.JSON?.parse?.bind(globalRef.JSON);
  const stringify = globalRef.JSON?.stringify?.bind(globalRef.JSON);
  let active = false;
  let styleElement = null;
  let wrappedUint8Array = null;

  function installStyle() {
    if (styleElement || typeof documentRef?.createElement !== "function") return;
    const parent = documentRef.head ?? documentRef.documentElement;
    if (!parent?.append) return;
    try {
      const style = documentRef.createElement("style");
      style.setAttribute(STYLE_ATTRIBUTE, "");
      style.textContent = AD_UI_STYLE;
      parent.append(style);
      styleElement = style;
    } catch {
      styleElement = null;
    }
  }

  function start() {
    if (active) return;
    active = true;
    installStyle();
    if (
      typeof OriginalUint8Array !== "function" ||
      typeof ProxyImpl !== "function" ||
      typeof ReflectImpl?.construct !== "function" ||
      typeof TextDecoderImpl !== "function" ||
      typeof TextEncoderImpl !== "function" ||
      typeof parse !== "function" ||
      typeof stringify !== "function"
    ) {
      return;
    }

    const decoder = new TextDecoderImpl("utf-8", { fatal: true });
    const encoder = new TextEncoderImpl();
    wrappedUint8Array = new ProxyImpl(OriginalUint8Array, {
      construct(target, args, newTarget) {
        const candidate = ReflectImpl.construct(target, args, newTarget);
        try {
          const replacement = rewriteChzzkAdResponseBytes(candidate, {
            decoder,
            encoder,
            parse,
            stringify,
          });
          return replacement ? ReflectImpl.construct(target, [replacement], newTarget) : candidate;
        } catch {
          return candidate;
        }
      },
    });

    try {
      globalRef.Uint8Array = wrappedUint8Array;
      if (globalRef.Uint8Array !== wrappedUint8Array) wrappedUint8Array = null;
    } catch {
      wrappedUint8Array = null;
    }
  }

  function stop() {
    if (!active) return;
    active = false;
    try {
      if (wrappedUint8Array && globalRef.Uint8Array === wrappedUint8Array) {
        globalRef.Uint8Array = OriginalUint8Array;
      }
    } catch {
      ignoreAdGuardFailure();
    }
    wrappedUint8Array = null;
    try {
      styleElement?.remove?.();
    } catch {
      ignoreAdGuardFailure();
    }
    styleElement = null;
  }

  return Object.freeze({ start, stop });
}

function replacePreviousController() {
  try {
    globalThis[CONTROLLER_SLOT]?.stop?.();
  } catch {
    ignoreAdGuardFailure();
  }
  const controller = createChzzkAdResponseController();
  try {
    Object.defineProperty(globalThis, CONTROLLER_SLOT, {
      configurable: true,
      value: controller,
    });
  } catch {
    ignoreAdGuardFailure();
  }
  controller.start();
}

if (typeof document !== "undefined") replacePreviousController();
