import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";

test("the real package command excludes dummy credentials before producing a ZIP", async () => {
  const root = await mkdtemp(join(tmpdir(), "chzzk-secret-package-"));
  try {
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(join(source, "secrets"), { recursive: true });
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({ manifest_version: 2, name: "Synthetic package", version: "1.0" }),
    );
    const names = [
      ".env",
      ".env.production",
      ".env.example",
      "operator.key",
      "operator.pem",
      "operator.p12",
      "operator.pfx",
      "operator.secret",
      "operator.secrets",
      "secrets/runtime.json",
    ];
    for (const name of names) await writeFile(join(source, name), "synthetic-not-a-credential");
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const patterns = pkg.scripts.build.split("--ignore-files ")[1].trim().split(/\s+/);
    const result = spawnSync(
      process.execPath,
      [
        new URL("../../node_modules/web-ext/bin/web-ext.js", import.meta.url).pathname.replace(
          /^\/([A-Za-z]:)/,
          "$1",
        ),
        "build",
        "--source-dir",
        source,
        "--artifacts-dir",
        output,
        "--ignore-files",
        ...patterns,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    assert.equal(result.status, 0, "fixture packaging must succeed; child output suppressed");
    const files = await readdir(output);
    assert.equal(files.length, 1);
    const zip = await JSZip.loadAsync(await readFile(join(output, files[0])));
    assert.deepEqual(Object.keys(zip.files).sort(), ["manifest.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
