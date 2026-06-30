import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(
  await import("node:fs").then(({ readFileSync }) =>
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ),
);
const version = process.env.CHZZK_VERSION ?? packageJson.version;
const tag = `v${version}`;
const targetDir = process.env.CHZZK_UPDATE_DIR ?? "/var/www/chzzk-updates";
const workDir = mkdtempSync(join(tmpdir(), "chzzk-update-deploy-"));
const releaseXpi = `chzzk-${version}-signed.xpi`;
const releaseZip = `chzzk-${version}.zip`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("gh", ["release", "download", tag, "-p", releaseXpi, "-p", releaseZip, "-D", workDir]);

const signedXpiPath = join(workDir, releaseXpi);
assert.equal(statSync(signedXpiPath).isFile(), true, `${releaseXpi} must exist`);

run("node", ["scripts/build-update-manifest.js"], {
  env: {
    ...process.env,
    RELEASE_BASE_URL: "https://chzzk-updates.alpha-apple.dedyn.io",
    SIGNED_XPI: signedXpiPath,
    UPDATE_SITE_DIR: workDir,
  },
});
run("node", ["scripts/validate-update-manifest.js"], {
  env: {
    ...process.env,
    SIGNED_XPI: signedXpiPath,
    UPDATE_MANIFEST: join(workDir, "updates.json"),
  },
});

mkdirSync(targetDir, { recursive: true });
for (const file of ["updates.json", "index.html", releaseXpi, releaseZip]) {
  cpSync(join(workDir, file), join(targetDir, file));
  chmodSync(join(targetDir, file), 0o644);
}

console.log(`deployed CHZZK ${version} update files to ${targetDir}`);
console.log("update manifest: https://chzzk-updates.alpha-apple.dedyn.io/updates.json");
