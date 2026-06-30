import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const legacyTerms = [
  ["bass", "9030"],
  ["F", "UCK-CHZZK"],
  ["ref", "racta"],
  ["원본", " 프로젝트"],
  ["Chrome", " 포팅"],
  ["시작점은", " MIT 라이선스"],
  ["up", "stream"],
  ["fork", "/rework"],
];

const forbiddenPatterns = legacyTerms.map((parts) => new RegExp(parts.join(""), "i"));

const list = spawnSync("git", ["ls-files"], { encoding: "utf8" });
if (list.status !== 0) {
  process.stderr.write(list.stderr);
  process.exit(list.status ?? 1);
}

const files = list.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const violations = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(content)) violations.push(`${file}: ${pattern}`);
  }
}

assert.deepEqual(violations, [], "repository must not contain legacy source/rework branding");
console.log("project branding is clean");
