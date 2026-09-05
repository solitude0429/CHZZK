function splitHlsAttributeList(value) {
  const result = [];
  let current = "";
  let quoted = false;
  for (const char of String(value ?? "")) {
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      result.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quoted) return null;
  if (current) result.push(current);
  return result;
}

export function parseHlsAttributeList(value) {
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
