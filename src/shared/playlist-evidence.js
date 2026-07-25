function normalizedPlaylistLines(text) {
  let source = String(text ?? "");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  return source.split(/\r\n|[\r\n]/).map((line) => line.replace(/^[\t ]+|[\t ]+$/g, ""));
}

function firstMeaningfulLineIsHeader(lines) {
  for (const line of lines) {
    if (line === "") continue;
    return line === "#EXTM3U";
  }
  return false;
}

function splitHlsAttributeList(value) {
  const entries = [];
  let current = "";
  let quoted = false;
  for (const character of String(value ?? "")) {
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quoted) return null;
  if (current) entries.push(current);
  return entries;
}

function parseHlsAttributeList(value) {
  const entries = splitHlsAttributeList(value);
  if (!entries) return null;
  const attributes = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return null;
    const key = entry.slice(0, separator).trim().toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(key) || Object.hasOwn(attributes, key)) return null;
    let rawValue = entry.slice(separator + 1).trim();
    if (rawValue.startsWith('"')) {
      if (rawValue.length < 2 || !rawValue.endsWith('"')) return null;
      rawValue = rawValue.slice(1, -1);
    } else if (rawValue.includes('"')) {
      return null;
    }
    attributes[key] = rawValue;
  }
  return attributes;
}

function hasUnsafePlaylistUriCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x20 || codePoint === 0x7f || character === "<" || character === ">") {
      return true;
    }
  }
  return false;
}

function isPlausiblePlaylistUri(value) {
  if (typeof value !== "string" || value === "" || value.startsWith("#")) return false;
  if (hasUnsafePlaylistUriCharacter(value)) return false;
  try {
    const parsed = new URL(value, "https://hls.invalid/base/");
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function nextMeaningfulLine(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index] !== "") return lines[index];
  }
  return null;
}

function hasUsableMasterVariant(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].toUpperCase().startsWith("#EXT-X-STREAM-INF:")) continue;
    const uri = nextMeaningfulLine(lines, index + 1);
    if (uri && !uri.startsWith("#") && isPlausiblePlaylistUri(uri)) return true;
  }
  return false;
}

function hasPositiveTargetDuration(lines) {
  return lines.some((line) => {
    if (!line.toUpperCase().startsWith("#EXT-X-TARGETDURATION:")) return false;
    const value = line.slice(line.indexOf(":") + 1).trim();
    const duration = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(duration) && duration > 0;
  });
}

function isValidByteRangeTag(line) {
  if (!line.toUpperCase().startsWith("#EXT-X-BYTERANGE:")) return false;
  const value = line.slice(line.indexOf(":") + 1).trim();
  const match = value.match(/^([1-9]\d*)(?:@(0|[1-9]\d*))?$/);
  if (!match) return false;
  return [match[1], match[2]]
    .filter((entry) => entry !== undefined)
    .every((entry) => Number.isSafeInteger(Number(entry)));
}

function nextMediaSegmentUri(lines, startIndex) {
  let sawByteRange = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "" || (line.startsWith("#") && !line.toUpperCase().startsWith("#EXT"))) continue;
    if (!sawByteRange && isValidByteRangeTag(line)) {
      sawByteRange = true;
      continue;
    }
    return isPlausiblePlaylistUri(line) ? line : null;
  }
  return null;
}

function hasUsableMediaSegment(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.toUpperCase().startsWith("#EXTINF:")) continue;
    const durationText = line
      .slice(line.indexOf(":") + 1)
      .split(",", 1)[0]
      .trim();
    const duration = Number(durationText);
    if (!/^\d+(?:\.\d+)?$/.test(durationText) || !Number.isFinite(duration) || duration <= 0) {
      continue;
    }
    if (nextMediaSegmentUri(lines, index + 1)) return true;
  }
  return false;
}

function hasUsableLowLatencyPart(lines) {
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("#EXT-X-PART:")) {
      const attributes = parseHlsAttributeList(line.slice(line.indexOf(":") + 1));
      const duration = Number(attributes?.DURATION);
      if (
        attributes &&
        /^\d+(?:\.\d+)?$/.test(attributes.DURATION ?? "") &&
        Number.isFinite(duration) &&
        duration > 0 &&
        isPlausiblePlaylistUri(attributes.URI)
      ) {
        return true;
      }
    }
    if (upper.startsWith("#EXT-X-PRELOAD-HINT:")) {
      const attributes = parseHlsAttributeList(line.slice(line.indexOf(":") + 1));
      if (attributes?.TYPE?.toUpperCase() === "PART" && isPlausiblePlaylistUri(attributes.URI)) {
        return true;
      }
    }
  }
  return false;
}

export function isLikelyHlsPlaylist(text) {
  return firstMeaningfulLineIsHeader(normalizedPlaylistLines(text));
}

export function isUsableHlsPlaylist(text) {
  const lines = normalizedPlaylistLines(text);
  if (!firstMeaningfulLineIsHeader(lines)) return false;
  if (hasUsableMasterVariant(lines)) return true;
  if (!hasPositiveTargetDuration(lines)) return false;
  return hasUsableMediaSegment(lines) || hasUsableLowLatencyPart(lines);
}

export function isUtf8TextWithinByteLimit(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return false;
  return new TextEncoder().encode(String(text ?? "")).byteLength <= maxBytes;
}
