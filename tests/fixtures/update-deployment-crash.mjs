import process from "node:process";

import { deployUpdateRelease } from "../../scripts/lib/update-deployment.js";

const crashStep = process.env.CHZZK_CRASH_STEP;
const metadataPath = process.env.CHZZK_METADATA_PATH;
const signedXpiPath = process.env.CHZZK_SIGNED_XPI_PATH;
const sourceArchivePath = process.env.CHZZK_SOURCE_ARCHIVE_PATH;
const targetDir = process.env.CHZZK_TARGET_DIR;

if (!crashStep || !metadataPath || !signedXpiPath || !sourceArchivePath || !targetDir) {
  throw new Error("Crash fixture environment is incomplete");
}

await deployUpdateRelease({
  metadataPath,
  onTransactionStep(step) {
    if (step === crashStep) process.kill(process.pid, "SIGKILL");
  },
  signedXpiPath,
  sourceArchivePath,
  targetDir,
});

throw new Error(`Deployment completed without reaching crash step: ${crashStep}`);
