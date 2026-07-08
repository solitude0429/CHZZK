import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { analyzeDiagnostics } from "../src/shared/diagnostics.js";
import { parseQualityFromUrl, qualityNumber } from "../src/shared/quality.js";

function usage() {
  console.error("Usage: npm run diagnostics:analyze -- <diagnostics.json> [--apply]");
}

function assertCleanWorktree() {
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (status.status !== 0) process.exit(status.status ?? 1);
  if (status.stdout.trim()) {
    console.error("Refusing --apply with a dirty working tree; commit or stash local changes first.");
    process.exit(2);
  }
}

function diagnosticsSamples(snapshot) {
  return Array.isArray(snapshot?.samples) ? snapshot.samples : [];
}

function assertSafePolicySuggestion(analysis, diagnostics) {
  const observedQuality = analysis.highestObservedQuality;
  const observedNumber = qualityNumber(observedQuality);
  if (!observedQuality || !observedNumber || observedNumber < 144 || observedNumber > 4320) {
    throw new Error(`Refusing unsafe diagnostics quality suggestion: ${observedQuality ?? "none"}`);
  }

  const hasMatchingSample = diagnosticsSamples(diagnostics).some(
    (sample) => parseQualityFromUrl(sample?.url ?? "") === observedQuality,
  );
  if (!hasMatchingSample) {
    throw new Error(
      `Refusing to apply ${observedQuality}; no matching redacted sample URL shape was present.`,
    );
  }
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fileArg = args.find((arg) => arg !== "--apply");
if (!fileArg) {
  usage();
  process.exit(2);
}

const policyUrl = new URL("../policy/quality-policy.json", import.meta.url);
const diagnostics = JSON.parse(await readFile(fileArg, "utf8"));
const policy = JSON.parse(await readFile(policyUrl, "utf8"));
const analysis = analyzeDiagnostics(diagnostics, { qualityCandidates: policy.qualityCandidates });

console.log(JSON.stringify(analysis, null, 2));

if (apply && analysis.needsPolicyUpdate) {
  assertCleanWorktree();
  assertSafePolicySuggestion(analysis, diagnostics);
  const updatedPolicy = {
    ...policy,
    qualityCandidates: analysis.suggestedQualityCandidates,
    notes: [
      ...(policy.notes ?? []),
      `Added ${analysis.highestObservedQuality} to qualityCandidates from reviewed diagnostics.`,
    ],
  };
  await writeFile(policyUrl, `${JSON.stringify(updatedPolicy, null, 2)}\n`);
  const build = spawnSync("npm", ["run", "build:runtime"], { stdio: "inherit" });
  process.exit(build.status ?? 1);
}
