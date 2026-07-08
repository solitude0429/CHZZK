import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const workflowDir = new URL("../.github/workflows/", import.meta.url);
const pinnedAction = /^[^@\s]+@[a-f0-9]{40}$/;

for (const file of readdirSync(workflowDir)
  .filter((entry) => /\.ya?ml$/i.test(entry))
  .sort()) {
  const text = readFileSync(new URL(file, workflowDir), "utf8");
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/);
    if (!match || match[1].startsWith("./")) continue;
    assert.match(match[1], pinnedAction, `${file}:${index + 1} must pin ${match[1]} to a full commit SHA`);
  }
}

console.log("workflow action references are pinned to full commit SHAs");
