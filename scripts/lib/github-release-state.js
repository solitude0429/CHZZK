import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { canonicalReleaseAssetNames, verifySignedReleaseStructure } from "./release-artifacts.js";
import { assertCanonicalReleaseVersion } from "./release-version.js";

const FULL_GIT_SHA_RE = /^[a-f0-9]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_API_HEADERS = [
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2026-03-10",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultRunGh(args, options = {}) {
  const commandArgs = args[0] === "api" ? ["api", ...GITHUB_API_HEADERS, ...args.slice(1)] : args;
  const result = spawnSync("gh", commandArgs, {
    encoding: "utf8",
    env: { ...process.env, GH_REPO: options.repository ?? process.env.GH_REPO },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${commandArgs.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function flattenPages(value, label) {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} did not return paginated arrays`);
  }
  return value.flat();
}

function listMatchingReleases(runGh, repository, tag) {
  const pages = parseJson(
    runGh(["api", "--method", "GET", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`], {
      repository,
    }),
    "Release listing",
  );
  const matches = flattenPages(pages, "Release listing").filter((release) => release?.tag_name === tag);
  if (matches.length > 1) throw new Error(`Multiple releases claim the expected tag: ${tag}`);
  return matches[0] ?? null;
}

function resolveTagCommit(runGh, repository, tag) {
  const pages = parseJson(
    runGh(
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        `repos/${repository}/git/matching-refs/tags/${tag}`,
      ],
      { repository },
    ),
    "Tag listing",
  );
  const exactRef = `refs/tags/${tag}`;
  const matches = flattenPages(pages, "Tag listing").filter((entry) => entry?.ref === exactRef);
  if (matches.length > 1) throw new Error(`Multiple exact Git tag refs exist: ${tag}`);
  if (matches.length === 0) return null;

  let object = matches[0].object;
  const visited = new Set();
  for (let depth = 0; depth < 5; depth += 1) {
    const digest = String(object?.sha ?? "").toLowerCase();
    if (!FULL_GIT_SHA_RE.test(digest) || visited.has(digest)) {
      throw new Error(`Release tag ${tag} has an invalid or cyclic Git object`);
    }
    visited.add(digest);
    if (object.type === "commit") return digest;
    if (object.type !== "tag") throw new Error(`Release tag ${tag} does not resolve to a commit`);
    const annotated = parseJson(
      runGh(["api", "--method", "GET", `repos/${repository}/git/tags/${digest}`], { repository }),
      "Annotated tag lookup",
    );
    object = annotated.object;
  }
  throw new Error(`Release tag ${tag} exceeded the annotated-tag depth limit`);
}

function releaseAssetNames(release) {
  if (!Array.isArray(release.assets)) throw new Error("GitHub release asset list is missing");
  const names = release.assets.map((asset) => asset?.name);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    throw new Error("GitHub release contains malformed or duplicate asset names");
  }
  return names;
}

function assertAssetSubset(actualNames, allowedNames, exact) {
  const allowed = new Set(allowedNames);
  for (const name of actualNames) {
    if (!allowed.has(name)) throw new Error(`Refusing unexpected release asset: ${name}`);
  }
  if (
    exact &&
    (actualNames.length !== allowed.size || allowedNames.some((name) => !actualNames.includes(name)))
  ) {
    throw new Error("Published release does not contain the exact expected asset set");
  }
}

function downloadAsset(runGh, { directory, name, repository, tag }) {
  runGh(["release", "download", tag, "--repo", repository, "--dir", directory, "--pattern", name], {
    repository,
  });
  const path = join(directory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Downloaded release asset is not a regular file: ${name}`);
  }
  return path;
}

function requireEqualBytes(expectedPath, actualPath, name) {
  if (!readFileSync(expectedPath).equals(readFileSync(actualPath))) {
    throw new Error(`Existing release asset bytes differ from the prepared input: ${name}`);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeVerifiedSignedOutput(path, bytes) {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  fsyncDirectory(dirname(path));
}

export function assertDeployableReleaseSummary(release, { expectedAssetNames, tag }) {
  if (!release || typeof release !== "object") throw new Error("Release lookup returned no object");
  if (release.isDraft !== false) throw new Error("Release must be published before deployment");
  if (release.isPrerelease !== false) throw new Error("Prereleases cannot be deployed to the stable channel");
  if (release.isImmutable !== true) throw new Error("Release must be immutable before deployment");
  if (release.tagName !== tag) throw new Error("Release tag mismatch");
  const names = releaseAssetNames(release);
  assertAssetSubset(names, expectedAssetNames, true);
  return release;
}

export async function inspectPreSignReleaseState({
  metadataPath,
  repository,
  runGh = defaultRunGh,
  signedXpiPath,
  sourceArchivePath,
  sourceSha,
  version,
}) {
  assertCanonicalReleaseVersion(version);
  if (!REPOSITORY_RE.test(String(repository ?? ""))) throw new Error("Invalid GitHub repository identity");
  sourceSha = String(sourceSha ?? "").toLowerCase();
  if (!FULL_GIT_SHA_RE.test(sourceSha)) throw new Error("Source commit must be one full Git SHA");

  const expected = canonicalReleaseAssetNames(version);
  if (
    basename(sourceArchivePath) !== expected.source ||
    basename(metadataPath) !== expected.metadata ||
    basename(signedXpiPath) !== expected.signed
  ) {
    throw new Error("Release state inspection requires canonical local asset basenames");
  }

  const tag = `v${version}`;
  const release = listMatchingReleases(runGh, repository, tag);
  const tagCommit = resolveTagCommit(runGh, repository, tag);
  if (!release) {
    if (tagCommit) throw new Error(`Refusing orphan release tag without a release: ${tag}`);
    return { draftSignedReady: false, reuseExisting: false, signedSha256: "" };
  }
  if (release.tag_name !== tag) throw new Error("Release tag identity mismatch");
  if (release.prerelease !== false) throw new Error("Release state must not be a prerelease");
  if (typeof release.draft !== "boolean") throw new Error("Release draft state is unknown");

  const actualAssetNames = releaseAssetNames(release);
  const allowedAssetNames = [expected.source, expected.metadata, expected.signed];
  assertAssetSubset(actualAssetNames, allowedAssetNames, !release.draft);

  if (release.draft) {
    if (release.immutable !== false) throw new Error("Draft release immutable state is unknown or invalid");
    if (release.target_commitish !== sourceSha) {
      throw new Error("Draft release target commit does not match the exact source commit");
    }
    if (tagCommit && tagCommit !== sourceSha) {
      throw new Error("Draft release tag resolves to a different source commit");
    }
  } else {
    if (release.immutable !== true) throw new Error("Published release is not immutable");
    if (!tagCommit || tagCommit !== sourceSha) {
      throw new Error("Published release tag does not resolve to the exact source commit");
    }
  }

  const verificationDir = mkdtempSync(join(tmpdir(), "chzzk-release-state-"));
  chmodSync(verificationDir, 0o700);
  try {
    const downloaded = new Map();
    for (const name of actualAssetNames) {
      downloaded.set(name, downloadAsset(runGh, { directory: verificationDir, name, repository, tag }));
    }
    if (downloaded.has(expected.source)) {
      requireEqualBytes(sourceArchivePath, downloaded.get(expected.source), expected.source);
    }
    if (downloaded.has(expected.metadata)) {
      requireEqualBytes(metadataPath, downloaded.get(expected.metadata), expected.metadata);
    }

    let verifiedSigned = null;
    if (downloaded.has(expected.signed)) {
      if (!downloaded.has(expected.source) || !downloaded.has(expected.metadata)) {
        throw new Error("A resumable signed draft must also contain its exact source and metadata assets");
      }
      verifiedSigned = await verifySignedReleaseStructure({
        metadataPath,
        signedXpiPath: downloaded.get(expected.signed),
        sourceArchivePath,
      });
      const signedBytes = verifiedSigned.signedXpiBytes;
      if (sha256(signedBytes) !== verifiedSigned.signedXpiSha256) {
        throw new Error("Verified signed release bytes changed before local reuse");
      }
      writeVerifiedSignedOutput(signedXpiPath, signedBytes);
    }

    if (!release.draft) {
      for (const name of allowedAssetNames) {
        runGh(
          [
            "attestation",
            "verify",
            downloaded.get(name),
            "--repo",
            repository,
            "--source-digest",
            sourceSha,
            "--signer-workflow",
            `${repository}/.github/workflows/sign-unlisted.yml`,
          ],
          { repository },
        );
      }
      return {
        draftSignedReady: false,
        reuseExisting: true,
        signedSha256: verifiedSigned.signedXpiSha256,
      };
    }

    return {
      draftSignedReady: Boolean(verifiedSigned),
      reuseExisting: false,
      signedSha256: verifiedSigned?.signedXpiSha256 ?? "",
    };
  } finally {
    rmSync(verificationDir, { force: true, recursive: true });
  }
}
