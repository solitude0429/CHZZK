#!/usr/bin/env node
import { dispatchReleaseFromAdminPreflight } from "./lib/release-dispatch.js";

try {
  if (process.env.GITHUB_ACTIONS === "true") {
    throw new Error("The administrator release preflight must run out of band, never in GitHub Actions");
  }
  const result = await dispatchReleaseFromAdminPreflight({
    repository: process.env.CHZZK_GITHUB_REPOSITORY,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Release dispatch preflight failed: ${error.message}`);
  process.exitCode = 1;
}
