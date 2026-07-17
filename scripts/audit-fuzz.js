import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDiagnosticsSnapshot,
  normalizeDiagnostics,
  recordDecision,
  recordDiagnosticUrl,
} from "../src/shared/diagnostics.js";
import { isLikelyHlsPlaylist, isUtf8TextWithinByteLimit } from "../src/shared/playlist-evidence.js";
import {
  buildHighestQualityRedirectUrl,
  chooseBestHlsVariant,
  parseHlsMasterPlaylistVariants,
  parseQualitiesFromUrl,
  playlistFamilyKey,
  redactMediaUrl,
  replaceQualityInUrl,
  urlQualityMarkersAreSafe,
} from "../src/shared/quality.js";
import {
  hasContradictoryChzzkMetadata,
  isTrustedMasterPlaylistRequest,
  isTrustedRequestDomain,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
} from "../src/shared/request-policy.js";

const policy = JSON.parse(readFileSync(new URL("../policy/quality-policy.json", import.meta.url), "utf8"));

export const AUDIT_FUZZ_SEED = 0x5a17c0de;
export const AUDIT_FUZZ_CASE_COUNT = 100_000;
export const AUDIT_FUZZ_CATEGORY_COUNTS = Object.freeze({
  url_rewrites: 14_286,
  quality_markers: 14_286,
  playlist_families: 14_286,
  hls_master_parsing: 14_286,
  playlist_evidence: 14_286,
  request_policy: 14_285,
  diagnostics: 14_285,
});
export const AUDIT_FUZZ_LIMITS = Object.freeze({
  maxCases: AUDIT_FUZZ_CASE_COUNT,
  maxCollectionItems: 64,
  maxInputCharacters: 8192,
});

const CATEGORY_NAMES = Object.freeze(Object.keys(AUDIT_FUZZ_CATEGORY_COUNTS));
const QUALITY_NUMBERS = Object.freeze([144, 270, 360, 480, 540, 720, 900, 1080, 1440, 2160]);
const DIAGNOSTIC_TOP_LEVEL_KEYS = Object.freeze([
  "decisions",
  "generatedAt",
  "maxSamples",
  "qualities",
  "runtimeRedirects",
  "samples",
  "totalHlsRequests",
]);
const DIAGNOSTIC_RUNTIME_KEYS = Object.freeze(["activeTabIds", "lastError", "targetsByTab", "updatedAt"]);
const DIAGNOSTIC_SAMPLE_KEYS = Object.freeze(["quality", "seenAt", "tabId", "type", "url"]);
const DIAGNOSTIC_DECISION_KEYS = Object.freeze([
  "ok",
  "quality",
  "reason",
  "redirectedCurrentRequest",
  "seenAt",
  "tabId",
  "targetQuality",
  "type",
  "url",
]);
const RAW_TAIL_PIECES = Object.freeze([
  "A",
  "z",
  "0",
  "-",
  "_",
  ".",
  "~",
  "%00",
  "%2F",
  "%2f",
  "%23",
  "%25",
  "+",
  "=",
  "&",
  ";",
  ":",
  "@",
  "!",
  "$",
  "'",
  "(",
  ")",
  "*",
  ",",
  "/",
  "?",
]);

const defaultImplementation = Object.freeze({
  buildHighestQualityRedirectUrl,
  chooseBestHlsVariant,
  createDiagnosticsSnapshot,
  hasContradictoryChzzkMetadata,
  isLikelyHlsPlaylist,
  isTrustedMasterPlaylistRequest,
  isTrustedRequestDomain,
  isUtf8TextWithinByteLimit,
  normalizeDiagnostics,
  parseHlsMasterPlaylistVariants,
  parseQualitiesFromUrl,
  playlistFamilyKey,
  recordDecision,
  recordDiagnosticUrl,
  redactMediaUrl,
  replaceQualityInUrl,
  shouldRecordDiagnostics,
  shouldRedirectRequest,
  urlQualityMarkersAreSafe,
});

export class AuditFuzzFailure extends Error {
  constructor(message, { caseNumber, category, categoryCase, cause, seed }) {
    super(message, cause ? { cause } : undefined);
    this.name = "AuditFuzzFailure";
    this.code = "AUDIT_FUZZ_INVARIANT";
    this.seed = formatSeed(seed);
    this.caseNumber = caseNumber;
    this.category = category;
    this.categoryCase = categoryCase;
  }
}

function formatSeed(seed) {
  return `0x${seed.toString(16).padStart(8, "0")}`;
}

function createPrng(seed) {
  let state = seed >>> 0;
  const uint32 = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  return {
    bool() {
      return (uint32() & 1) === 1;
    },
    int(maxExclusive) {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
        throw new TypeError("PRNG bound must be a positive safe integer");
      }
      return uint32() % maxExclusive;
    },
    pick(values) {
      return values[this.int(values.length)];
    },
    uint32,
  };
}

function deriveCategorySeed(seed, category) {
  let derived = (seed ^ 0x811c9dc5) >>> 0;
  for (const character of category) {
    derived ^= character.codePointAt(0);
    derived = Math.imul(derived, 0x01000193) >>> 0;
  }
  return derived;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rawUrlTail(url) {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  return indexes.length === 0 ? "" : url.slice(Math.min(...indexes));
}

function randomHex(rng) {
  return rng.uint32().toString(16).padStart(8, "0");
}

function secretCanary(rng, index) {
  return `audit-canary-${index}-${randomHex(rng)}-${randomHex(rng)}`;
}

function randomRawTailBytes(rng) {
  const count = 5 + rng.int(12);
  let value = "";
  for (let index = 0; index < count; index += 1) value += rng.pick(RAW_TAIL_PIECES);
  return value;
}

function signedTail(rng, quality, secret) {
  return `?Policy=${secret}&bytes=${randomRawTailBytes(rng)}&next=%2F${quality}p%2F#${randomRawTailBytes(rng)}-${quality}p-${secret}`;
}

function trustedRequestHost(rng) {
  return `edge-${rng.int(4096)}.${rng.pick(["akamaized.net", "gscdn.net", "navercdn.com", "pstatic.net"])}`;
}

function genericTrustedRequestHost(rng) {
  return `generic-${rng.int(4096)}.${rng.pick(["gscdn.net", "navercdn.com", "pstatic.net"])}`;
}

function dedicatedRequestHost(rng) {
  return rng.bool()
    ? `node-${rng.int(4096)}.nvelop-livecloud.pstatic.net`
    : `node-${rng.int(4096)}.livecloud.pstatic.net.live.gscdn.net`;
}

function trustedDetails(url, tabId, overrides = {}) {
  return {
    documentUrl: "https://chzzk.naver.com/live/audit-channel",
    initiator: "https://chzzk.naver.com",
    method: "GET",
    originUrl: undefined,
    tabId,
    type: "media",
    url,
    ...overrides,
  };
}

function assertSuccessfulRewrite(context, url, targetQuality) {
  const { check, implementation, trackInput } = context;
  trackInput(url);
  const rewritten = implementation.replaceQualityInUrl(url, targetQuality);
  check(typeof rewritten === "string", "valid pathname rewrite returned no URL");
  check(rawUrlTail(rewritten) === rawUrlTail(url), "valid rewrite changed query or fragment bytes");
  const before = new URL(url);
  const after = new URL(rewritten);
  check(before.protocol === after.protocol, "valid rewrite changed the URL scheme");
  check(before.host === after.host, "valid rewrite changed URL authority");
  check(
    implementation.parseQualitiesFromUrl(rewritten).every((quality) => quality === targetQuality),
    "valid rewrite left a lower pathname quality marker",
  );
  check(
    implementation.buildHighestQualityRedirectUrl(url, { targetQuality }) === rewritten,
    "highest-quality rewrite disagreed with direct replacement",
  );
  return rewritten;
}

function runUrlRewriteCase(context) {
  const { check, implementation, index, rng, trackInput } = context;
  const scenario = index % 8;
  const targetIndex = 2 + rng.int(QUALITY_NUMBERS.length - 2);
  const target = QUALITY_NUMBERS[targetIndex];
  const current = QUALITY_NUMBERS[rng.int(targetIndex)];
  const host = trustedRequestHost(rng);
  const secret = secretCanary(rng, index);
  const tail = signedTail(rng, current, secret);
  const tabId = 1 + rng.int(100_000);

  if (scenario <= 2) {
    const pathname =
      scenario === 0
        ? `/chzzk/family-${rng.int(512)}/${current}p/segment/chunklist_${current}p.m3u8`
        : scenario === 1
          ? `/chzzk/family-${rng.int(512)}/chunklist_${current}p_variant.m3u8`
          : `/chzzk/family-${rng.int(512)}/${current}p/media/playlist.m3u8`;
    const url = `https://${host}${pathname}${tail}`;
    const decision = implementation.shouldRedirectRequest(trustedDetails(url, tabId), policy);
    check(decision.ok === true, "trusted valid HLS URL failed request policy");
    const rewritten = assertSuccessfulRewrite(context, url, `${target}p`);
    check(implementation.isTrustedRequestDomain(rewritten, policy), "rewrite escaped trusted domain");
    return;
  }

  if (scenario === 3 || scenario === 4) {
    const untrustedHost =
      scenario === 3
        ? `edge-${rng.int(4096)}.example.invalid`
        : `pstatic.net.${randomHex(rng)}.example.invalid`;
    const url = `https://${untrustedHost}/live/chunklist_${current}p.m3u8${tail}`;
    trackInput(url);
    const decision = implementation.shouldRedirectRequest(trustedDetails(url, tabId), policy);
    check(decision.ok === false, "untrusted or suffix-confusion host passed request policy");
    check(decision.reason === "untrusted-request-domain", "untrusted host produced the wrong veto");
    const rewritten = implementation.replaceQualityInUrl(url, `${target}p`);
    if (rewritten !== null) {
      check(rawUrlTail(rewritten) === tail, "untrusted path rewrite changed signed tail bytes");
      check(
        !implementation.isTrustedRequestDomain(rewritten, policy),
        "rewrite made an untrusted host trusted",
      );
    }
    return;
  }

  if (scenario === 5) {
    const malformed = rng.pick([
      `not-a-url/live/chunklist_${current}p.m3u8${tail}`,
      `https://[::1/live/chunklist_${current}p.m3u8${tail}`,
      `https://${host}:99999/live/chunklist_${current}p.m3u8${tail}`,
      `https://bad host.invalid/live/chunklist_${current}p.m3u8${tail}`,
      `://missing-scheme/live/chunklist_${current}p.m3u8${tail}`,
    ]);
    trackInput(malformed);
    check(implementation.replaceQualityInUrl(malformed, `${target}p`) === null, "malformed URL rewrote");
    check(
      implementation.shouldRedirectRequest(trustedDetails(malformed, tabId), policy).ok === false,
      "malformed HLS URL passed request policy",
    );
    return;
  }

  if (scenario === 6) {
    const url = `http://${host}/live/chunklist_${current}p.m3u8${tail}`;
    trackInput(url);
    const decision = implementation.shouldRedirectRequest(trustedDetails(url, tabId), policy);
    check(decision.ok === false, "non-HTTPS playlist passed request policy");
    check(decision.reason === "non-https-request-url", "non-HTTPS playlist produced wrong veto");
    const rewritten = implementation.replaceQualityInUrl(url, `${target}p`);
    if (rewritten !== null) {
      check(rawUrlTail(rewritten) === tail, "path helper changed a non-HTTPS signed tail");
    }
    return;
  }

  const url = `https://${host}/live/${current}p/segment.ts${tail}`;
  trackInput(url);
  const decision = implementation.shouldRedirectRequest(trustedDetails(url, tabId), policy);
  check(decision.ok === false, "non-playlist media URL passed request policy");
  check(decision.reason === "non-playlist-path", "non-playlist URL produced wrong veto");
}

function runQualityMarkerCase(context) {
  const { check, implementation, index, rng, trackInput } = context;
  const scenario = index % 8;
  const first = rng.pick(QUALITY_NUMBERS);
  let markers;
  if (scenario === 0) markers = [first, first];
  if (scenario === 1) markers = [360, 480];
  if (scenario === 2) {
    let second = rng.pick(QUALITY_NUMBERS);
    while (second === first || (first === 360 && second === 480)) second = rng.pick(QUALITY_NUMBERS);
    markers = [first, second];
  }
  if (scenario === 3) markers = [first, first, first === 2160 ? 1440 : 2160];
  if (scenario === 4) markers = [480, 360];
  if (scenario === 5) markers = [first];
  if (scenario === 6) markers = [rng.pick([1080, 1440]), 2160];
  if (scenario === 7) markers = [first, first, first];

  const directoryMarkers = markers
    .slice(0, -1)
    .map((quality) => `${quality}p`)
    .join("/");
  const filenameQuality = markers.at(-1);
  const secret = secretCanary(rng, index);
  const url = `https://edge.pstatic.net/family/${directoryMarkers ? `${directoryMarkers}/` : ""}segment/chunklist_${filenameQuality}p.m3u8${signedTail(rng, filenameQuality, secret)}`;
  trackInput(url);
  check(
    arraysEqual(
      implementation.parseQualitiesFromUrl(url),
      markers.map((quality) => `${quality}p`),
    ),
    "quality markers were not parsed in pathname order",
  );
  const expectedSafe =
    markers.length <= 1 ||
    markers.every((quality) => quality === markers[0]) ||
    (markers.length === 2 && markers[0] === 360 && markers[1] === 480);
  check(
    implementation.urlQualityMarkersAreSafe(url) === expectedSafe,
    "quality-marker safety diverged from documented forms",
  );

  if (expectedSafe) {
    const rewritten = implementation.replaceQualityInUrl(url, "4320p");
    check(typeof rewritten === "string", "safe lower marker shape did not rewrite");
    check(rawUrlTail(rewritten) === rawUrlTail(url), "marker rewrite changed signed tail bytes");
    check(
      implementation.parseQualitiesFromUrl(rewritten).every((quality) => quality === "4320p"),
      "safe marker shape was not rewritten consistently",
    );
    check(
      implementation.shouldRedirectRequest(trustedDetails(url, 1 + rng.int(100_000)), policy).ok === true,
      "safe marker shape failed request policy",
    );
  } else {
    check(implementation.replaceQualityInUrl(url, "4320p") === null, "ambiguous marker shape rewrote");
    check(
      implementation.buildHighestQualityRedirectUrl(url, { targetQuality: "4320p" }) === null,
      "ambiguous marker shape built a redirect",
    );
    const decision = implementation.shouldRedirectRequest(trustedDetails(url, 1 + rng.int(100_000)), policy);
    check(decision.ok === false, "ambiguous marker shape passed request policy");
    check(decision.reason === "contradictory-quality-markers", "ambiguous marker veto was not explicit");
  }
}

function familyUrl({
  discriminator = "",
  host,
  quality,
  session,
  signedDirectory = "",
  signedFile = "",
  tail,
}) {
  const directory = signedDirectory ? `${signedDirectory}/` : "";
  return `https://${host}/chzzk/${session}/${directory}${quality}p/segment/chunklist_${quality}p${discriminator}.m3u8${signedFile}${tail}`;
}

function assertSecretFreeFamily(context, url, secret) {
  const { check, implementation, trackInput } = context;
  trackInput(url);
  const key = implementation.playlistFamilyKey(url);
  check(typeof key === "string", "valid playlist URL produced no family key");
  check(!key.includes(secret), "playlist family retained a signed secret canary");
  const parsed = JSON.parse(key);
  check(Array.isArray(parsed) && parsed.length === 3, "playlist family key schema changed");
  return key;
}

function runPlaylistFamilyCase(context) {
  const { check, implementation, index, rng, trackInput } = context;
  const scenario = index % 8;
  const host = `edge-${rng.int(1024)}.pstatic.net`;
  const session = `family-${rng.int(4096)}`;
  const quality = rng.pick(QUALITY_NUMBERS);
  const otherQuality = rng.pick(QUALITY_NUMBERS.filter((candidate) => candidate !== quality));
  const secret = secretCanary(rng, index);
  const base = familyUrl({
    host,
    quality,
    session,
    tail: `?Policy=${secret}#${secret}`,
  });
  const baseKey = assertSecretFreeFamily(context, base, secret);

  if (scenario === 0) {
    const alternate = familyUrl({
      host,
      quality: otherQuality,
      session,
      tail: `?Signature=${secret}-alternate#${secret}-alternate`,
    });
    check(baseKey === assertSecretFreeFamily(context, alternate, secret), "quality split one family");
  } else if (scenario === 1) {
    const alternate = familyUrl({
      host,
      quality,
      session: `${session}-independent`,
      tail: `?Policy=${secret}`,
    });
    check(baseKey !== assertSecretFreeFamily(context, alternate, secret), "independent roots shared key");
  } else if (scenario === 2) {
    const ad = familyUrl({
      discriminator: "_ad",
      host,
      quality,
      session,
      tail: `?Policy=${secret}`,
    });
    const dvr = familyUrl({
      discriminator: "_dvr",
      host,
      quality: otherQuality,
      session,
      tail: `?Policy=${secret}`,
    });
    const adKey = assertSecretFreeFamily(context, ad, secret);
    check(baseKey !== adKey, "ad playlist shared the main family key");
    check(adKey !== assertSecretFreeFamily(context, dvr, secret), "ad and DVR families collided");
  } else if (scenario === 3) {
    const signedDirectory = rng.bool() ? `hdntl=${secret}` : `hdntl%3D${secret}`;
    const alternate = familyUrl({
      host,
      quality: otherQuality,
      session,
      signedDirectory,
      tail: `?Signature=${secret}`,
    });
    check(
      baseKey === assertSecretFreeFamily(context, alternate, secret),
      "signed directory tail changed family identity",
    );
  } else if (scenario === 4) {
    const alternate = familyUrl({
      host,
      quality: otherQuality,
      session,
      signedFile: `;hdntl=${secret}`,
      tail: "",
    });
    check(
      baseKey === assertSecretFreeFamily(context, alternate, secret),
      "signed playlist-name tail changed family identity",
    );
  } else if (scenario === 5) {
    const alternate = familyUrl({
      host: `other-${rng.int(1024)}.pstatic.net`,
      quality,
      session,
      tail: `?Policy=${secret}`,
    });
    check(
      baseKey !== assertSecretFreeFamily(context, alternate, secret),
      "different hosts shared family key",
    );
  } else if (scenario === 6) {
    const malformed = rng.bool()
      ? `https://${host}/${"a".repeat(4097)}/chunklist_${quality}p.m3u8`
      : `https://${host}/${Array.from({ length: 65 }, (_, segment) => `s${segment}`).join("/")}/chunklist_${quality}p.m3u8`;
    trackInput(malformed);
    check(implementation.playlistFamilyKey(malformed) === null, "oversized family input was retained");
  } else {
    const delimiterRoot = familyUrl({
      host,
      quality,
      session: `${session}::ad`,
      tail: `?Policy=${secret}`,
    });
    const ad = familyUrl({
      discriminator: "_ad",
      host,
      quality,
      session,
      tail: `?Policy=${secret}`,
    });
    check(
      assertSecretFreeFamily(context, delimiterRoot, secret) !== assertSecretFreeFamily(context, ad, secret),
      "serialized family components collided",
    );
  }

  const canonicalDomain = rng.pick(["akamaized.net", "gscdn.net", "navercdn.com", "pstatic.net"]);
  const diagnosticHost = rng.bool() ? `${secret}.edge.${canonicalDomain}` : `${secret}.example.invalid`;
  const expectedHost = diagnosticHost.endsWith(`.${canonicalDomain}`)
    ? canonicalDomain
    : "other-media.invalid";
  const sensitiveUrl = `https://${secret}:${secret}@${diagnosticHost}:8443/private/${secret}/${quality}p/segment/chunklist_${quality}p.m3u8?Policy=${secret}#${secret}`;
  trackInput(sensitiveUrl);
  const redacted = implementation.redactMediaUrl(sensitiveUrl);
  check(
    redacted === `https://${expectedHost}/[redacted-path]/${quality}p.m3u8?[redacted]`,
    "diagnostic URL did not use a canonical host label",
  );
  check(!redacted.includes(secret), "diagnostic URL retained a high-entropy canary");
  check(!redacted.includes("8443"), "diagnostic URL retained a port");
}

function assertVariantsBounded(context, variants) {
  const { check, trackCollection } = context;
  trackCollection(variants);
  check(Array.isArray(variants), "HLS parser returned a non-array");
  for (const variant of variants) {
    check(
      Number.isSafeInteger(variant.bandwidth) && variant.bandwidth > 0 && variant.bandwidth <= 1_000_000_000,
      "HLS parser retained invalid bandwidth",
    );
    check(
      variant.averageBandwidth === null ||
        (Number.isSafeInteger(variant.averageBandwidth) &&
          variant.averageBandwidth > 0 &&
          variant.averageBandwidth <= 1_000_000_000),
      "HLS parser retained invalid average bandwidth",
    );
    check(
      variant.frameRate === null ||
        (Number.isFinite(variant.frameRate) && variant.frameRate > 0 && variant.frameRate <= 240),
      "HLS parser retained invalid frame rate",
    );
    check(typeof variant.url === "string", "HLS variant URL was not a string");
  }
}

function runHlsMasterParsingCase(context) {
  const { check, implementation, index, rng, trackInput } = context;
  const scenario = index % 10;
  const height = rng.pick([360, 480, 720, 1080, 1440, 2160]);
  const width = Math.round((height * 16) / 9);
  const bandwidth = 1 + rng.int(1_000_000_000);
  const frameText = `${1 + rng.int(239)}.${String(rng.int(1000)).padStart(3, "0")}`;
  const baseUrl = `https://edge.pstatic.net/family-${rng.int(1024)}/master.m3u8`;
  let playlist;
  let expectedCount = null;

  if (scenario === 0) {
    playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${Math.max(1, bandwidth - 1)},RESOLUTION=${width}x${height},FRAME-RATE=${frameText},CODECS="avc1.4d401f,mp4a.40.2"\nchunklist_${height}p_main.m3u8?Policy=audit`;
    expectedCount = 1;
  } else if (scenario === 1) {
    playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},bandwidth=${bandwidth + 1},RESOLUTION=${width}x${height}\nchunklist_${height}p.m3u8`;
    expectedCount = 0;
  } else if (scenario === 2) {
    const invalid = rng.pick(["0", "-1", "+1", "0x10", "1e6", ".5", "1000000001"]);
    playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${invalid},RESOLUTION=${width}x${height}\nchunklist_${height}p.m3u8`;
    expectedCount = 0;
  } else if (scenario === 3) {
    const attribute = rng.bool() ? "AVERAGE-BANDWIDTH" : "FRAME-RATE";
    const invalid =
      attribute === "FRAME-RATE"
        ? rng.pick(["0", "-1", "+60", "0x3c", "6e1", ".5", "240.01"])
        : rng.pick(["0", "-1", "0x10", "1e3", "1000000001"]);
    playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},${attribute}=${invalid},RESOLUTION=${width}x${height}\nchunklist_${height}p.m3u8`;
    expectedCount = 0;
  } else if (scenario === 4) {
    const malformedQuoted = rng.pick([
      `CODECS="avc1,mp4a`,
      `CODECS=avc"1`,
      `NAME="unterminated,RESOLUTION=${width}x${height}`,
    ]);
    playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},${malformedQuoted}\nchunklist_${height}p.m3u8`;
    expectedCount = 0;
  } else if (scenario === 5) {
    playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height}\n#EXT-X-DISCONTINUITY\nchunklist_${height}p.m3u8`;
    expectedCount = 0;
  } else if (scenario === 6) {
    playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,FRAME-RATE=30.0
chunklist_1080p_slow.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4200000,AVERAGE-BANDWIDTH=4000000,RESOLUTION=1920x1080,FRAME-RATE=60.0
chunklist_1080p_fast.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=999999999,RESOLUTION=1280x720,FRAME-RATE=120.0
chunklist_720p.m3u8`;
    expectedCount = 3;
  } else if (scenario === 7) {
    const noise = Array.from({ length: 1 + rng.int(8) }, () =>
      rng.pick([
        "garbage",
        "#EXT-X-STREAM-INF:",
        "#EXT-X-STREAM-INF:BANDWIDTH=not-decimal",
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="broken`,
        `uri-${randomHex(rng)}`,
        '\u0000\u0001,="',
      ]),
    );
    playlist = noise.join(rng.bool() ? "\n" : "\r\n");
  } else if (scenario === 8) {
    playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000001,RESOLUTION=3840x2160,FRAME-RATE=240.01
chunklist_2160p_invalid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000000,AVERAGE-BANDWIDTH=999999999,RESOLUTION=1920x1080,FRAME-RATE=240.0
chunklist_1080p_valid.m3u8`;
    expectedCount = 1;
  } else {
    playlist = `#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},CODECS="avc1.${rng.int(100)},mp4a.40.2",NAME="audit=${randomHex(rng)},main"\r\nvariant_${height}p.m3u8`;
    expectedCount = 1;
  }

  trackInput(playlist, baseUrl);
  const variants = implementation.parseHlsMasterPlaylistVariants(playlist, baseUrl);
  assertVariantsBounded(context, variants);
  if (expectedCount !== null) check(variants.length === expectedCount, "HLS malformed/valid count changed");
  if (scenario === 0 && variants.length === 1) {
    check(variants[0].bandwidth === bandwidth, "valid decimal bandwidth changed");
    check(variants[0].frameRate === Number(frameText), "valid decimal frame rate changed");
    check(variants[0].quality === `${height}p`, "valid resolution quality changed");
  }
  if (scenario === 6) {
    const best = implementation.chooseBestHlsVariant(playlist, baseUrl);
    check(best?.url.endsWith("chunklist_1080p_fast.m3u8"), "variant scoring order changed");
  }
  if (scenario === 7) {
    const best = implementation.chooseBestHlsVariant(playlist, baseUrl);
    check(
      best === null || variants.some((variant) => variant.url === best.url),
      "best variant was not parsed",
    );
  }
}

function runPlaylistEvidenceCase(context) {
  const { check, implementation, index, rng, trackInput } = context;
  const scenario = index % 10;
  let text;
  let expectedHeader;
  if (scenario === 0) {
    text = `\uFEFF${rng.bool() ? " \t\r\n\r\n  " : "\n"}#EXTM3U\r\n#EXT-X-VERSION:3`;
    expectedHeader = true;
  } else if (scenario === 1) {
    text = `<!doctype html>\n#EXTM3U\n${randomHex(rng)}`;
    expectedHeader = false;
  } else if (scenario === 2) {
    text = `# audit-comment-${randomHex(rng)}\n#EXTM3U`;
    expectedHeader = false;
  } else if (scenario === 3) {
    text = `  #EXTM3U  ${rng.bool() ? "\r\n" : "\n"}#EXT-X-VERSION:3`;
    expectedHeader = true;
  } else if (scenario === 4) {
    text = rng.pick(["#extm3u", "#EXTM3U extra", "x#EXTM3U", "#EXTM3U\u0000"]);
    expectedHeader = false;
  } else if (scenario === 5) {
    text = rng.pick(["", " \t\r\n ", null, undefined]);
    expectedHeader = false;
  } else if (scenario === 6) {
    text = `#EXTM3U\n${"é".repeat(1 + rng.int(256))}`;
    expectedHeader = true;
  } else if (scenario === 7) {
    text = `#EXTM3U\n${"가".repeat(1 + rng.int(512))}`;
    expectedHeader = true;
  } else if (scenario === 8) {
    text = `${rng.bool() ? "\r\n\r\n" : "\n"}\t#EXTM3U\t\r#EXT-X-ENDLIST`;
    expectedHeader = true;
  } else {
    text = `#EXTM3U\n${rng.bool() ? "😀" : "\ud800"}${randomHex(rng)}`;
    expectedHeader = true;
  }

  const normalizedText = String(text ?? "");
  trackInput(normalizedText);
  check(
    implementation.isLikelyHlsPlaylist(text) === expectedHeader,
    "first-meaningful-line EXTM3U classification changed",
  );
  const expectedBytes = Buffer.byteLength(normalizedText, "utf8");
  const limits = new Set([Math.max(0, expectedBytes - 1), expectedBytes, expectedBytes + 1]);
  for (const limit of limits) {
    check(
      implementation.isUtf8TextWithinByteLimit(text, limit) === expectedBytes <= limit,
      "UTF-8 byte cap used a non-byte length",
    );
  }
  check(
    implementation.isUtf8TextWithinByteLimit(text, Number.NaN) === false,
    "invalid UTF-8 byte limit failed open",
  );
}

function policyUrl(host, quality, secret, { mixed = false, playlist = true, protocol = "https:" } = {}) {
  const pathname = playlist
    ? mixed
      ? `/live/1080p/segment/chunklist_2160p.m3u8`
      : `/live/${quality}p/segment/chunklist_${quality}p.m3u8`
    : `/live/${quality}p/segment.ts`;
  return `${protocol}//${host}${pathname}?Policy=${secret}#${secret}`;
}

function runRequestPolicyCase(context) {
  const { check, implementation, index, rng, trackInput } = context;
  const scenario = index % 12;
  const quality = rng.pick(QUALITY_NUMBERS);
  const tabId = 1 + rng.int(100_000);
  const secret = secretCanary(rng, index);
  const genericUrl = policyUrl(genericTrustedRequestHost(rng), quality, secret);
  const cachedTrust = { trustedLiveTabIds: new Set([tabId]) };
  const metadataFree = trustedDetails(genericUrl, tabId, {
    documentUrl: undefined,
    initiator: undefined,
    originUrl: undefined,
  });
  trackInput(genericUrl);

  if (scenario === 0) {
    const decision = implementation.shouldRedirectRequest(trustedDetails(genericUrl, tabId), policy);
    check(decision.ok === true, "trusted live metadata did not authorize generic CDN");
    check(
      implementation.shouldRecordDiagnostics(trustedDetails(genericUrl, tabId), policy),
      "trusted request not diagnosed",
    );
  } else if (scenario === 1) {
    check(
      implementation.shouldRedirectRequest(metadataFree, policy, cachedTrust).ok === true,
      "metadata-free cached live tab failed closed",
    );
  } else if (scenario === 2) {
    check(
      implementation.shouldRedirectRequest(metadataFree, policy).ok === false,
      "metadata-free generic CDN request passed without cached trust",
    );
    check(
      !implementation.shouldRecordDiagnostics(metadataFree, policy),
      "untrusted generic request was diagnosed",
    );
  } else if (scenario === 3) {
    const field = rng.pick(["documentUrl", "originUrl", "initiator"]);
    const contradicted = { ...metadataFree, [field]: "https://foreign.example.invalid/watch" };
    check(
      implementation.hasContradictoryChzzkMetadata(contradicted, policy),
      "foreign request metadata was not veto evidence",
    );
    check(
      implementation.shouldRedirectRequest(contradicted, policy, cachedTrust).ok === false,
      "foreign document did not veto cached trust",
    );
    check(
      !implementation.shouldRecordDiagnostics(contradicted, policy, cachedTrust),
      "vetoed request was diagnosed",
    );
  } else if (scenario === 4) {
    const contradicted = trustedDetails(genericUrl, tabId, {
      originUrl: "https://foreign.example.invalid/watch",
    });
    check(implementation.hasContradictoryChzzkMetadata(contradicted, policy), "mixed metadata lacked veto");
    check(
      implementation.shouldRedirectRequest(contradicted, policy, cachedTrust).ok === false,
      "mixed trusted/foreign metadata passed",
    );
  } else if (scenario === 5 || scenario === 6) {
    const dedicatedUrl = policyUrl(dedicatedRequestHost(rng), quality, secret);
    const details = trustedDetails(dedicatedUrl, tabId, {
      documentUrl: scenario === 6 ? "https://foreign.example.invalid/watch" : undefined,
      initiator: undefined,
      originUrl: undefined,
    });
    trackInput(dedicatedUrl);
    check(
      implementation.shouldRedirectRequest(details, policy).ok === (scenario === 5),
      "dedicated-host fallback ignored metadata boundary",
    );
  } else if (scenario === 7) {
    const mutation = rng.int(6);
    const expectedReasons = [
      "non-https-request-url",
      "unsupported-request-method",
      "unsupported-resource-type",
      "invalid-tab",
      "untrusted-request-domain",
      "non-playlist-path",
    ];
    const details = trustedDetails(genericUrl, tabId);
    if (mutation === 0)
      details.url = policyUrl(genericTrustedRequestHost(rng), quality, secret, { protocol: "http:" });
    if (mutation === 1) details.method = "POST";
    if (mutation === 2) details.type = "script";
    if (mutation === 3) details.tabId = -1;
    if (mutation === 4) details.url = policyUrl("edge.example.invalid", quality, secret);
    if (mutation === 5)
      details.url = policyUrl(genericTrustedRequestHost(rng), quality, secret, { playlist: false });
    trackInput(details.url);
    const decision = implementation.shouldRedirectRequest(details, policy);
    check(decision.ok === false, "request-policy veto matrix passed");
    check(decision.reason === expectedReasons[mutation], "request-policy veto reason changed");
  } else if (scenario === 8) {
    const master = trustedDetails(
      `https://${genericTrustedRequestHost(rng)}/live/master.m3u8?Policy=${secret}`,
      tabId,
      { type: "xmlhttprequest" },
    );
    trackInput(master.url);
    check(implementation.isTrustedMasterPlaylistRequest(master, policy), "trusted master was rejected");
    check(
      !implementation.isTrustedMasterPlaylistRequest(
        { ...master, documentUrl: "https://foreign.example.invalid/watch" },
        policy,
        cachedTrust,
      ),
      "foreign master metadata did not veto cached trust",
    );
  } else if (scenario === 9) {
    const blankGeneric = { ...metadataFree, documentUrl: "" };
    const dedicated = {
      ...blankGeneric,
      url: policyUrl(dedicatedRequestHost(rng), quality, secret),
    };
    trackInput(dedicated.url);
    check(
      implementation.shouldRedirectRequest(blankGeneric, policy, cachedTrust).ok === false,
      "blank explicit metadata used cached generic trust",
    );
    check(
      implementation.shouldRedirectRequest(dedicated, policy, cachedTrust).ok === false,
      "blank explicit metadata used dedicated fallback",
    );
  } else if (scenario === 10) {
    const suffixConfusion = policyUrl(
      `nvelop-livecloud.pstatic.net.${randomHex(rng)}.example.invalid`,
      quality,
      secret,
    );
    trackInput(suffixConfusion);
    check(
      implementation.shouldRedirectRequest({ ...metadataFree, url: suffixConfusion }, policy).ok === false,
      "dedicated-host suffix confusion passed",
    );
  } else {
    const mixed = policyUrl(genericTrustedRequestHost(rng), quality, secret, { mixed: true });
    trackInput(mixed);
    const decision = implementation.shouldRedirectRequest(trustedDetails(mixed, tabId), policy);
    check(decision.ok === false, "mixed quality markers passed request policy");
    check(decision.reason === "contradictory-quality-markers", "mixed marker veto reason changed");
  }
}

function assertExactDiagnosticsSchema(context, snapshot, secret) {
  const { check, trackCollection } = context;
  check(
    arraysEqual(Object.keys(snapshot), DIAGNOSTIC_TOP_LEVEL_KEYS),
    "diagnostics top-level schema was not exact",
  );
  check(
    arraysEqual(Object.keys(snapshot.runtimeRedirects), DIAGNOSTIC_RUNTIME_KEYS),
    "diagnostics runtime schema was not exact",
  );
  check(
    Number.isSafeInteger(snapshot.maxSamples) && snapshot.maxSamples > 0 && snapshot.maxSamples <= 1000,
    "diagnostics maxSamples escaped hard bounds",
  );
  check(
    Number.isSafeInteger(snapshot.totalHlsRequests) && snapshot.totalHlsRequests >= 0,
    "diagnostics total counter was not normalized",
  );
  trackCollection(snapshot.samples, snapshot.decisions, snapshot.runtimeRedirects.activeTabIds);
  check(snapshot.samples.length <= snapshot.maxSamples, "diagnostic samples exceeded maxSamples");
  check(snapshot.decisions.length <= snapshot.maxSamples, "diagnostic decisions exceeded maxSamples");
  check(
    snapshot.runtimeRedirects.activeTabIds.length <= snapshot.maxSamples,
    "diagnostic active tabs exceeded maxSamples",
  );
  for (const sample of snapshot.samples) {
    check(arraysEqual(Object.keys(sample), DIAGNOSTIC_SAMPLE_KEYS), "diagnostic sample schema was not exact");
  }
  for (const decision of snapshot.decisions) {
    check(
      arraysEqual(Object.keys(decision), DIAGNOSTIC_DECISION_KEYS),
      "diagnostic decision schema was not exact",
    );
  }
  for (const count of Object.values(snapshot.qualities)) {
    check(Number.isSafeInteger(count) && count >= 0, "diagnostic quality counter was not bounded");
  }
  check(Object.keys(snapshot.qualities).length <= 64, "diagnostic quality counters were not bounded");
  check(
    Object.keys(snapshot.runtimeRedirects.targetsByTab).length <= snapshot.maxSamples,
    "diagnostic target map exceeded maxSamples",
  );
  for (const url of [
    ...snapshot.samples.map((sample) => sample.url),
    ...snapshot.decisions.map((decision) => decision.url),
  ]) {
    check(
      /^https:\/\/(?:akamaized\.net|gscdn\.net|navercdn\.com|pstatic\.net|other-media\.invalid)\/\[redacted-path\]/.test(
        url,
      ),
      "diagnostic URL retained a non-canonical host",
    );
    check(!url.includes(":8443"), "diagnostic URL retained a media port");
  }
  const serialized = JSON.stringify(snapshot);
  check(!serialized.includes(secret), "normalized diagnostics retained a generated secret canary");
}

function runDiagnosticsCase(context) {
  const { check, implementation, index, rng, trackCollection, trackInput } = context;
  const policyMaxSamples = 1 + rng.int(8);
  const quality = rng.pick(QUALITY_NUMBERS);
  const secret = secretCanary(rng, index);
  const tabId = 1 + rng.int(100_000);
  const timestamp = new Date(1_700_000_000_000 + index * 1000).toISOString();
  const canonicalDomain = rng.pick(["akamaized.net", "gscdn.net", "navercdn.com", "pstatic.net"]);
  const host = index % 5 === 0 ? `${secret}.example.invalid` : `${secret}.edge.${canonicalDomain}`;
  const sensitiveUrl = `https://${secret}:${secret}@${host}:8443/private/${secret}/${quality}p/segment/chunklist_${quality}p.m3u8?Policy=${secret}#${secret}`;
  const validSample = {
    extra: secret,
    quality: `${quality}p`,
    seenAt: timestamp,
    tabId,
    type: "media",
    url: sensitiveUrl,
  };
  const validDecision = {
    extra: secret,
    ok: true,
    quality: `${quality}p`,
    reason: "eligible-chzzk-hls-quality",
    redirectedCurrentRequest: false,
    seenAt: timestamp,
    tabId,
    targetQuality: "2160p",
    type: "xmlhttprequest",
    url: sensitiveUrl,
  };
  const arrayLength = policyMaxSamples + 4;
  const samples = Array.from({ length: arrayLength }, (_, entry) =>
    entry % 4 === 3 ? { ...validSample, quality: [] } : { ...validSample },
  );
  const decisions = Array.from({ length: arrayLength }, (_, entry) =>
    entry % 5 === 4 ? { ...validDecision, ok: "true" } : { ...validDecision },
  );
  trackInput(sensitiveUrl);
  trackCollection(samples, decisions);

  const sourceMaxSamples =
    index % 3 === 0 ? Number.MAX_SAFE_INTEGER : index % 3 === 1 ? 1 + rng.int(policyMaxSamples) : "huge";
  const source = {
    decisions,
    generatedAt: index % 2 === 0 ? timestamp : "invalid-date",
    maxSamples: sourceMaxSamples,
    qualities: {
      [`${quality}p`]: index % 4 === 0 ? Number.MAX_SAFE_INTEGER : 1 + rng.int(1000),
      "1080p": -1,
      "1440p": "7",
      [secret]: 99,
    },
    runtimeRedirects: {
      activeTabIds: [tabId, tabId, -1, "7", Number.MAX_SAFE_INTEGER],
      extra: secret,
      lastError: `fetch failed ${sensitiveUrl}`,
      targetsByTab: { [tabId]: `${quality}p`, bad: secret },
      updatedAt: index % 2 === 0 ? timestamp : "invalid-date",
    },
    samples,
    totalHlsRequests:
      index % 4 === 0
        ? Number.MAX_SAFE_INTEGER
        : index % 4 === 1
          ? "7"
          : index % 4 === 2
            ? -1
            : rng.int(1000),
    unknownTopLevel: secret,
  };

  const normalized = implementation.normalizeDiagnostics(source, { maxSamples: policyMaxSamples });
  check(normalized.maxSamples <= policyMaxSamples, "persisted maxSamples exceeded policy bound");
  implementation.recordDiagnosticUrl(normalized, sensitiveUrl, {
    context: { tabId, type: "media" },
    now: new Date(timestamp),
  });
  implementation.recordDecision(
    normalized,
    {
      ok: true,
      quality: `${quality}p`,
      reason: "eligible-chzzk-hls-quality",
      redirectedCurrentRequest: false,
      tabId,
      targetQuality: "2160p",
    },
    { tabId, type: "media", url: sensitiveUrl },
    { now: new Date(timestamp) },
  );
  const snapshot = implementation.createDiagnosticsSnapshot(normalized);
  assertExactDiagnosticsSchema(context, snapshot, secret);
  check(
    snapshot.runtimeRedirects.lastError === null || snapshot.runtimeRedirects.lastError === "runtime-error",
    "runtime diagnostic error retained arbitrary text",
  );
}

const categoryRunners = Object.freeze({
  url_rewrites: runUrlRewriteCase,
  quality_markers: runQualityMarkerCase,
  playlist_families: runPlaylistFamilyCase,
  hls_master_parsing: runHlsMasterParsingCase,
  playlist_evidence: runPlaylistEvidenceCase,
  request_policy: runRequestPolicyCase,
  diagnostics: runDiagnosticsCase,
});

function validatedCounts(categoryCounts) {
  if (!categoryCounts || typeof categoryCounts !== "object" || Array.isArray(categoryCounts)) {
    throw new TypeError("audit fuzz category counts must be an object");
  }
  if (!arraysEqual(Object.keys(categoryCounts), CATEGORY_NAMES)) {
    throw new TypeError("audit fuzz category names or order do not match the contract");
  }
  const counts = {};
  let total = 0;
  for (const category of CATEGORY_NAMES) {
    const count = categoryCounts[category];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`audit fuzz count for ${category} must be a non-negative safe integer`);
    }
    counts[category] = count;
    total += count;
  }
  if (total <= 0 || total > AUDIT_FUZZ_LIMITS.maxCases) {
    throw new RangeError(`audit fuzz total must be between 1 and ${AUDIT_FUZZ_LIMITS.maxCases}`);
  }
  return { counts, total };
}

function resolvedImplementation(overrides) {
  if (!overrides) return defaultImplementation;
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("audit fuzz implementation overrides must be an object");
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(defaultImplementation, name) || typeof value !== "function") {
      throw new TypeError(`invalid audit fuzz implementation override: ${name}`);
    }
  }
  return Object.freeze({ ...defaultImplementation, ...overrides });
}

export function runAuditFuzz({
  categoryCounts = AUDIT_FUZZ_CATEGORY_COUNTS,
  implementation: implementationOverrides,
  seed = AUDIT_FUZZ_SEED,
} = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError("audit fuzz seed must be an unsigned 32-bit integer");
  }
  const { counts, total } = validatedCounts(categoryCounts);
  const implementation = resolvedImplementation(implementationOverrides);
  let assertionCount = 0;
  let caseNumber = 0;
  let maxInputCharacters = 0;

  for (const category of CATEGORY_NAMES) {
    const runner = categoryRunners[category];
    const rng = createPrng(deriveCategorySeed(seed, category));
    for (let index = 0; index < counts[category]; index += 1) {
      caseNumber += 1;
      const metadata = {
        caseNumber,
        category,
        categoryCase: index + 1,
        seed,
      };
      const check = (condition, message) => {
        assertionCount += 1;
        if (!condition) throw new AuditFuzzFailure(message, metadata);
      };
      const trackInput = (...values) => {
        for (const value of values) {
          const length = String(value ?? "").length;
          maxInputCharacters = Math.max(maxInputCharacters, length);
          check(length <= AUDIT_FUZZ_LIMITS.maxInputCharacters, "generated input exceeded character bound");
        }
      };
      const trackCollection = (...values) => {
        for (const value of values) {
          check(Array.isArray(value), "generated collection was not an array");
          check(
            value.length <= AUDIT_FUZZ_LIMITS.maxCollectionItems,
            "generated collection exceeded item bound",
          );
        }
      };
      try {
        runner({
          check,
          implementation,
          index,
          rng,
          trackCollection,
          trackInput,
        });
      } catch (error) {
        if (error instanceof AuditFuzzFailure) throw error;
        throw new AuditFuzzFailure(`uncaught ${error?.name ?? "error"} in audit fuzz case`, {
          ...metadata,
          cause: error,
        });
      }
    }
  }

  if (caseNumber !== total) throw new Error("audit fuzz internal case-count mismatch");
  return {
    seed: formatSeed(seed),
    caseCount: caseNumber,
    assertionCount,
    categories: counts,
    maxInputCharacters,
  };
}

function printFailure(error) {
  const failure = {
    error: error?.code ?? "AUDIT_FUZZ_ERROR",
    message: error?.message ?? String(error),
  };
  for (const key of ["seed", "caseNumber", "category", "categoryCase"]) {
    if (error?.[key] !== undefined) failure[key] = error[key];
  }
  process.stderr.write(`${JSON.stringify(failure)}\n`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(runAuditFuzz())}\n`);
  } catch (error) {
    printFailure(error);
    process.exitCode = 1;
  }
}
