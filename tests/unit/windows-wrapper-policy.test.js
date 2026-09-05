import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("Windows signed-smoke policy", () => {
  it("detects Windows from the runtime rather than the inherited OS environment", () => {
    for (const path of [
      "scripts/firefox-signed-smoke.windows.ps1",
      "scripts/verify-live-update.windows.ps1",
    ]) {
      const wrapper = read(path);
      assert.match(wrapper, /\[Environment\]::OSVersion\.Platform -ne \[PlatformID\]::Win32NT/);
      assert.doesNotMatch(wrapper, /\$env:OS/);
    }
  });
  it("requires an explicit absolute Node executable and never resolves Node through PATH", () => {
    const wrapper = read("scripts/firefox-signed-smoke.windows.ps1");
    assert.match(wrapper, /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$NodeBinary/);
    assert.match(wrapper, /IsPathRooted\(\$Path\)/);
    assert.match(wrapper, /GetFullPath\(\$Path\)/);
    assert.doesNotMatch(wrapper, /IsPathFullyQualified/);
    assert.match(wrapper, /Resolve-RegularFile -Path \$NodeBinary -Label "NodeBinary" -RequireAbsolute/);
    assert.doesNotMatch(wrapper, /Get-Command\s+-Name\s+\$NodeBinary/);
    assert.doesNotMatch(wrapper, /\$NodeBinary\s*=\s*"node\.exe"/);
    assert.match(wrapper, /& \$node -p/);
    assert.match(wrapper, /& \$node \$runner/);
  });

  it("removes GitHub credentials and preserves bounded child failure output", () => {
    const wrapper = read("scripts/firefox-signed-smoke.windows.ps1");
    for (const name of ["GH_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_TOKEN"]) {
      assert.match(wrapper, new RegExp(`"${name}"`));
    }
    assert.doesNotMatch(wrapper, /& \$node \$runner\s*\|\s*Out-Null/);
    assert.match(wrapper, /& \$node \$runner 2>&1 \| ForEach-Object/);
    assert.match(wrapper, /\$runnerOutput\.Append\(\$boundedCandidate\)/);
    assert.match(wrapper, /ConvertTo-BoundedUtf8Text/);
    assert.match(wrapper, /64 \* 1024/);
    assert.match(wrapper, /\[Console\]::Error\.Write\(\$runnerFailureOutput\)/);
  });

  it(
    "forwards both bounded native streams without credentials on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const directory = mkdtempSync(join(tmpdir(), "chzzk-windows-wrapper-failure-"));
      const wrapperPath = join(directory, "firefox-signed-smoke.windows.ps1");
      const runnerPath = join(directory, "firefox-signed-smoke.js");
      const resultPath = join(directory, "result.json");
      const inputPaths = {
        firefox: join(directory, "firefox.exe"),
        geckodriver: join(directory, "geckodriver.exe"),
        metadata: join(directory, "metadata.json"),
        newXpi: join(directory, "new.xpi"),
        oldXpi: join(directory, "old.xpi"),
      };
      try {
        copyFileSync(new URL("../../scripts/firefox-signed-smoke.windows.ps1", import.meta.url), wrapperPath);
        for (const path of Object.values(inputPaths)) writeFileSync(path, "nonempty fixture");
        writeFileSync(
          runnerPath,
          `const names = ${JSON.stringify([
            "GH_ENTERPRISE_TOKEN",
            "GH_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GITHUB_TOKEN",
          ])};
const leaked = names.filter((name) => process.env[name] !== undefined);
console.log("stdout-phase-marker");
console.error("stderr-phase-marker");
console.error(\`credential-leaks=\${leaked.length === 0 ? "none" : leaked.join(",")}\`);
console.error("x".repeat(70 * 1024));
console.error("must-not-survive-the-bound");
process.exitCode = 17;
`,
        );
        const powershell = join(
          process.env.SystemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const result = spawnSync(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            wrapperPath,
            "-NodeBinary",
            realpathSync.native(process.execPath),
            "-FirefoxBinary",
            inputPaths.firefox,
            "-GeckodriverBinary",
            inputPaths.geckodriver,
            "-ReleaseMetadata",
            inputPaths.metadata,
            "-SignedXpi",
            inputPaths.newXpi,
            "-OldSignedXpi",
            inputPaths.oldXpi,
            "-ResultPath",
            resultPath,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              OS: "synthetic-untrusted-platform-name",
              GH_ENTERPRISE_TOKEN: "enterprise-gh-secret",
              GH_TOKEN: "gh-secret",
              GITHUB_ENTERPRISE_TOKEN: "enterprise-github-secret",
              GITHUB_TOKEN: "github-secret",
            },
            maxBuffer: 128 * 1024,
          },
        );

        assert.equal(result.status, 17, result.stderr.slice(0, 2000));
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /stdout-phase-marker/);
        assert.match(result.stderr, /stderr-phase-marker/);
        assert.match(result.stderr, /credential-leaks=none/);
        assert.doesNotMatch(result.stderr, /(?:enterprise-)?(?:gh|github)-secret/);
        assert.doesNotMatch(result.stderr, /must-not-survive-the-bound/);
        assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 64 * 1024);
        assert.equal(existsSync(resultPath), false);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
