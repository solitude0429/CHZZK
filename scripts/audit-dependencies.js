import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

const expectedNames = ["addons-linter", "image-size", "web-ext"];
const expectedAdvisories = [
  "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
  "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
];
const imageSize = vulnerabilities["image-size"];
const advisoryUrls = Array.isArray(imageSize?.via)
  ? imageSize.via
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => entry.url)
      .sort()
  : [];
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const exactUnpatchedToolingAdvisory =
  JSON.stringify(names) === JSON.stringify(expectedNames) &&
  JSON.stringify(advisoryUrls) === JSON.stringify(expectedAdvisories) &&
  imageSize?.isDirect === false &&
  imageSize?.severity === "high" &&
  JSON.stringify(imageSize?.effects) === JSON.stringify(["addons-linter"]) &&
  JSON.stringify(imageSize?.nodes) === JSON.stringify(["node_modules/image-size"]) &&
  vulnerabilities["addons-linter"]?.isDirect === false &&
  JSON.stringify(vulnerabilities["addons-linter"]?.via) === JSON.stringify(["image-size"]) &&
  vulnerabilities["web-ext"]?.isDirect === true &&
  JSON.stringify(vulnerabilities["web-ext"]?.via) === JSON.stringify(["addons-linter"]) &&
  lock.packages?.["node_modules/image-size"]?.version === "2.0.2" &&
  lock.packages?.["node_modules/addons-linter"]?.version === "10.10.0" &&
  lock.packages?.["node_modules/web-ext"]?.version === "10.6.0";

if (!exactUnpatchedToolingAdvisory) {
  const summary = names.map((name) => `${name}:${vulnerabilities[name]?.severity ?? "unknown"}`);
  throw new Error(`npm audit found non-allowlisted vulnerabilities: ${summary.join(", ")}`);
}

console.warn(
  "npm audit exception: image-size 2.0.2 has two unpatched parser DoS advisories in dev-only web-ext lint tooling",
);
