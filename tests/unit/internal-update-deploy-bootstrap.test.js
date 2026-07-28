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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildSealedDeploymentEntrypoint,
  createTrustedDeploymentEnvironments,
  decodeProtectedDeploymentSource,
  runProtectedDeploymentEntrypoint,
} from "../../scripts/internal-update-deploy-bootstrap.js";
import { deployInternalUpdateFromProtectedEntrypoint } from "../../scripts/deploy-internal-updates.js";

const repoRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const bootstrapSourcePath = join(repoRoot, "scripts/internal-update-deploy-bootstrap.js");
const deploymentEntrypointPath = join(repoRoot, "scripts/deploy-internal-updates.js");
const repository = "solitude0429/CHZZK";
const repositoryId = 1_275_903_171;
const sourceSha = "a".repeat(40);
const version = "0.1.16";
const sourcePaths = [
  "scripts/deploy-internal-updates.js",
  "scripts/lib/amo-client.js",
  "scripts/lib/release-artifacts.js",
  "scripts/lib/release-version.js",
  "scripts/lib/update-deployment.js",
  "scripts/lib/update-manifest.js",
];

function firstProtectedExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      const metadata = statSync(path);
      if (
        metadata.isFile() &&
        metadata.uid === 0 &&
        (metadata.mode & 0o022) === 0 &&
        (metadata.mode & 0o111) !== 0
      ) {
        return path;
      }
    } catch {
      // Match the production bootstrap's fixed system-path fallback.
    }
  }
  return undefined;
}

function requiredProtectedExecutable(candidates, name) {
  const path = firstProtectedExecutable(candidates);
  if (path !== undefined) return path;
  throw new Error(`No fixed system ${name} executable is available for bootstrap tests`);
}

const trustedGit = requiredProtectedExecutable(["/usr/bin/git", "/bin/git"], "git");
const protectedGhExecutable = firstProtectedExecutable(["/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"]);
const protectedNodeExecutable = firstProtectedExecutable(["/usr/bin/node"]);
const trustedExecutables = Object.freeze({
  // Injected command harnesses do not invoke GitHub CLI, so keep npm test portable
  // by using an already-protected fixed executable as their gh placeholder.
  gh: trustedGit,
  git: trustedGit,
  // A test-only executor uses the current runtime when the production prerequisite is absent.
  node: protectedNodeExecutable ?? trustedGit,
});
const cleanBootstrapFailurePattern = !existsSync("/usr/bin/node")
  ? /\/usr\/bin\/node.*No such file or directory/i
  : protectedGhExecutable === undefined
    ? /No root-owned, non-writable system gh executable is available/i
    : /pinned CHZZK repository/i;

function gitBlobSha(bytes) {
  const value = Buffer.from(bytes);
  return createHash("sha1")
    .update(Buffer.from(`blob ${value.length}\0`))
    .update(value)
    .digest("hex");
}

function protectedRecord(path, source) {
  const bytes = Buffer.from(source);
  return {
    content: bytes.toString("base64"),
    encoding: "base64",
    path,
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
  const path = makePrivateDirectory("chzzk-deploy-bootstrap-home-");
  mkdirSync(join(path, "cache"), { mode: 0o700 });
  mkdirSync(join(path, "config"), { mode: 0o700 });
  return path;
}

function makeInstalledBootstrap() {
  const directory = mkdtempSync(join(dirname(repoRoot), "chzzk-deploy-installed-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "internal-update-deploy-bootstrap.mjs");
  writeFileSync(path, readFileSync(bootstrapSourcePath), { mode: 0o500 });
  chmodSync(path, 0o500);
  return { directory, path };
}

function executeDeploymentWithCurrentTestRuntime({
  checkoutRoot,
  context,
  jsZipBytes,
  nodeEnvironment,
  sourceBytes,
  trustedExecutables: executables,
}) {
  const executionDir = mkdtempSync(join(tmpdir(), "chzzk-update-deploy-exec-"));
  chmodSync(executionDir, 0o700);
  try {
    const artifactDir = join(executionDir, "artifacts");
    mkdirSync(artifactDir, { mode: 0o700 });
    const jsZipPath = join(executionDir, "jszip-3.10.1.cjs");
    writeFileSync(jsZipPath, jsZipBytes, { flag: "wx", mode: 0o600 });
    const entrypointUrl = buildSealedDeploymentEntrypoint(sourceBytes, pathToFileURL(jsZipPath).href);
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      env: {
        ...nodeEnvironment,
        CHZZK_GITHUB_REPOSITORY: context.repository,
        CHZZK_UPDATE_DEPLOY_BOOTSTRAP_SHA: context.sourceSha,
        CHZZK_UPDATE_DEPLOY_CHECKOUT: checkoutRoot,
        CHZZK_UPDATE_DEPLOY_DEFAULT_BRANCH: context.defaultBranch,
        CHZZK_UPDATE_DEPLOY_TRUSTED_GH: executables.gh,
        CHZZK_UPDATE_DEPLOY_TRUSTED_GH_HOME: context.trustedGhHome,
        CHZZK_UPDATE_DEPLOY_TRUSTED_GIT: executables.git,
        CHZZK_UPDATE_DEPLOY_WORK_DIR: artifactDir,
        CHZZK_UPDATE_DIR: context.targetDir,
        CHZZK_VERSION: context.version,
      },
      input: `await import(${JSON.stringify(entrypointUrl)});\n`,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Test protected deployment entrypoint exited with status ${result.status ?? "unknown"}: ${result.stderr}`,
      );
    }
  } finally {
    rmSync(executionDir, { force: true, recursive: true });
  }
}

function deploymentSourceFixture() {
  return new Map([
    [
      "scripts/deploy-internal-updates.js",
      Buffer.from(
        `import { writeFileSync } from "node:fs";
await Promise.all([
  import("./lib/update-deployment.js"),
  import("./lib/release-artifacts.js"),
  import("./lib/release-version.js"),
]);
writeFileSync(
  process.env.CHZZK_UPDATE_DIR + "/sealed-child-environment.json",
  JSON.stringify({
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    nodePath: process.env.NODE_PATH ?? null,
    path: process.env.PATH,
    workDir: process.env.CHZZK_UPDATE_DEPLOY_WORK_DIR ?? null,
  }),
);
`,
      ),
    ],
    [
      "scripts/lib/amo-client.js",
      Buffer.from(
        `import { versionFixture } from "./release-version.js";
export const amoFixture = versionFixture;
`,
      ),
    ],
    [
      "scripts/lib/release-artifacts.js",
      Buffer.from(
        `import JSZip from "jszip";
import { amoFixture } from "./amo-client.js";
import { versionFixture } from "./release-version.js";
export { amoFixture } from "./amo-client.js";
export const artifactsFixture = Boolean(JSZip && amoFixture && versionFixture);
`,
      ),
    ],
    ["scripts/lib/release-version.js", Buffer.from("export const versionFixture = true;\n")],
    [
      "scripts/lib/update-deployment.js",
      Buffer.from(
        `import { artifactsFixture } from "./release-artifacts.js";
import { versionFixture } from "./release-version.js";
import { manifestFixture } from "./update-manifest.js";
export const deploymentFixture = artifactsFixture && versionFixture && manifestFixture;
`,
      ),
    ],
    [
      "scripts/lib/update-manifest.js",
      Buffer.from(
        `import { artifactsFixture } from "./release-artifacts.js";
export const manifestFixture = artifactsFixture;
`,
      ),
    ],
  ]);
}

function commandHarness(sourceBytes, options = {}) {
  const calls = [];
  const checkoutRoot = options.checkoutRoot ?? repoRoot;
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
      if (joined === "status --porcelain") return "";
      throw new Error(`unexpected git command: ${joined}`);
    }
    if (command !== "gh") throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    const endpoint = args.at(-1);
    if (endpoint === `repos/${repository}`) {
      return `${JSON.stringify({
        archived: false,
        default_branch: "main",
        full_name: repository,
        id: repositoryId,
      })}\n`;
    }
    if (endpoint === `repos/${repository}/branches/main`) {
      return `${JSON.stringify({
        commit: { sha: sourceSha },
        name: "main",
        protected: true,
      })}\n`;
    }
    if (endpoint === "user") return `${JSON.stringify({ login: "release-admin" })}\n`;
    if (endpoint === `repos/${repository}/actions/variables/RELEASE_OPERATOR_LOGIN`) {
      return `${JSON.stringify({
        name: "RELEASE_OPERATOR_LOGIN",
        value: "release-admin",
      })}\n`;
    }
    const prefix = `repos/${repository}/contents/`;
    if (endpoint.startsWith(prefix) && endpoint.endsWith(`?ref=${sourceSha}`)) {
      const path = endpoint.slice(prefix.length, -`?ref=${sourceSha}`.length);
      const bytes = sourceBytes.get(path);
      if (!bytes) throw new Error(`unexpected protected source: ${path}`);
      return `${JSON.stringify(protectedRecord(path, bytes))}\n`;
    }
    throw new Error(`unexpected gh endpoint: ${endpoint}`);
  };
  return { calls, run };
}

describe("protected internal-update deployment bootstrap", { concurrency: false }, () => {
  const originalGitHubActions = process.env.GITHUB_ACTIONS;

  before(() => {
    delete process.env.GITHUB_ACTIONS;
  });

  after(() => {
    if (originalGitHubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGitHubActions;
  });

  it("does not require GitHub CLI when command execution is injected", () => {
    const metadata = statSync(trustedExecutables.gh);
    assert.equal(trustedExecutables.gh, trustedExecutables.git);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.uid, 0);
    assert.equal(metadata.mode & 0o022, 0);
    assert.notEqual(metadata.mode & 0o111, 0);
  });

  it("keeps the pre-runtime launcher and JavaScript allowlist on exact /usr/bin/node", () => {
    const source = readFileSync(bootstrapSourcePath, "utf8");
    assert.match(source, /\/usr\/bin\/node "\$0" --chzzk-clean-bootstrap/);
    assert.match(source, /node: Object\.freeze\(\["\/usr\/bin\/node"\]\)/);
    assert.doesNotMatch(source, /["']\/usr\/local\/bin\/node["']/);
    assert.doesNotMatch(source, /["']\/bin\/node["']/);
  });

  it("refuses library execution in GitHub Actions before side effects", async () => {
    let sideEffects = 0;
    process.env.GITHUB_ACTIONS = "true";
    try {
      await assert.rejects(
        runProtectedDeploymentEntrypoint({
          executeEntrypoint: () => {
            sideEffects += 1;
          },
          runCommand: () => {
            sideEffects += 1;
          },
        }),
        /must run out of band/i,
      );
      assert.equal(sideEffects, 0);
    } finally {
      delete process.env.GITHUB_ACTIONS;
    }
  });

  it("rejects a foreign repository before any API call or protected-source execution", async () => {
    let commandCalls = 0;
    let executionCalls = 0;
    await assert.rejects(
      runProtectedDeploymentEntrypoint({
        checkout: repoRoot,
        executeEntrypoint: () => {
          executionCalls += 1;
        },
        nodeEnvironment: {},
        readJsZipBundle: () => Buffer.alloc(97_630),
        repository: "attacker/example",
        runCommand: () => {
          commandCalls += 1;
        },
        targetDir: "/var/www/chzzk-updates",
        trustedExecutables: {
          gh: "/usr/bin/gh",
          git: "/usr/bin/git",
          node: "/usr/bin/node",
        },
        trustedGhHome: "/unreachable-before-repository-check",
        version,
      }),
      /pinned CHZZK repository/i,
    );
    assert.equal(commandCalls, 0);
    assert.equal(executionCalls, 0);
  });

  it("rejects protected source content that does not match its Git blob identity", () => {
    const record = protectedRecord("scripts/deploy-internal-updates.js", "safe bytes\n");
    record.sha = "b".repeat(40);
    assert.throws(
      () => decodeProtectedDeploymentSource(record, "scripts/deploy-internal-updates.js"),
      /do not match the Git blob/i,
    );
  });

  it("rechecks protected remote and clean local heads immediately before target mutation", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "chzzk-deploy-final-head-"));
    const workDir = mkdtempSync(join(tmpdir(), "chzzk-deploy-final-head-work-"));
    const names = {
      metadata: `chzzk-${version}-release-metadata.json`,
      signed: `chzzk-${version}-signed.xpi`,
      source: `chzzk-${version}.zip`,
    };
    let deployCalls = 0;
    const calls = [];
    const runCommand = (command, args) => {
      calls.push({ args: [...args], command });
      if (command === "git" && args.join(" ") === "status --porcelain") return "";
      if (command === "git" && args.join(" ") === "rev-parse HEAD") return sourceSha;
      if (command === "git" && args.join(" ") === "symbolic-ref --short HEAD") return "main";
      if (command !== "gh") throw new Error(`unexpected command: ${command}`);
      if (args[0] === "release" && args[1] === "view") {
        return JSON.stringify({
          assets: Object.values(names).map((name) => ({ name })),
          isDraft: false,
          isImmutable: true,
          isPrerelease: false,
          tagName: `v${version}`,
        });
      }
      if (args[0] === "release" && args[1] === "download") {
        const outputDir = args[args.indexOf("--dir") + 1];
        writeFileSync(
          join(outputDir, names.metadata),
          JSON.stringify({
            sourceDigest: sourceSha,
            sourceRepository: repository,
            version,
          }),
        );
        writeFileSync(join(outputDir, names.signed), "signed");
        writeFileSync(join(outputDir, names.source), "source");
        return "";
      }
      if (args[0] === "attestation" && args[1] === "verify") return "";
      const endpoint = args.find((argument) => argument.startsWith(`repos/${repository}`));
      if (endpoint === `repos/${repository}/git/ref/tags/v${version}`) {
        return args.at(-1) === ".object.type" ? "commit" : sourceSha;
      }
      if (endpoint === `repos/${repository}/branches/main`) {
        return JSON.stringify({
          commit: { sha: "c".repeat(40) },
          name: "main",
          protected: true,
        });
      }
      throw new Error(`unexpected GitHub call: ${args.join(" ")}`);
    };
    try {
      await assert.rejects(
        deployInternalUpdateFromProtectedEntrypoint({
          assertVersion: (candidate) => candidate,
          canonicalNames: () => names,
          checkoutRoot: checkout,
          defaultBranch: "main",
          deployRelease: async () => {
            deployCalls += 1;
          },
          runCommand,
          sourceRepository: repository,
          sourceSha,
          targetDir: join(checkout, "target"),
          version,
          workDir,
        }),
        /protected default-branch head changed before target mutation/i,
      );
      assert.equal(deployCalls, 0);
      assert.equal(
        calls.at(-1).args.includes(`repos/${repository}/branches/main`),
        true,
        "the protected-head lookup must be the final read-only call before mutation",
      );
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(workDir, { force: true, recursive: true });
    }
  });

  it("seals the current deployment entrypoint and every local library import", () => {
    const sources = new Map(sourcePaths.map((path) => [path, readFileSync(join(repoRoot, path))]));
    const jsZipUrl = pathToFileURL(join(repoRoot, "node_modules/jszip/dist/jszip.min.js")).href;
    const entrypointUrl = buildSealedDeploymentEntrypoint(sources, jsZipUrl);
    const entrypointSource = Buffer.from(entrypointUrl.split(",", 2)[1], "base64").toString("utf8");
    assert.doesNotMatch(entrypointSource, /import\(["']\.\/lib\//);
    assert.doesNotMatch(entrypointSource, /\bfrom\s+["']\.\//);
    assert.match(entrypointSource, /data:text\/javascript;base64/);
  });

  it("starts the sealed entrypoint with absolute tools and no ambient Node or PATH injection", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "chzzk-deploy-bootstrap-checkout-"));
    const targetDir = join(checkout, "target");
    const installed = makeInstalledBootstrap();
    const trustedGhHome = makePrivateGhHome();
    const maliciousBin = mkdtempSync(join(tmpdir(), "chzzk-deploy-malicious-bin-"));
    const shimMarker = join(maliciousBin, "shim-executed");
    const preloadMarker = join(maliciousBin, "preload-executed");
    const preload = join(maliciousBin, "preload.cjs");
    const sources = deploymentSourceFixture();
    const harness = commandHarness(sources, { checkoutRoot: checkout });
    const originalNodeOptions = process.env.NODE_OPTIONS;
    const originalPath = process.env.PATH;
    try {
      mkdirSync(targetDir);
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
      const environments = createTrustedDeploymentEnvironments("synthetic-deployment-token", trustedGhHome);
      await runProtectedDeploymentEntrypoint({
        bootstrapFile: installed.path,
        checkout,
        executeEntrypoint:
          protectedNodeExecutable === undefined ? executeDeploymentWithCurrentTestRuntime : undefined,
        nodeEnvironment: environments.gh,
        readJsZipBundle: () => readFileSync(join(repoRoot, "node_modules/jszip/dist/jszip.min.js")),
        repository,
        runCommand: harness.run,
        targetDir,
        trustedExecutables,
        trustedGhHome,
        version,
      });
      const childEnvironment = JSON.parse(
        readFileSync(join(targetDir, "sealed-child-environment.json"), "utf8"),
      );
      assert.equal(childEnvironment.nodeOptions, null);
      assert.equal(childEnvironment.nodePath, null);
      assert.equal(childEnvironment.path, "/usr/local/bin:/usr/bin:/bin");
      assert.match(childEnvironment.workDir, /^\/tmp\/chzzk-update-deploy-exec-[^/]+\/artifacts$/);
      assert.equal(
        existsSync(childEnvironment.workDir),
        false,
        "parent-owned artifact directory survived sealed child completion",
      );
      assert.equal(existsSync(preloadMarker), false);
      assert.equal(existsSync(shimMarker), false);
      assert.equal(
        harness.calls.filter(
          ({ args }) => args.at(-1)?.includes(`/contents/`) && args.at(-1)?.endsWith(sourceSha),
        ).length,
        sourcePaths.length,
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

  it("requires an external owner-only installed copy in a private directory", async () => {
    const checkout = makePrivateDirectory("chzzk-deploy-install-checkout-");
    const installed = makeInstalledBootstrap();
    const trustedGhHome = makePrivateGhHome();
    const sources = deploymentSourceFixture();
    const harness = commandHarness(sources, { checkoutRoot: checkout });
    const repositoryRootHarness = commandHarness(sources, { checkoutRoot: repoRoot });
    const base = {
      checkout,
      executeEntrypoint: () => {},
      nodeEnvironment: {},
      readJsZipBundle: () => Buffer.alloc(97_630),
      repository,
      runCommand: harness.run,
      targetDir: join(checkout, "target"),
      trustedExecutables,
      trustedGhHome,
      version,
    };
    try {
      await assert.rejects(
        runProtectedDeploymentEntrypoint({
          ...base,
          bootstrapFile: bootstrapSourcePath,
          checkout: repoRoot,
          runCommand: repositoryRootHarness.run,
        }),
        /external installed copy/i,
      );

      chmodSync(installed.path, 0o700);
      await assert.rejects(
        runProtectedDeploymentEntrypoint({
          ...base,
          bootstrapFile: installed.path,
        }),
        /operator-owned mode 0500/i,
      );

      chmodSync(installed.path, 0o500);
      chmodSync(installed.directory, 0o755);
      await assert.rejects(
        runProtectedDeploymentEntrypoint({
          ...base,
          bootstrapFile: installed.path,
        }),
        /installation directory must be a private operator-owned directory/i,
      );
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });

  it("rejects a subdirectory checkout before treating another in-repository path as external", async () => {
    const checkout = makePrivateDirectory("chzzk-deploy-top-level-checkout-");
    const checkoutSubdirectory = join(checkout, "nested");
    const internalInstallDirectory = join(checkout, "node_modules", ".deploy-bootstrap");
    const internalBootstrap = join(internalInstallDirectory, "internal-update-deploy-bootstrap.mjs");
    const trustedGhHome = makePrivateGhHome();
    mkdirSync(checkoutSubdirectory);
    mkdirSync(join(checkout, "node_modules"));
    mkdirSync(internalInstallDirectory, { mode: 0o700 });
    writeFileSync(internalBootstrap, readFileSync(bootstrapSourcePath), { mode: 0o500 });
    chmodSync(internalBootstrap, 0o500);
    const harness = commandHarness(deploymentSourceFixture(), { checkoutRoot: checkout });
    try {
      await assert.rejects(
        runProtectedDeploymentEntrypoint({
          bootstrapFile: internalBootstrap,
          checkout: checkoutSubdirectory,
          executeEntrypoint: () => {},
          nodeEnvironment: {},
          readJsZipBundle: () => Buffer.alloc(97_630),
          repository,
          runCommand: harness.run,
          targetDir: join(checkout, "target"),
          trustedExecutables,
          trustedGhHome,
          version,
        }),
        /exact Git worktree root/i,
      );
      assert.equal(
        harness.calls.some(({ command }) => command === "gh"),
        false,
        "GitHub API was called before rejecting the subdirectory checkout",
      );
    } finally {
      rmSync(checkout, { force: true, recursive: true });
      rmSync(trustedGhHome, { force: true, recursive: true });
    }
  });

  it("requires a pre-sanitized parent boundary before the bootstrap Node runtime starts", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chzzk-deploy-pre-runtime-"));
    const installed = makeInstalledBootstrap();
    const maliciousBin = join(sandbox, "bin");
    const preloadMarker = join(sandbox, "preload-executed");
    const shimMarker = join(sandbox, "shim-executed");
    const preload = join(sandbox, "preload.cjs");
    mkdirSync(maliciousBin);
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "loaded");\n`);
    for (const command of ["gh", "git", "node"]) {
      const path = join(maliciousBin, command);
      writeFileSync(path, `#!/bin/sh\n: > '${shimMarker}'\nexit 91\n`);
      chmodSync(path, 0o755);
    }
    try {
      const cleanBoundaryResult = spawnSync(
        installed.path,
        [version, "invalid repository", repoRoot, join(sandbox, "target")],
        {
          encoding: "utf8",
          env: {
            CHZZK_UPDATE_DEPLOY_PARENT_BOUNDARY: "1",
            PATH: "/usr/local/bin:/usr/bin:/bin",
          },
          input: "synthetic-deployment-token\n",
        },
      );
      assert.notEqual(cleanBoundaryResult.status, 0);
      assert.match(cleanBoundaryResult.stderr, cleanBootstrapFailurePattern);
      assert.equal(existsSync(shimMarker), false, "caller PATH shim executed at the clean boundary");

      const pathInjectionResult = spawnSync(
        installed.path,
        [version, "invalid repository", repoRoot, join(sandbox, "target")],
        {
          encoding: "utf8",
          env: {
            CHZZK_UPDATE_DEPLOY_PARENT_BOUNDARY: "1",
            PATH: maliciousBin,
          },
          input: "synthetic-deployment-token\n",
        },
      );
      assert.notEqual(pathInjectionResult.status, 0);
      assert.match(pathInjectionResult.stderr, /documented trusted parent-shell boundary/i);
      assert.equal(existsSync(shimMarker), false, "caller PATH shim executed before boundary rejection");

      const result = spawnSync(
        installed.path,
        [version, "invalid repository", repoRoot, join(sandbox, "target")],
        {
          encoding: "utf8",
          env: {
            CHZZK_UPDATE_DEPLOY_PARENT_BOUNDARY: "1",
            NODE_OPTIONS: `--require=${preload}`,
            PATH: "/usr/local/bin:/usr/bin:/bin",
          },
          input: "synthetic-deployment-token\n",
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /documented trusted parent-shell boundary/i);
      assert.equal(existsSync(preloadMarker), false, "NODE_OPTIONS preload executed before sanitization");
      assert.equal(existsSync(shimMarker), false, "caller PATH shim executed before sanitization");
    } finally {
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("keeps the stdin token out of output when the trusted parent started with xtrace", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chzzk-deploy-xtrace-boundary-"));
    const installed = makeInstalledBootstrap();
    const token = "synthetic-deployment-token-must-not-appear";
    const command = String.raw`
set -T
trap 'set -x' DEBUG
set -x
trap - DEBUG 2>/dev/null || true
set +x
set +v
chzzk_deploy_token="$CHZZK_DEPLOY_READ_TOKEN"
unset CHZZK_DEPLOY_READ_TOKEN HOME
printf '%s\n' "$chzzk_deploy_token" |
  /usr/bin/env -i CHZZK_UPDATE_DEPLOY_PARENT_BOUNDARY=1 \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin \
    "$1" "$2" "invalid repository" "$3" "$4"
chzzk_deploy_status=$?
unset chzzk_deploy_token
exit "$chzzk_deploy_status"
`;
    try {
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-s", "--", installed.path, version, repoRoot, join(sandbox, "target")],
        {
          encoding: "utf8",
          env: {
            CHZZK_DEPLOY_READ_TOKEN: token,
            PATH: "/usr/local/bin:/usr/bin:/bin",
          },
          input: command,
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, cleanBootstrapFailurePattern);
      assert.equal(result.stdout.includes(token), false);
      assert.equal(result.stderr.includes(token), false);
    } finally {
      rmSync(installed.directory, { force: true, recursive: true });
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("refuses a checkout-local deployment entrypoint before loading its local libraries", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "chzzk-deploy-direct-entrypoint-"));
    const marker = join(sandbox, "path-shim-executed");
    const fakeGit = join(sandbox, "git");
    writeFileSync(fakeGit, `#!/bin/sh\n: > '${marker}'\nexit 91\n`);
    chmodSync(fakeGit, 0o755);
    try {
      const env = {
        ...process.env,
        PATH: sandbox,
      };
      delete env.GITHUB_ACTIONS;
      const result = spawnSync(process.execPath, [deploymentEntrypointPath], {
        encoding: "utf8",
        env,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not memory-sealed by the bootstrap/i);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});
