#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const DEFAULT_FUNCTION_THRESHOLD = 80;
const DEFAULT_BYTE_THRESHOLD = 65;
const MIN_NAMED_FUNCTIONS = 100;
const MIN_EXECUTABLE_BYTES = 50_000;

function isBackgroundScriptUrl(url) {
  return url === "background.js" || /(?:^|[/\\])background\.js$/.test(String(url ?? ""));
}

function normalizedThreshold(value, fallback, label) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`${label} must be a percentage from 0 through 100`);
  }
  return number;
}

function mergeFunctionCoverage(entries) {
  const functions = new Map();
  for (const entry of entries) {
    if (!isBackgroundScriptUrl(entry?.url)) continue;
    for (const fn of Array.isArray(entry.functions) ? entry.functions : []) {
      const ranges = Array.isArray(fn.ranges) ? fn.ranges : [];
      const root = ranges[0];
      if (!fn.functionName || !root) continue;
      const functionKey = `${fn.functionName}\0${root.startOffset}\0${root.endOffset}`;
      const merged = functions.get(functionKey) ?? {
        endOffset: root.endOffset,
        functionName: fn.functionName,
        ranges: new Map(),
        startOffset: root.startOffset,
      };
      for (const range of ranges) {
        if (
          !Number.isSafeInteger(range?.startOffset) ||
          !Number.isSafeInteger(range?.endOffset) ||
          range.endOffset <= range.startOffset ||
          !Number.isFinite(range?.count)
        ) {
          continue;
        }
        const rangeKey = `${range.startOffset}\0${range.endOffset}`;
        merged.ranges.set(rangeKey, (merged.ranges.get(rangeKey) ?? 0) + range.count);
      }
      functions.set(functionKey, merged);
    }
  }
  return [...functions.values()];
}

function coveredBytesForFunction(fn) {
  const ranges = [...fn.ranges.entries()].map(([key, count]) => {
    const [startOffset, endOffset] = key.split("\0").map(Number);
    return { count, endOffset, startOffset };
  });
  const root = ranges.find(
    (range) => range.startOffset === fn.startOffset && range.endOffset === fn.endOffset,
  );
  if (!root) return { coveredBytes: 0, totalBytes: 0 };

  const boundaries = new Set([fn.startOffset, fn.endOffset]);
  for (const range of ranges) {
    if (range.startOffset < fn.startOffset || range.endOffset > fn.endOffset) continue;
    boundaries.add(range.startOffset);
    boundaries.add(range.endOffset);
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  let coveredBytes = 0;
  let totalBytes = 0;
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const startOffset = offsets[index];
    const endOffset = offsets[index + 1];
    if (endOffset <= startOffset) continue;
    const containing = ranges
      .filter((range) => range.startOffset <= startOffset && endOffset <= range.endOffset)
      .sort((left, right) => left.endOffset - left.startOffset - (right.endOffset - right.startOffset));
    if (containing.length === 0) continue;
    totalBytes += endOffset - startOffset;
    if (containing[0].count > 0) coveredBytes += endOffset - startOffset;
  }
  return { coveredBytes, totalBytes };
}

export function summarizeBackgroundCoverage(entries) {
  const functions = mergeFunctionCoverage(entries);
  let coveredFunctions = 0;
  let coveredBytes = 0;
  let totalBytes = 0;
  for (const fn of functions) {
    const rootCount = fn.ranges.get(`${fn.startOffset}\0${fn.endOffset}`) ?? 0;
    if (rootCount > 0) coveredFunctions += 1;
    const bytes = coveredBytesForFunction(fn);
    coveredBytes += bytes.coveredBytes;
    totalBytes += bytes.totalBytes;
  }
  return {
    bytePercent: totalBytes === 0 ? 0 : (coveredBytes / totalBytes) * 100,
    coveredBytes,
    coveredFunctions,
    functionPercent: functions.length === 0 ? 0 : (coveredFunctions / functions.length) * 100,
    totalBytes,
    totalFunctions: functions.length,
  };
}

function backgroundTestFiles(rootDir) {
  const configured = process.env.CHZZK_BACKGROUND_COVERAGE_TESTS;
  if (configured) {
    return configured
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => resolve(rootDir, value));
  }
  const testDir = resolve(rootDir, "tests/unit");
  return readdirSync(testDir)
    .filter((name) => /^background-.*\.test\.js$/.test(name))
    .sort()
    .map((name) => join(testDir, name));
}

function readCoverageEntries(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const document = JSON.parse(readFileSync(join(directory, name), "utf8"));
    if (Array.isArray(document?.result)) entries.push(...document.result);
  }
  return entries;
}

export function verifyBackgroundCoverage({ entries, byteThreshold, functionThreshold }) {
  const summary = summarizeBackgroundCoverage(entries);
  if (summary.totalFunctions < MIN_NAMED_FUNCTIONS || summary.totalBytes < MIN_EXECUTABLE_BYTES) {
    throw new Error(
      `Background coverage was vacuous: ${summary.totalFunctions} named functions / ${summary.totalBytes} executable bytes`,
    );
  }
  if (summary.functionPercent + Number.EPSILON < functionThreshold) {
    throw new Error(
      `Background named-function coverage ${summary.functionPercent.toFixed(2)}% is below ${functionThreshold}%`,
    );
  }
  if (summary.bytePercent + Number.EPSILON < byteThreshold) {
    throw new Error(
      `Background executable-byte coverage ${summary.bytePercent.toFixed(2)}% is below ${byteThreshold}%`,
    );
  }
  return summary;
}

async function main() {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const tests = backgroundTestFiles(rootDir);
  if (tests.length === 0) throw new Error("No background VM tests were found");
  const coverageDir = mkdtempSync(join(tmpdir(), "chzzk-background-coverage-"));
  try {
    const run = spawnSync(process.execPath, ["--test", ...tests], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    if (run.status !== 0) process.exit(run.status ?? 1);

    const functionThreshold = normalizedThreshold(
      process.env.CHZZK_BACKGROUND_FUNCTION_COVERAGE,
      DEFAULT_FUNCTION_THRESHOLD,
      "CHZZK_BACKGROUND_FUNCTION_COVERAGE",
    );
    const byteThreshold = normalizedThreshold(
      process.env.CHZZK_BACKGROUND_BYTE_COVERAGE,
      DEFAULT_BYTE_THRESHOLD,
      "CHZZK_BACKGROUND_BYTE_COVERAGE",
    );
    const summary = verifyBackgroundCoverage({
      byteThreshold,
      entries: readCoverageEntries(coverageDir),
      functionThreshold,
    });
    console.log(
      `background VM coverage: functions ${summary.functionPercent.toFixed(2)}% ` +
        `(${summary.coveredFunctions}/${summary.totalFunctions}), executable bytes ` +
        `${summary.bytePercent.toFixed(2)}% (${summary.coveredBytes}/${summary.totalBytes})`,
    );
  } finally {
    rmSync(coverageDir, { force: true, recursive: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`Background coverage verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
