// Capture only bounded evidence; callers forward the original bytes to playback first.
export function createPlaylistResponseBuffer(maxBytes) {
  const decoder = new TextDecoder();
  const textChunks = [];
  let totalBytes = 0;
  let oversized = false;

  function append(data) {
    if (oversized) return;
    const bytes = new Uint8Array(data);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxBytes) {
      oversized = true;
      clear();
      return;
    }
    textChunks.push(decoder.decode(bytes, { stream: true }));
  }

  function clear() {
    textChunks.length = 0;
  }

  function finish() {
    if (oversized) return null;
    textChunks.push(decoder.decode());
    return textChunks.join("");
  }

  return {
    append,
    clear,
    finish,
    get oversized() {
      return oversized;
    },
    get totalBytes() {
      return totalBytes;
    },
  };
}
