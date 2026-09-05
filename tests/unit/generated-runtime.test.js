import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("runs the runtime builder with Node and detects generated drift", () => {
  const root = mkdtempSync(join(tmpdir(), "chzzk-generated-check-"));
  const options = { cwd: root, encoding: "utf8", windowsHide: true };
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "background.js"), "original\n");
    for (const args of [
      ["init", "--quiet"],
      ["add", "background.js"],
    ]) {
      const result = spawnSync("git", args, options);
      assert.equal(result.status, 0, result.stderr);
    }
    const script = readFileSync(new URL("../../scripts/check-generated.js", import.meta.url), "utf8");
    writeFileSync(join(root, "check-generated.mjs"), script);
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    for (const [content, expectedStatus] of [
      ["original\n", 0],
      ["changed\n", 1],
    ]) {
      writeFileSync(
        join(root, "scripts/build-runtime.js"),
        `import { writeFileSync } from "node:fs"; writeFileSync("background.js", ${JSON.stringify(content)});`,
      );
      const result = spawnSync(process.execPath, ["check-generated.mjs"], options);
      assert.equal(result.status, expectedStatus, result.stderr);
      assert.equal(readFileSync(join(root, "background.js"), "utf8"), content);
      if (expectedStatus === 1) assert.match(result.stderr, /Generated runtime files are stale/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
