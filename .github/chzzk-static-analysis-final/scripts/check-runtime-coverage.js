#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_PATH = join(ROOT, "background.js");
const TEST_FILES = [
  "tests/unit/background-request-lifecycle.test.js",
  "tests/unit/background-runtime.test.js",
  "tests/unit/background-transition-regressions.test.js",
];
const THRESHOLDS = Object.freeze({ blocks: 60, functions: 85, lines: 85 });

function mergeScriptCoverage(directory) {
  const functions = new Map();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const document = JSON.parse(readFileSync(join(directory, name), "utf8"));
    for (const script of document.result ?? []) {
      if (script.url !== "background.js" && !script.url.endsWith("/background.js")) continue;
      for (const fn of script.functions ?? []) {
        const outer = fn.ranges?.[0];
        if (!outer) continue;
        const functionKey = `${outer.startOffset}:${outer.endOffset}:${fn.functionName}`;
        const current = functions.get(functionKey) ?? {
          functionName: fn.functionName,
          isBlockCoverage: false,
          ranges: new Map(),
        };
        current.isBlockCoverage ||= fn.isBlockCoverage === true;
        for (const range of fn.ranges) {
          const rangeKey = `${range.startOffset}:${range.endOffset}`;
          const previous = current.ranges.get(rangeKey) ?? { ...range, count: 0 };
          previous.count += Number(range.count) || 0;
          current.ranges.set(rangeKey, previous);
        }
        functions.set(functionKey, current);
      }
    }
  }
  return [...functions.values()].map((fn) => ({ ...fn, ranges: [...fn.ranges.values()] }));
}

function percentage(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

function lineSummary(source, functions) {
  const ranges = functions.flatMap((fn) => fn.ranges);
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  let executable = 0;
  let covered = 0;
  for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex += 1) {
    const start = lineStarts[lineIndex];
    const end = lineStarts[lineIndex + 1] ?? source.length;
    const offsets = [];
    for (let offset = start; offset < end; offset += 1) {
      if (!/\s/.test(source[offset])) offsets.push(offset);
    }
    if (offsets.length === 0) continue;
    let lineExecutable = false;
    let lineCovered = false;
    for (const offset of offsets) {
      const candidates = ranges.filter((range) => range.startOffset <= offset && offset < range.endOffset);
      if (candidates.length === 0) continue;
      lineExecutable = true;
      const minimumLength = Math.min(...candidates.map((range) => range.endOffset - range.startOffset));
      if (
        candidates.some((range) => range.endOffset - range.startOffset === minimumLength && range.count > 0)
      ) {
        lineCovered = true;
        break;
      }
    }
    if (lineExecutable) executable += 1;
    if (lineCovered) covered += 1;
  }
  return { covered, total: executable };
}

function summarize(functions, source) {
  const functionTotal = functions.length;
  const functionCovered = functions.filter((fn) => fn.ranges[0]?.count > 0).length;
  const blockRanges = functions.flatMap((fn) => (fn.isBlockCoverage ? fn.ranges.slice(1) : []));
  const lines = lineSummary(source, functions);
  return {
    blocks: { covered: blockRanges.filter((range) => range.count > 0).length, total: blockRanges.length },
    functions: { covered: functionCovered, total: functionTotal },
    lines,
  };
}

const coverageDirectory = mkdtempSync(join(tmpdir(), "chzzk-runtime-coverage-"));
try {
  const result = spawnSync(process.execPath, ["--test", ...TEST_FILES], {
    cwd: ROOT,
    env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const functions = mergeScriptCoverage(coverageDirectory);
  if (functions.length === 0) throw new Error("No VM coverage was collected for background.js");
  const summary = summarize(functions, readFileSync(TARGET_PATH, "utf8"));
  const rows = Object.entries(summary).map(([name, value]) => ({
    covered: value.covered,
    metric: name,
    percent: percentage(value.covered, value.total),
    threshold: THRESHOLDS[name],
    total: value.total,
  }));
  for (const row of rows) {
    console.log(
      `${row.metric}: ${row.percent.toFixed(2)}% (${row.covered}/${row.total}, required ${row.threshold.toFixed(2)}%)`,
    );
  }
  const failed = rows.filter((row) => row.percent + Number.EPSILON < row.threshold);
  if (failed.length > 0) {
    throw new Error(`Runtime coverage threshold failed: ${failed.map((row) => row.metric).join(", ")}`);
  }
} catch (error) {
  console.error(`Runtime coverage verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(coverageDirectory, { force: true, recursive: true });
}
