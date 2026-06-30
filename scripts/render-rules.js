import { readFile, writeFile } from "node:fs/promises";

import { format } from "prettier";

import { buildQualityRegexFilter } from "../src/shared/quality.js";

const policyUrl = new URL("../policy/quality-policy.json", import.meta.url);
const rulesUrl = new URL("../rules.json", import.meta.url);

export function renderRules(policy) {
  return [
    {
      id: 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          regexSubstitution: `\\1${policy.targetQuality}\\3`,
        },
      },
      condition: {
        regexFilter: buildQualityRegexFilter({
          minRedirectQuality: policy.minRedirectQuality,
          targetQuality: policy.targetQuality,
        }),
        resourceTypes: ["media", "xmlhttprequest"],
      },
    },
  ];
}

const policy = JSON.parse(await readFile(policyUrl, "utf8"));
const rules = renderRules(policy);
const formattedRules = await format(JSON.stringify(rules, null, 2), { parser: "json" });
await writeFile(rulesUrl, formattedRules);
console.log(`rendered ${rules.length} rule(s) to ${rulesUrl.pathname}`);
