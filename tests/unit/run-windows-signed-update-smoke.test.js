import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  MAX_SUBPROCESS_OUTPUT_BYTES,
  buildPowerShellArguments,
  createSanitizedChildEnvironment,
  parseArguments,
  parseBoundedEvidence,
  parseScoopPrefix,
  resolveCanonicalRegularFile,
  runWindowsSignedUpdateSmoke,
} from "../../scripts/run-windows-signed-update-smoke.js";

const GITHUB_CREDENTIAL_NAMES = [
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
];

function passedEvidence() {
  return {
    extensionVersion: "0.1.24",
    finalUpdateState: "none-found",
    firefoxVersion: "140.12.0esr",
    installedState: "permanent-signed-active",
    mode: "update",
    schemaVersion: 1,
    status: "passed",
  };
}

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "chzzk-windows-smoke-orchestrator-"));
  const systemRoot = join(directory, "Windows");
  const powershellBinary = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const firefoxPrefix = join(directory, "scoop", "firefox-esr");
  const geckodriverPrefix = join(directory, "scoop", "geckodriver");
  const paths = {
    firefoxBinary: join(firefoxPrefix, "firefox.exe"),
    geckodriverBinary: join(geckodriverPrefix, "geckodriver.exe"),
    metadataPath: join(directory, "release-metadata.json"),
    newXpiPath: join(directory, "new-signed.xpi"),
    nodeBinary: join(directory, "node.exe"),
    oldXpiPath: join(directory, "old-signed.xpi"),
    powershellBinary,
    resultPath: join(directory, "signed-smoke-result.json"),
    wrapperPath: join(directory, "firefox-signed-smoke.windows.ps1"),
  };
  for (const parent of [join(powershellBinary, ".."), firefoxPrefix, geckodriverPrefix]) {
    mkdirSync(parent, { recursive: true });
  }
  for (const path of Object.values(paths).filter((path) => path !== paths.resultPath)) {
    writeFileSync(path, "synthetic nonempty file");
  }
  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    directory,
    firefoxPrefix,
    geckodriverPrefix,
    paths,
    systemRoot,
  };
}

describe("Windows signed-update smoke orchestrator", () => {
  it("accepts exactly the four explicit artifact and evidence paths", () => {
    assert.deepEqual(
      parseArguments([
        "--old-xpi",
        "old.xpi",
        "--metadata",
        "metadata.json",
        "--result",
        "result.json",
        "--new-xpi",
        "new.xpi",
      ]),
      {
        metadataPath: "metadata.json",
        newXpiPath: "new.xpi",
        oldXpiPath: "old.xpi",
        resultPath: "result.json",
      },
    );
    assert.throws(() => parseArguments(["--metadata", "metadata.json"]), /Expected.*--result/i);
    assert.throws(
      () =>
        parseArguments(["--metadata", "one", "--metadata", "two", "--old-xpi", "old", "--result", "result"]),
      /Duplicate.*--metadata/i,
    );
    assert.throws(
      () =>
        parseArguments([
          "--metadata",
          "metadata",
          "--new-xpi",
          "new",
          "--old-xpi",
          "old",
          "--output",
          "result",
        ]),
      /Unknown.*--output/i,
    );
  });

  it("parses only one bounded absolute Scoop prefix", () => {
    const absolute = join(tmpdir(), "scoop", "apps", "firefox-esr", "current");
    assert.equal(parseScoopPrefix(`${absolute}\r\n`, "firefox-esr"), absolute);
    assert.throws(() => parseScoopPrefix("relative\\prefix\n", "firefox-esr"), /absolute path/i);
    assert.throws(
      () => parseScoopPrefix(`${absolute}\n${join(tmpdir(), "other")}\n`, "firefox-esr"),
      /one absolute path/i,
    );
    assert.throws(() => parseScoopPrefix("x".repeat(4097), "firefox-esr"), /invalid output/i);
  });

  it("removes GitHub credentials from child environments without mutating the caller", () => {
    const env = {
      GH_ENTERPRISE_TOKEN: "enterprise-gh-secret",
      GH_TOKEN: "gh-secret",
      GITHUB_ENTERPRISE_TOKEN: "enterprise-github-secret",
      GITHUB_TOKEN: "github-secret",
      Path: "C:\\trusted-tools",
      gh_token: "case-insensitive-shadow",
    };

    assert.deepEqual(createSanitizedChildEnvironment(env), { Path: env.Path });
    assert.equal(env.GH_TOKEN, "gh-secret");
    assert.equal(env.gh_token, "case-insensitive-shadow");
  });

  it("rejects a reparse-point executable before resolving it", () => {
    const regular = {
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 1,
    };
    assert.equal(
      resolveCanonicalRegularFile("C:\\tools\\firefox.exe", "Firefox", {
        lstat: () => regular,
        realpath: () => "C:\\canonical\\firefox.exe",
      }),
      "C:\\canonical\\firefox.exe",
    );
    assert.throws(
      () =>
        resolveCanonicalRegularFile("C:\\tools\\firefox.exe", "Firefox", {
          lstat: () => ({ ...regular, isSymbolicLink: () => true }),
          realpath: () => assert.fail("a reparse point must not be resolved"),
        }),
      /reparse point/i,
    );
  });

  it("builds the exact noninteractive PowerShell wrapper invocation", () => {
    const paths = {
      firefoxBinary: "C:\\tools\\firefox.exe",
      geckodriverBinary: "C:\\tools\\geckodriver.exe",
      metadataPath: "C:\\artifacts\\metadata.json",
      newXpiPath: "C:\\artifacts\\new.xpi",
      nodeBinary: "C:\\tools\\node.exe",
      oldXpiPath: "C:\\artifacts\\old.xpi",
      resultPath: "C:\\evidence\\result.json",
      wrapperPath: "C:\\repo\\scripts\\firefox-signed-smoke.windows.ps1",
    };
    assert.deepEqual(buildPowerShellArguments(paths), [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      paths.wrapperPath,
      "-NodeBinary",
      paths.nodeBinary,
      "-FirefoxBinary",
      paths.firefoxBinary,
      "-GeckodriverBinary",
      paths.geckodriverBinary,
      "-ReleaseMetadata",
      paths.metadataPath,
      "-SignedXpi",
      paths.newXpiPath,
      "-OldSignedXpi",
      paths.oldXpiPath,
      "-ResultPath",
      paths.resultPath,
    ]);
  });

  it("discovers both Scoop tools and emits only persisted bounded evidence", () => {
    const fixture = makeFixture();
    const calls = [];
    const evidence = passedEvidence();
    const env = {
      GH_ENTERPRISE_TOKEN: "enterprise-gh-secret",
      GH_TOKEN: "gh-secret",
      GITHUB_ENTERPRISE_TOKEN: "enterprise-github-secret",
      GITHUB_TOKEN: "github-secret",
      PRESERVED_VALUE: "preserved",
      SystemRoot: fixture.systemRoot,
    };
    try {
      const actual = runWindowsSignedUpdateSmoke(
        {
          metadataPath: fixture.paths.metadataPath,
          newXpiPath: fixture.paths.newXpiPath,
          oldXpiPath: fixture.paths.oldXpiPath,
          resultPath: fixture.paths.resultPath,
        },
        {
          env,
          platform: "win32",
          processPath: fixture.paths.nodeBinary,
          runner(command, args, options) {
            calls.push({ args, command, options });
            if (args.includes("-Command")) {
              const prefix = args.at(-1).endsWith("firefox-esr")
                ? fixture.firefoxPrefix
                : fixture.geckodriverPrefix;
              return { status: 0, stderr: "", stdout: `${prefix}\r\n` };
            }
            const resultIndex = args.indexOf("-ResultPath");
            writeFileSync(args[resultIndex + 1], JSON.stringify(evidence));
            return { status: 0, stderr: "", stdout: `${JSON.stringify(evidence)}\r\n` };
          },
          systemRoot: fixture.systemRoot,
          wrapperPath: fixture.paths.wrapperPath,
        },
      );

      assert.deepEqual(actual, evidence);
      assert.deepEqual(
        calls.slice(0, 2).map(({ args }) => args),
        [
          ["-NoProfile", "-NonInteractive", "-Command", "scoop prefix firefox-esr"],
          ["-NoProfile", "-NonInteractive", "-Command", "scoop prefix geckodriver"],
        ],
      );
      assert.equal(calls[0].command, fixture.paths.powershellBinary);
      assert.equal(calls[1].command, fixture.paths.powershellBinary);
      for (const { options } of calls) {
        assert.equal(options.env.PRESERVED_VALUE, "preserved");
        for (const name of GITHUB_CREDENTIAL_NAMES) {
          assert.equal(Object.hasOwn(options.env, name), false);
        }
      }
      assert.equal(calls[0].options.maxBuffer, 4096);
      assert.equal(calls[1].options.maxBuffer, 4096);
      assert.equal(env.GH_TOKEN, "gh-secret");
      const invocation = calls[2];
      assert.equal(invocation.command, fixture.paths.powershellBinary);
      assert.equal(invocation.options.maxBuffer, MAX_SUBPROCESS_OUTPUT_BYTES);
      assert.deepEqual(invocation.args.slice(0, 5), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
      ]);
      assert.equal(invocation.args[invocation.args.indexOf("-NodeBinary") + 1], fixture.paths.nodeBinary);
      assert.equal(invocation.args.includes("-Profile"), false);
      assert.equal(
        invocation.args.some((argument) => /Firefox\\Profiles/i.test(argument)),
        false,
      );
      const expectedPaths = new Map([
        ["-ReleaseMetadata", fixture.paths.metadataPath],
        ["-SignedXpi", fixture.paths.newXpiPath],
        ["-OldSignedXpi", fixture.paths.oldXpiPath],
        ["-ResultPath", fixture.paths.resultPath],
      ]);
      for (const [name, expected] of expectedPaths) {
        assert.equal(invocation.args[invocation.args.indexOf(name) + 1], expected);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves bounded phase diagnostics beyond the evidence limit", () => {
    const fixture = makeFixture();
    const phaseError = "manual-update-discovery phase failed: home.arpa did not resolve";
    const longContext = "x".repeat(8192);
    const stdoutDiagnostic = "child stdout diagnostic";
    try {
      assert.throws(
        () =>
          runWindowsSignedUpdateSmoke(
            {
              metadataPath: fixture.paths.metadataPath,
              newXpiPath: fixture.paths.newXpiPath,
              oldXpiPath: fixture.paths.oldXpiPath,
              resultPath: fixture.paths.resultPath,
            },
            {
              env: { SystemRoot: fixture.systemRoot },
              platform: "win32",
              processPath: fixture.paths.nodeBinary,
              runner(command, args, options) {
                if (args.includes("-Command")) {
                  const prefix = args.at(-1).endsWith("firefox-esr")
                    ? fixture.firefoxPrefix
                    : fixture.geckodriverPrefix;
                  return { status: 0, stderr: "", stdout: `${prefix}\r\n` };
                }
                assert.equal(command, fixture.paths.powershellBinary);
                assert.equal(options.maxBuffer, MAX_SUBPROCESS_OUTPUT_BYTES);
                return {
                  status: 1,
                  stderr: `${phaseError}\n${longContext}`,
                  stdout: stdoutDiagnostic,
                };
              },
              systemRoot: fixture.systemRoot,
              wrapperPath: fixture.paths.wrapperPath,
            },
          ),
        (error) => {
          assert.match(error.message, /manual-update-discovery phase failed/);
          assert.match(error.message, new RegExp(`x{${longContext.length}}`));
          assert.match(error.message, /child stdout diagnostic/);
          assert.ok(
            Buffer.byteLength(error.message, "utf8") <= MAX_SUBPROCESS_OUTPUT_BYTES + 128,
            "the operator error must remain bounded after adding its fixed prefix",
          );
          return true;
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("truncates oversized subprocess diagnostics at a UTF-8 byte boundary", () => {
    const fixture = makeFixture();
    const omittedMarker = "must-not-survive-the-bound";
    try {
      assert.throws(
        () =>
          runWindowsSignedUpdateSmoke(
            {
              metadataPath: fixture.paths.metadataPath,
              newXpiPath: fixture.paths.newXpiPath,
              oldXpiPath: fixture.paths.oldXpiPath,
              resultPath: fixture.paths.resultPath,
            },
            {
              env: { SystemRoot: fixture.systemRoot },
              platform: "win32",
              processPath: fixture.paths.nodeBinary,
              runner(_command, args) {
                if (args.includes("-Command")) {
                  const prefix = args.at(-1).endsWith("firefox-esr")
                    ? fixture.firefoxPrefix
                    : fixture.geckodriverPrefix;
                  return { status: 0, stderr: "", stdout: `${prefix}\r\n` };
                }
                return {
                  status: 1,
                  stderr: `phase failed\n${"한".repeat(MAX_SUBPROCESS_OUTPUT_BYTES)}${omittedMarker}`,
                  stdout: "",
                };
              },
              systemRoot: fixture.systemRoot,
              wrapperPath: fixture.paths.wrapperPath,
            },
          ),
        (error) => {
          assert.match(error.message, /phase failed/);
          assert.doesNotMatch(error.message, new RegExp(omittedMarker));
          assert.ok(Buffer.byteLength(error.message, "utf8") <= MAX_SUBPROCESS_OUTPUT_BYTES + 128);
          return true;
        },
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("uses explicit Firefox and geckodriver overrides without running Scoop", () => {
    const fixture = makeFixture();
    const evidence = passedEvidence();
    const calls = [];
    try {
      runWindowsSignedUpdateSmoke(
        {
          metadataPath: fixture.paths.metadataPath,
          newXpiPath: fixture.paths.newXpiPath,
          oldXpiPath: fixture.paths.oldXpiPath,
          resultPath: fixture.paths.resultPath,
        },
        {
          env: {
            FIREFOX_BINARY: fixture.paths.firefoxBinary,
            GECKODRIVER_BINARY: fixture.paths.geckodriverBinary,
            SystemRoot: fixture.systemRoot,
          },
          platform: "win32",
          processPath: fixture.paths.nodeBinary,
          runner(command, args) {
            calls.push(command);
            assert.equal(args.includes("-Command"), false);
            const resultIndex = args.indexOf("-ResultPath");
            writeFileSync(args[resultIndex + 1], JSON.stringify(evidence));
            return { status: 0, stderr: "", stdout: JSON.stringify(evidence) };
          },
          systemRoot: fixture.systemRoot,
          wrapperPath: fixture.paths.wrapperPath,
        },
      );
      assert.equal(calls.length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects oversized, malformed, and non-passing evidence", () => {
    assert.deepEqual(parseBoundedEvidence(JSON.stringify(passedEvidence())), passedEvidence());
    assert.throws(() => parseBoundedEvidence("{"), /valid JSON/i);
    assert.throws(() => parseBoundedEvidence("x".repeat(4097)), /bounded JSON/i);
    assert.throws(
      () => parseBoundedEvidence(JSON.stringify({ ...passedEvidence(), status: "failed" })),
      /values are invalid/i,
    );
    assert.throws(
      () => parseBoundedEvidence(JSON.stringify({ ...passedEvidence(), extra: true })),
      /schema is invalid/i,
    );
  });
});
