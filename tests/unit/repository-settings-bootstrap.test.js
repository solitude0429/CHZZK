import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTrustedSettingsEnvironments,
  decodeProtectedConfigurator,
  runProtectedRepositorySettings,
} from "../../scripts/repository-settings-bootstrap.js";

const repoRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const bootstrapSourcePath = join(repoRoot, "scripts/repository-settings-bootstrap.js");
const configuratorSourcePath = join(repoRoot, "scripts/configure-repository.js");
const repository = "solitude0429/CHZZK";
const sourceSha = "a".repeat(40);
const trustedExecutables = Object.freeze({
  gh: realpathSync("/usr/local/bin/gh"),
  git: realpathSync("/usr/bin/git"),
  node: realpathSync("/usr/bin/node"),
});

function gitBlobSha(bytes) {
  const value = Buffer.from(bytes);
  return createHash("sha1")
    .update(Buffer.from(`blob ${value.length}\0`))
    .update(value)
    .digest("hex");
}

function protectedRecord(source) {
  const bytes = Buffer.from(source);
  return {
    content: bytes.toString("base64"),
    encoding: "base64",
    path: "scripts/configure-repository.js",
    sha: gitBlobSha(bytes),
    size: bytes.length,
    type: "file",
  };
}

function makePrivateDirectory(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  return path;
}

function makePrivateGhHome() {
  const path = makePrivateDirectory("chzzk-settings-gh-");
  mkdirSync(join(path, "cache"), { mode: 0o700 });
  mkdirSync(join(path, "config"), { mode: 0o700 });
  return path;
}

function makeInstalledBootstrap() {
  const directory = mkdtempSync(join(dirname(repoRoot), "chzzk-settings-installed-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "repository-settings-bootstrap.mjs");
  writeFileSync(path, readFileSync(bootstrapSourcePath), { mode: 0o500 });
  chmodSync(path, 0o500);
  return { directory, path };
}

function commandHarness(source, options = {}) {
  const calls = [];
  let branchReads = 0;
  const checkoutRoot = options.checkoutRoot;
  const run = (command, args) => {
    calls.push({ args: [...args], command });
    if (command === "git") {
      const joined = args.join(" ");
      if (joined === "rev-parse --show-toplevel") return `${checkoutRoot}\n`;
      if (joined === "remote get-url origin") {
        return `https://github.com/${repository}.git\n`;
      }
      if (joined === "rev-parse HEAD") return `${sourceSha}\n`;
      if (joined === "symbolic-ref --short HEAD") return "main\n";
      if (joined === "status --porcelain=v1 --untracked-files=all") {
        return options.dirty ? " M scripts/configure-repository.js\n" : "";
      }
      throw new Error(`unexpected git command: ${joined}`);
    }
    if (command !== "gh") throw new Error(`unexpected command: ${command}`);
    const endpoint = args.at(-1);
    if (endpoint === `repos/${repository}`) {
      return `${JSON.stringify({
        archived: false,
        default_branch: "main",
        full_name: repository,
        id: options.repositoryId ?? 1_275_903_171,
      })}\n`;
    }
    if (endpoint === `repos/${repository}/branches/main`) {
      branchReads += 1;
      return `${JSON.stringify({
        commit: {
          sha: options.moveHead && branchReads > 1 ? "b".repeat(40) : sourceSha,
        },
        name: "main",
        protected: true,
      })}\n`;
    }
    if (endpoint === "user") return `${JSON.stringify({ login: "release-admin" })}\n`;
    if (endpoint === `repos/${repository}/collaborators/release-admin/permission`) {
      return `${JSON.stringify({
        permission: options.permission ?? "admin",
        user: { login: "release-admin" },
      })}\n`;
    }
    if (endpoint === `repos/${repository}/contents/scripts/configure-repository.js?ref=${sourceSha}`) {
      return `${JSON.stringify(protectedRecord(source))}\n`;
    }
    throw new Error(`unexpected gh endpoint: ${endpoint}`);
  };
  return { calls, run };
}

describe("protected repository settings bootstrap", { concurrency: false }, () => {
  it("rejects malformed and blob-mismatched protected configurator records", () => {
    const nonCanonical = protectedRecord("export const value = true;\n");
    nonCanonical.content = `${nonCanonical.content}\n!`;
    assert.throws(() => decodeProtectedConfigurator(nonCanonical), /not canonical base64/i);

    const mismatched = protectedRecord("export const value = true;\n");
    mismatched.sha = "b".repeat(40);
    assert.throws(() => decodeProtectedConfigurator(mismatched), /do not match the Git blob identity/i);
  });

  it("executes only the exact protected blob with a sealed context and sanitized child environment", async () => {
    const checkout = makePrivateDirectory("chzzk-settings-checkout-");
    const trustedGhHome = makePrivateGhHome();
    const installed = makeInstalledBootstrap();
    const maliciousBin = makePrivateDirectory("chzzk-settings-malicious-bin-");
    const preloadMarker = join(maliciousBin, "preload-executed");
    const shimMarker = join(maliciousBin, "shim-executed");
    const resultPath = join(checkout, "sealed-settings-context.json");
    const preload = join(maliciousBin, "preload.cjs");
    const source = `
import { writeFileSync } from "node:fs";
writeFileSync(
  process.env.CHZZK_REPOSITORY_SETTINGS_CHECKOUT + "/sealed-settings-context.json",
  JSON.stringify({
    bootstrapSha: process.env.CHZZK_REPOSITORY_SETTINGS_BOOTSTRAP_SHA,
    defaultBranch: process.env.CHZZK_REPOSITORY_SETTINGS_DEFAULT_BRANCH,
    importProtocol: import.meta.url.slice(0, import.meta.url.indexOf(":")),
    mode: process.env.CHZZK_REPOSITORY_SETTINGS_MODE,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    nodePath: process.env.NODE_PATH ?? null,
    operatorLogin: process.env.CHZZK_REPOSITORY_SETTINGS_OPERATOR_LOGIN,
    path: process.env.PATH,
    repository: process.env.CHZZK_GITHUB_REPOSITORY,
    trustedGh: process.env.CHZZK_REPOSITORY_SETTINGS_TRUSTED_GH,
    trustedGit: process.env.CHZZK_REPOSITORY_SETTINGS_TRUSTED_GIT,
    trustedNode: process.env.CHZZK_REPOSITORY_SETTINGS_TRUSTED_NODE,
  }),
);
`;
    const harness = commandHarness(source, { checkoutRoot: checkout });
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const originalPath = process.env.PATH;
    try {
      writeFileSync(
        preload,
        `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "loaded");\n`,
      );
      for (const command of ["gh", "git", "node"]) {
        const path = join(maliciousBin, command);
        writeFileSync(path, `#!/bin/sh\n: > '${shimMarker}'\nexit 91\n`);
        chmodSync(path, 0o755);
      }
      process.env.NODE_OPTIONS = `--require=${preload}`;
      process.env.PATH = maliciousBin;
      const environments = createTrustedSettingsEnvironments("synthetic-settings-token", trustedGhHome);
      const context = await runProtectedRepositorySettings({
        apply: true,
        bootstrapFile: installed.path,
        checkout,
        nodeEnvironment: environments.gh,
        repository,
        runCommand: harness.run,
        trustedExecutables,
        trustedGhHome,
      });

      assert.deepEqual(context, {
        apply: true,
        defaultBranch: "main",
        operatorLogin: "release-admin",
        repository,
        sourceSha,
        trustedGhHome,
      });
      assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), {
        bootstrapSha: sourceSha,
        defaultBranch: "main",
        importProtocol: "data",
        mode: "apply",
        nodeOptions: null,
        nodePath: null,
        operatorLogin: "release-admin",
        path: "/usr/local/bin:/usr/bin:/bin",
        repository,
        trustedGh: trustedExecutables.gh,
        trustedGit: trustedExecutables.git,
        trustedNode: trustedExecutables.node,
      });
      assert.equal(existsSync(preloadMarker), false);
      assert.equal(existsSync(shimMarker), false);
      assert.equal(
        harness.calls.filter(({ args }) =>
          args.at(-1)?.includes("/contents/scripts/configure-repository.js?ref="),
        ).length,
        1,
      );
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(maliciousBin, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });

  it("requires a clean trusted-parent boundary before the token reaches absolute Node", () => {
    const checkout = makePrivateDirectory("chzzk-settings-boundary-checkout-");
    const installed = makeInstalledBootstrap();
    const maliciousBin = makePrivateDirectory("chzzk-settings-boundary-bin-");
    const preloadMarker = join(maliciousBin, "preload-executed");
    const shimMarker = join(maliciousBin, "shim-executed");
    const preload = join(maliciousBin, "preload.cjs");
    const token = "synthetic-boundary-token";
    try {
      writeFileSync(
        preload,
        `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "loaded");\n`,
      );
      for (const command of ["gh", "git", "node"]) {
        const path = join(maliciousBin, command);
        writeFileSync(path, `#!/bin/sh\n: > '${shimMarker}'\nexit 91\n`);
        chmodSync(path, 0o755);
      }
      const cleanParentEnvironment = {
        CHZZK_REPOSITORY_SETTINGS_PARENT_BOUNDARY: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/local/bin:/usr/bin:/bin",
      };
      const unmarked = spawnSync(installed.path, ["invalid repository", checkout], {
        encoding: "utf8",
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
        },
        input: `${token}\n`,
      });
      assert.notEqual(unmarked.status, 0);
      assert.match(unmarked.stderr, /trusted parent-shell boundary/i);
      const rejectedNames = [
        "ALL_PROXY",
        "BASH_ENV",
        "CDPATH",
        "CHZZK_RELEASE_ADMIN_TOKEN",
        "CHZZK_REPOSITORY_ADMIN_TOKEN",
        "CURL_CA_BUNDLE",
        "ENV",
        "GH_ENTERPRISE_TOKEN",
        "GH_TOKEN",
        "GITHUB_ACTIONS",
        "GITHUB_ENTERPRISE_TOKEN",
        "GITHUB_TOKEN",
        "GLOBIGNORE",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LD_AUDIT",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "NODE_EXTRA_CA_CERTS",
        "NODE_OPTIONS",
        "NODE_PATH",
        "NO_PROXY",
        "REQUESTS_CA_BUNDLE",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "XDG_CONFIG_HOME",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ];
      for (const name of rejectedNames) {
        const value = name === "NODE_OPTIONS" ? `--require=${preload}` : "";
        const rejected = spawnSync(installed.path, ["invalid repository", checkout], {
          encoding: "utf8",
          env: { ...cleanParentEnvironment, [name]: value },
          input: `${token}\n`,
        });
        assert.notEqual(rejected.status, 0, name);
        assert.match(rejected.stderr, /trusted parent-shell boundary/i, name);
        assert.equal(rejected.stderr.includes(token), false, name);
      }
      const pathRejected = spawnSync(installed.path, ["invalid repository", checkout], {
        encoding: "utf8",
        env: {
          ...cleanParentEnvironment,
          PATH: maliciousBin,
        },
        input: `${token}\n`,
      });
      assert.notEqual(pathRejected.status, 0);
      assert.match(pathRejected.stderr, /trusted parent-shell boundary/i);

      const clean = spawnSync(installed.path, ["invalid repository", checkout], {
        encoding: "utf8",
        env: cleanParentEnvironment,
        input: `${token}\n`,
      });
      assert.notEqual(clean.status, 0);
      assert.match(clean.stderr, /owner\/repository form/i);
      assert.equal(clean.stderr.includes(token), false);
      assert.equal(existsSync(preloadMarker), false, "NODE_OPTIONS preload ran before sanitization");
      assert.equal(existsSync(shimMarker), false, "caller PATH shim ran before sanitization");
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(maliciousBin, { force: true, recursive: true });
    }
  });

  it("keeps the settings token out of output when the trusted parent started with xtrace", () => {
    const checkout = makePrivateDirectory("chzzk-settings-xtrace-checkout-");
    const installed = makeInstalledBootstrap();
    const token = "synthetic-settings-token-must-not-appear";
    const command = String.raw`
set -T
trap 'set -x' DEBUG
set -x
trap - DEBUG 2>/dev/null || true
set +x
set +v
chzzk_settings_token="$CHZZK_REPOSITORY_ADMIN_TOKEN"
unset CHZZK_REPOSITORY_ADMIN_TOKEN HOME
printf '%s\n' "$chzzk_settings_token" |
  /usr/bin/env -i CHZZK_REPOSITORY_SETTINGS_PARENT_BOUNDARY=1 \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \
    "$1" "invalid repository" "$2"
chzzk_settings_status=$?
unset chzzk_settings_token
exit "$chzzk_settings_status"
`;
    try {
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", command, "chzzk-settings-xtrace-test", installed.path, checkout],
        {
          encoding: "utf8",
          env: {
            CHZZK_REPOSITORY_ADMIN_TOKEN: token,
            PATH: "/usr/local/bin:/usr/bin:/bin",
          },
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /owner\/repository form/i);
      assert.equal(result.stdout.includes(token), false);
      assert.equal(result.stderr.includes(token), false);
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
    }
  });

  it("rejects a dirty checkout before protected source execution", async () => {
    const checkout = makePrivateDirectory("chzzk-settings-dirty-checkout-");
    const installed = makeInstalledBootstrap();
    const trustedGhHome = makePrivateGhHome();
    const harness = commandHarness("throw new Error('must not execute');\n", {
      checkoutRoot: checkout,
      dirty: true,
    });
    let executed = false;
    try {
      await assert.rejects(
        runProtectedRepositorySettings({
          bootstrapFile: installed.path,
          checkout,
          executeConfigurator: () => {
            executed = true;
          },
          nodeEnvironment: {},
          repository,
          runCommand: harness.run,
          trustedExecutables,
          trustedGhHome,
        }),
        /exact clean protected default-branch checkout/i,
      );
      assert.equal(executed, false);
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });

  it("rejects a moved protected head before configurator execution", async () => {
    const checkout = makePrivateDirectory("chzzk-settings-moved-checkout-");
    const installed = makeInstalledBootstrap();
    const trustedGhHome = makePrivateGhHome();
    const harness = commandHarness("throw new Error('must not execute');\n", {
      checkoutRoot: checkout,
      moveHead: true,
    });
    let executed = false;
    try {
      await assert.rejects(
        runProtectedRepositorySettings({
          apply: true,
          bootstrapFile: installed.path,
          checkout,
          executeConfigurator: () => {
            executed = true;
          },
          nodeEnvironment: {},
          repository,
          runCommand: harness.run,
          trustedExecutables,
          trustedGhHome,
        }),
        /head changed before configurator execution/i,
      );
      assert.equal(executed, false);
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });

  it("requires an external owner-only installed copy and a private GitHub home", async () => {
    const checkout = makePrivateDirectory("chzzk-settings-install-checkout-");
    const trustedGhHome = makePrivateGhHome();
    const harness = commandHarness("export {};\n", { checkoutRoot: repoRoot });
    try {
      await assert.rejects(
        runProtectedRepositorySettings({
          bootstrapFile: bootstrapSourcePath,
          checkout: repoRoot,
          executeConfigurator: () => {},
          nodeEnvironment: {},
          repository,
          runCommand: harness.run,
          trustedExecutables,
          trustedGhHome,
        }),
        /external installed copy/i,
      );
      chmodSync(trustedGhHome, 0o755);
      assert.throws(
        () => createTrustedSettingsEnvironments("synthetic-settings-token", trustedGhHome),
        /private operator-owned directory/i,
      );
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });

  it("refuses direct checkout configurator mutation before running a PATH command", () => {
    const maliciousBin = makePrivateDirectory("chzzk-settings-direct-bin-");
    const shimMarker = join(maliciousBin, "shim-executed");
    const fakeGh = join(maliciousBin, "gh");
    try {
      writeFileSync(fakeGh, `#!/bin/sh\n: > '${shimMarker}'\nexit 91\n`);
      chmodSync(fakeGh, 0o755);
      const result = spawnSync(process.execPath, [configuratorSourcePath, "--apply"], {
        encoding: "utf8",
        env: {
          ...process.env,
          CHZZK_GH_COMMAND: fakeGh,
          CHZZK_GITHUB_REPOSITORY: repository,
          CHZZK_RELEASE_OPERATOR_LOGIN: "release-admin",
          PATH: maliciousBin,
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not memory-sealed by the external protected bootstrap/i);
      assert.equal(existsSync(shimMarker), false);
    } finally {
      rmSync(maliciousBin, { force: true, recursive: true });
    }
  });

  it("requires exact admin authority without exposing credentials", async () => {
    const checkout = makePrivateDirectory("chzzk-settings-permission-checkout-");
    const installed = makeInstalledBootstrap();
    const trustedGhHome = makePrivateGhHome();
    const harness = commandHarness("export {};\n", {
      checkoutRoot: checkout,
      permission: "write",
    });
    try {
      await assert.rejects(
        runProtectedRepositorySettings({
          bootstrapFile: installed.path,
          checkout,
          executeConfigurator: () => {},
          nodeEnvironment: {},
          repository,
          runCommand: harness.run,
          trustedExecutables,
          trustedGhHome,
        }),
        /does not have exact admin authority/i,
      );
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });

  it("rejects a mismatched immutable repository identity before fetching source", async () => {
    const checkout = makePrivateDirectory("chzzk-settings-identity-checkout-");
    const installed = makeInstalledBootstrap();
    const trustedGhHome = makePrivateGhHome();
    const harness = commandHarness("throw new Error('must not fetch');\n", {
      checkoutRoot: checkout,
      repositoryId: 42,
    });
    try {
      await assert.rejects(
        runProtectedRepositorySettings({
          bootstrapFile: installed.path,
          checkout,
          executeConfigurator: () => {},
          nodeEnvironment: {},
          repository,
          runCommand: harness.run,
          trustedExecutables,
          trustedGhHome,
        }),
        /identity is missing, archived, or mismatched/i,
      );
      assert.equal(
        harness.calls.some(({ args }) => args.at(-1)?.includes("/contents/")),
        false,
      );
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });
});
