#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const referencedPaths = new Set(
  [
    ...(manifest.background?.scripts ?? []),
    ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.browser_action?.default_icon ?? {}),
    manifest.browser_action?.default_popup,
  ].filter(Boolean),
);

for (const relativePath of referencedPaths) {
  assert.equal(typeof relativePath, "string", "manifest runtime references must be strings");
  assert.doesNotMatch(
    relativePath,
    /^(?:\/|.*(?:^|\/)\.\.(?:\/|$))/,
    "manifest path must stay inside the package",
  );
  const stat = lstatSync(join(root, relativePath));
  assert.equal(
    stat.isFile() && !stat.isSymbolicLink(),
    true,
    `manifest reference must be a regular file: ${relativePath}`,
  );
}

const popupPath = manifest.browser_action?.default_popup;
assert.equal(popupPath, "diagnostics.html", "the diagnostics popup must remain the only extension page");
const popup = readFileSync(join(root, popupPath), "utf8");
const scripts = [...popup.matchAll(/<script\b([^>]*)>/gi)];
assert.equal(scripts.length, 1, "diagnostics popup must contain exactly one external script");
assert.match(scripts[0][1], /\bsrc=["']diagnostics\.js["']/i);
assert.equal(/<script\b[^>]*>\s*[^<\s]/i.test(popup), false, "inline popup scripts are forbidden");
assert.equal(/\bon\w+\s*=/i.test(popup), false, "inline event handlers are forbidden");

for (const relativePath of ["background.js", "diagnostics.js", "site-observer.js"]) {
  const source = readFileSync(join(root, relativePath), "utf8");
  assert.equal(
    source.includes("//# sourceMappingURL="),
    false,
    `${relativePath} must not expose a source map`,
  );
  assert.equal(
    /\beval\s*\(|\bnew\s+Function\s*\(/.test(source),
    false,
    `${relativePath} must not use dynamic code evaluation`,
  );
}

console.log(
  `validated ${referencedPaths.size} manifest runtime references and extension-page CSP invariants`,
);
