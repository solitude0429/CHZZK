export function isLikelyHlsPlaylist(text) {
  let source = String(text ?? "");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  for (const line of source.split(/\r\n|[\r\n]/)) {
    const candidate = line.replace(/^[\t ]+|[\t ]+$/g, "");
    if (candidate === "") continue;
    return candidate === "#EXTM3U";
  }
  return false;
}

export function isUtf8TextWithinByteLimit(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return false;
  return new TextEncoder().encode(String(text ?? "")).byteLength <= maxBytes;
}
