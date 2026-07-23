const MAX_PLAYLIST_LINES = 20_000;
const MASTER_ONLY_TAGS = new Set([
  "#EXT-X-I-FRAME-STREAM-INF",
  "#EXT-X-MEDIA",
  "#EXT-X-SESSION-DATA",
  "#EXT-X-SESSION-KEY",
  "#EXT-X-STREAM-INF",
]);
const MEDIA_ONLY_TAGS = new Set([
  "#EXT-X-BYTERANGE",
  "#EXT-X-DATERANGE",
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-DISCONTINUITY-SEQUENCE",
  "#EXT-X-ENDLIST",
  "#EXT-X-GAP",
  "#EXT-X-KEY",
  "#EXT-X-MAP",
  "#EXT-X-MEDIA-SEQUENCE",
  "#EXT-X-PART",
  "#EXT-X-PART-INF",
  "#EXT-X-PLAYLIST-TYPE",
  "#EXT-X-PRELOAD-HINT",
  "#EXT-X-PROGRAM-DATE-TIME",
  "#EXT-X-SERVER-CONTROL",
  "#EXT-X-SKIP",
  "#EXT-X-START",
  "#EXT-X-TARGETDURATION",
  "#EXTINF",
]);
const COMMON_TAGS = new Set([
  "#EXT-X-DEFINE",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  "#EXT-X-VERSION",
]);
const URI_REJECT_RE = /^(?:<!doctype\s+html|<html(?:\s|>)|<\?xml|[\[{]\s*["'}]|(?:error|forbidden|not\s+found)(?:\s|$))/i;
const DECIMAL_INTEGER_RE = /^(?:0|[1-9]\d*)$/;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;
const DECIMAL_FLOAT_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function tagName(line) {
  const separator = line.indexOf(":");
  return separator < 0 ? line : line.slice(0, separator);
}

function tagValue(line) {
  const separator = line.indexOf(":");
  return separator < 0 ? null : line.slice(separator + 1);
}

function isPlausibleUriText(value) {
  if (typeof value !== "string" || value === "" || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (URI_REJECT_RE.test(value.trim())) return false;
  try {
    const decoded = decodeURIComponent(value);
    if (URI_REJECT_RE.test(decoded.trim())) return false;
  } catch {
    // A literal percent may be valid in an observed CDN URI. This validator is
    // structural and does not canonicalize the URI here.
  }
  return true;
}

function isPlausibleUriLine(line) {
  return !line.startsWith("#") && isPlausibleUriText(line);
}

function splitAttributeList(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) return null;
  const entries = [];
  let current = "";
  let quoted = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      if (!current) return null;
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted || !current) return null;
  entries.push(current);
  return entries;
}

function quotedAttribute(value, name) {
  const entries = splitAttributeList(value);
  if (!entries) return null;
  const prefix = `${name}="`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('"')) continue;
    const candidate = entry.slice(prefix.length, -1);
    return candidate.includes('"') || !isPlausibleUriText(candidate) ? null : candidate;
  }
  return null;
}

function hasUnquotedAttribute(value, name, pattern) {
  const entries = splitAttributeList(value);
  if (!entries) return false;
  const prefix = `${name}=`;
  return entries.some(
    (entry) => entry.startsWith(prefix) && pattern.test(entry.slice(prefix.length)),
  );
}

function structurallyValidTag(line, name) {
  const value = tagValue(line);
  switch (name) {
    case "#EXT-X-VERSION":
    case "#EXT-X-TARGETDURATION":
      return value !== null && POSITIVE_INTEGER_RE.test(value);
    case "#EXT-X-MEDIA-SEQUENCE":
    case "#EXT-X-DISCONTINUITY-SEQUENCE":
      return value !== null && DECIMAL_INTEGER_RE.test(value);
    case "#EXT-X-BYTERANGE":
      return value !== null && /^(?:0|[1-9]\d*)(?:@(?:0|[1-9]\d*))?$/.test(value);
    case "#EXTINF": {
      if (value === null) return false;
      const comma = value.indexOf(",");
      return comma >= 0 && DECIMAL_FLOAT_RE.test(value.slice(0, comma));
    }
    case "#EXT-X-STREAM-INF":
      return value !== null && hasUnquotedAttribute(value, "BANDWIDTH", POSITIVE_INTEGER_RE);
    case "#EXT-X-I-FRAME-STREAM-INF":
      return (
        value !== null &&
        hasUnquotedAttribute(value, "BANDWIDTH", POSITIVE_INTEGER_RE) &&
        quotedAttribute(value, "URI") !== null
      );
    case "#EXT-X-PART":
      return (
        value !== null &&
        hasUnquotedAttribute(value, "DURATION", DECIMAL_FLOAT_RE) &&
        quotedAttribute(value, "URI") !== null
      );
    case "#EXT-X-PRELOAD-HINT":
      return value !== null && quotedAttribute(value, "URI") !== null;
    case "#EXT-X-MAP":
      return value !== null && quotedAttribute(value, "URI") !== null;
    case "#EXT-X-KEY":
    case "#EXT-X-SESSION-KEY":
      return (
        value !== null &&
        hasUnquotedAttribute(value, "METHOD", /^[A-Z0-9-]+$/) &&
        (value.includes("METHOD=NONE") || quotedAttribute(value, "URI") !== null)
      );
    case "#EXT-X-PART-INF":
      return value !== null && hasUnquotedAttribute(value, "PART-TARGET", DECIMAL_FLOAT_RE);
    case "#EXT-X-PLAYLIST-TYPE":
      return value === "EVENT" || value === "VOD";
    case "#EXT-X-INDEPENDENT-SEGMENTS":
    case "#EXT-X-ENDLIST":
    case "#EXT-X-DISCONTINUITY":
    case "#EXT-X-GAP":
      return value === null;
    default:
      // Remaining known tags use attribute/value grammars that are not needed
      // to establish media-body evidence. Reject a present-but-empty value.
      return value === null || value !== "";
  }
}

export function analyzeHlsPlaylist(text) {
  let source = String(text ?? "");
  // Existing CHZZK/CDN behavior includes BOM-prefixed responses. Keep that
  // compatibility while requiring fatal UTF-8 decoding at the network boundary.
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  if (/\u0000/.test(source)) return { kind: null, valid: false };

  const rawLines = source.split(/\r\n|[\r\n]/);
  if (rawLines.length > MAX_PLAYLIST_LINES) return { kind: null, valid: false };
  const lines = rawLines.map((line) => line.replace(/^[\t ]+|[\t ]+$/g, ""));
  const firstMeaningfulIndex = lines.findIndex((line) => line !== "");
  if (firstMeaningfulIndex < 0 || lines[firstMeaningfulIndex] !== "#EXTM3U") {
    return { kind: null, valid: false };
  }

  let hasCommonTag = false;
  let hasMasterTag = false;
  let hasMediaTag = false;
  let hasUri = false;
  let pendingStreamInf = false;
  let pendingMediaUri = false;
  let validMasterPair = false;
  let validMediaPair = false;
  let validInlineMasterUri = false;
  let validInlineMediaUri = false;

  for (let index = firstMeaningfulIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    if (!line.startsWith("#")) {
      if (!isPlausibleUriLine(line)) return { kind: null, valid: false };
      hasUri = true;
      if (pendingStreamInf) validMasterPair = true;
      if (pendingMediaUri) validMediaPair = true;
      pendingStreamInf = false;
      pendingMediaUri = false;
      continue;
    }

    if (!line.startsWith("#EXT")) {
      // The URI following STREAM-INF/EXTINF is the next non-empty line; comments
      // cannot silently delay the binding to a later unrelated URI.
      if (pendingStreamInf || pendingMediaUri) return { kind: null, valid: false };
      continue;
    }
    if (!/^#EXT(?:M3U|[-A-Z0-9]+)(?::|$)/.test(line) || line === "#EXTM3U") {
      return { kind: null, valid: false };
    }

    const name = tagName(line);
    const canAppearBeforeMediaUri = name === "#EXT-X-BYTERANGE" || name === "#EXT-X-GAP";
    if (pendingStreamInf || (pendingMediaUri && !canAppearBeforeMediaUri)) {
      return { kind: null, valid: false };
    }
    if (!structurallyValidTag(line, name)) return { kind: null, valid: false };

    if (COMMON_TAGS.has(name)) {
      hasCommonTag = true;
      continue;
    }
    if (MASTER_ONLY_TAGS.has(name)) {
      hasMasterTag = true;
      if (name === "#EXT-X-STREAM-INF") pendingStreamInf = true;
      if (name === "#EXT-X-I-FRAME-STREAM-INF") validInlineMasterUri = true;
      continue;
    }
    if (MEDIA_ONLY_TAGS.has(name)) {
      hasMediaTag = true;
      if (name === "#EXTINF") pendingMediaUri = true;
      if (name === "#EXT-X-BYTERANGE") pendingMediaUri = true;
      if (name === "#EXT-X-PART" || name === "#EXT-X-PRELOAD-HINT") {
        validInlineMediaUri = true;
      }
      continue;
    }
    // An unknown #EXT-X-* tag is not sufficient evidence by itself, but it is
    // permitted for forward-compatible playlists.
  }

  if (pendingStreamInf || pendingMediaUri) return { kind: null, valid: false };
  if (hasMasterTag && hasMediaTag) return { kind: null, valid: false };
  if (hasMasterTag) {
    return { kind: "master", valid: validMasterPair || validInlineMasterUri };
  }

  // Version/target-duration-only responses can be temporarily empty live media
  // playlists. Arbitrary URI-only text and unknown-tag-only text remain invalid.
  const valid =
    validMediaPair ||
    validInlineMediaUri ||
    (!hasUri && (hasMediaTag || hasCommonTag));
  return { kind: valid ? "media" : null, valid };
}

export function isLikelyHlsPlaylist(text) {
  return analyzeHlsPlaylist(text).valid;
}

export function isUtf8TextWithinByteLimit(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return false;
  return new TextEncoder().encode(String(text ?? "")).byteLength <= maxBytes;
}
