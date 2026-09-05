import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (typeof npmCli !== "string" || !npmCli) {
  throw new Error("Dependency audit must run through the pinned npm script");
}
const result = spawnSync(process.execPath, [npmCli, "audit", "--json", "--audit-level=moderate"], {
  encoding: "utf8",
  maxBuffer: 2 * 1024 * 1024,
});

if (result.error || ![0, 1].includes(result.status)) {
  throw new Error(`npm audit failed to run: ${result.error?.message ?? result.stderr.trim()}`);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error("npm audit did not return bounded JSON output");
}

if (report && typeof report === "object" && Object.hasOwn(report, "error")) {
  throw new Error("npm audit registry request failed; vulnerability status is unverified");
}

const vulnerabilities = report?.vulnerabilities;
if (!vulnerabilities || typeof vulnerabilities !== "object" || Array.isArray(vulnerabilities)) {
  throw new Error("npm audit returned an invalid vulnerability report");
}

const names = Object.keys(vulnerabilities).sort();
if (names.length === 0) {
  if (result.status !== 0) throw new Error("npm audit failed without reporting a vulnerability");
  console.log("npm audit found no vulnerabilities at or above the configured threshold");
  process.exit(0);
}

const summary = names.map((name) => `${name}:${vulnerabilities[name]?.severity ?? "unknown"}`);
throw new Error(`npm audit found vulnerabilities: ${summary.join(", ")}`);
