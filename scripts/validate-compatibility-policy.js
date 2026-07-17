#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { loadCompatibilityPolicy } from "./lib/compatibility-policy.js";

try {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const policy = loadCompatibilityPolicy({ manifest });
  console.log(
    JSON.stringify({
      androidMinimum: policy.android.minimumVersion,
      currentDesktop: policy.desktop.signedSmokeProfiles.current.firefoxVersion,
      minimumDesktop: policy.desktop.minimumVersion,
      profiles: Object.keys(policy.desktop.signedSmokeProfiles).sort(),
    }),
  );
} catch (error) {
  console.error(`Compatibility policy validation failed: ${error.message}`);
  process.exitCode = 1;
}
