import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { analyzeDiagnostics } from "../src/shared/diagnostics.js";

function usage() {
  console.error("Usage: npm run diagnostics:analyze -- <diagnostics.json> [--apply]");
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
const analysis = analyzeDiagnostics(diagnostics, { targetQuality: policy.targetQuality });

console.log(JSON.stringify(analysis, null, 2));

if (apply && analysis.needsPolicyUpdate) {
  const updatedPolicy = {
    ...policy,
    targetQuality: analysis.suggestedTargetQuality,
    notes: [
      ...(policy.notes ?? []),
      `Updated targetQuality from diagnostics: ${policy.targetQuality} -> ${analysis.suggestedTargetQuality}`,
    ],
  };
  await writeFile(policyUrl, `${JSON.stringify(updatedPolicy, null, 2)}\n`);
  const render = spawnSync("npm", ["run", "render:rules"], { stdio: "inherit" });
  process.exit(render.status ?? 1);
}
