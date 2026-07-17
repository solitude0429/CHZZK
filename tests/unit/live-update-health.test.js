import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { RELEASE_PACKAGE_FILES } from "../../scripts/lib/amo-client.js";
import {
  checkLiveUpdate,
  productionUpdateIdentity,
  readBoundedResponse,
  validateLiveUpdateDocument,
} from "../../scripts/lib/live-update-health.js";

const productionManifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseFixture() {
  const version = "0.1.6";
  const sourceArchive = Buffer.from("synthetic-source-archive");
  const signedXpi = Buffer.from("synthetic-signed-xpi");
  const metadata = {
    addOnId: "chzzk@solitude0429.local",
    files: RELEASE_PACKAGE_FILES.map((path, index) => ({
      path,
      sha256: String(index + 1).padStart(64, "0"),
      size: index + 1,
    })),
    schemaVersion: 1,
    sourceArchive: {
      name: `chzzk-${version}.zip`,
      sha256: sha256(sourceArchive),
      size: sourceArchive.length,
    },
    sourceDigest: "a".repeat(40),
    sourceRepository: "solitude0429/CHZZK",
    strictMinVersion: "140.0",
    updateManifestUrl: "https://chzzk-updates.alpha-apple.dedyn.io/updates.json",
    version,
  };
  const document = {
    addons: {
      "chzzk@solitude0429.local": {
        updates: [
          {
            applications: { gecko: { strict_min_version: "140.0" } },
            update_hash: `sha256:${sha256(signedXpi)}`,
            update_link: `https://chzzk-updates.alpha-apple.dedyn.io/releases/${version}/chzzk-${version}-signed.xpi`,
            version,
          },
        ],
      },
    },
  };
  return {
    document,
    metadata,
    metadataBytes: Buffer.from(`${JSON.stringify(metadata)}\n`),
    signedXpi,
    sourceArchive,
  };
}

function response(bytes, contentType) {
  return new Response(bytes, {
    headers: {
      "content-length": String(bytes.length),
      "content-type": contentType,
    },
    status: 200,
  });
}

describe("live Firefox update health", () => {
  it("validates the exact update schema and complete hosted release set", async () => {
    const fixture = releaseFixture();
    const manifestBytes = Buffer.from(`${JSON.stringify(fixture.document)}\n`);
    const requested = [];
    const responses = [
      response(manifestBytes, "application/json"),
      response(fixture.metadataBytes, "application/json"),
      response(fixture.sourceArchive, "application/zip"),
      response(fixture.signedXpi, "application/x-xpinstall"),
    ];
    const fetchImpl = async (url) => {
      requested.push(String(url));
      return responses.shift();
    };

    const result = await checkLiveUpdate({ fetchImpl, productionManifest });
    assert.equal(result.version, "0.1.6");
    assert.equal(result.signedXpiBytes, fixture.signedXpi.length);
    assert.equal(result.sourceArchiveBytes, fixture.sourceArchive.length);
    assert.equal(requested[0], productionManifest.browser_specific_settings.gecko.update_url);
    assert.match(requested[1], /\/releases\/0\.1\.6\/chzzk-0\.1\.6-release-metadata\.json$/);
    assert.match(requested[2], /\/releases\/0\.1\.6\/chzzk-0\.1\.6\.zip$/);
    assert.match(requested[3], /\/releases\/0\.1\.6\/chzzk-0\.1\.6-signed\.xpi$/);
  });

  it("rejects noncanonical origins, paths, versions, and minimum-version drift", () => {
    const identity = productionUpdateIdentity(productionManifest);
    for (const mutate of [
      (document) => {
        document.addons[identity.addOnId].updates[0].update_link =
          "https://example.invalid/releases/0.1.6/chzzk-0.1.6-signed.xpi";
      },
      (document) => {
        document.addons[identity.addOnId].updates[0].update_link =
          "https://chzzk-updates.alpha-apple.dedyn.io/current.xpi";
      },
      (document) => {
        document.addons[identity.addOnId].updates[0].version = "01.6.0";
      },
      (document) => {
        document.addons[identity.addOnId].updates[0].applications.gecko.strict_min_version = "141.0";
      },
    ]) {
      const { document } = releaseFixture();
      mutate(document);
      assert.throws(
        () => validateLiveUpdateDocument(document, identity),
        /origin|canonical|version|minimum Firefox/i,
      );
    }
  });

  it("rejects metadata/source drift and malformed UTF-8 JSON", async () => {
    const fixture = releaseFixture();
    fixture.metadata.sourceArchive.sha256 = "0".repeat(64);
    fixture.metadataBytes = Buffer.from(`${JSON.stringify(fixture.metadata)}\n`);
    const responses = [
      response(Buffer.from(`${JSON.stringify(fixture.document)}\n`), "application/json"),
      response(fixture.metadataBytes, "application/json"),
      response(fixture.sourceArchive, "application/zip"),
    ];
    await assert.rejects(
      () =>
        checkLiveUpdate({
          fetchImpl: async () => responses.shift(),
          productionManifest,
        }),
      /source archive.*release metadata/i,
    );

    await assert.rejects(
      () =>
        checkLiveUpdate({
          fetchImpl: async () => response(Buffer.from([0xc3, 0x28]), "application/json"),
          productionManifest,
        }),
      /UTF-8/i,
    );
  });

  it("reports bounded network failure causes", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND update-host.invalid"), {
      code: "ENOTFOUND",
    });
    const failure = Object.assign(new Error("fetch failed"), { cause });
    await assert.rejects(
      () =>
        checkLiveUpdate({
          fetchImpl: async () => {
            throw failure;
          },
          productionManifest,
        }),
      /Live update manifest request failed \[ENOTFOUND\]: getaddrinfo ENOTFOUND update-host\.invalid/,
    );
  });

  it("enforces response media types, bounds, and nonempty bodies", async () => {
    await assert.rejects(
      () =>
        readBoundedResponse(response(Buffer.from("{}"), "text/plain"), {
          expectedMediaType: "application/json",
          label: "fixture",
          maxBytes: 1024,
        }),
      /Content-Type/i,
    );
    await assert.rejects(
      () =>
        readBoundedResponse(response(Buffer.alloc(8), "application/json"), {
          expectedMediaType: "application/json",
          label: "fixture",
          maxBytes: 4,
        }),
      /size limit/i,
    );
  });
});
