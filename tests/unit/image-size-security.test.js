import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "node:test";

const require = createRequire(import.meta.url);
const linterRequire = createRequire(require.resolve("addons-linter"));
const parserPath = linterRequire.resolve("image-size");

function box(name, payload, declaredSize = payload.length + 8) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(declaredSize);
  header.write(name, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function heif(size) {
  const dimensions = Buffer.alloc(12);
  dimensions.writeUInt32BE(64, 4);
  dimensions.writeUInt32BE(32, 8);
  return Buffer.concat([
    box("ftyp", Buffer.from("heic\0\0\0\0")),
    box("meta", Buffer.concat([Buffer.alloc(4), box("iprp", box("ipco", box("ispe", dimensions, size)))])),
  ]);
}

function jxl(size) {
  return Buffer.concat([
    box("JXL ", Buffer.from([13, 10, 135, 10])),
    box("ftyp", Buffer.from("jxl \0\0\0\0")),
    box("jxlp", Buffer.from([0, 0, 0, 0, 255, 10, 1, 0]), size),
  ]);
}

function icns(size) {
  const input = Buffer.alloc(16);
  input.write("icns", 0, "ascii");
  input.writeUInt32BE(input.length, 4);
  input.write("ic07", 8, "ascii");
  input.writeUInt32BE(size, 12);
  return input;
}

function parseBounded(input) {
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      "-e",
      `try {
        console.log(JSON.stringify({size: require(${JSON.stringify(parserPath)}).imageSize(Buffer.from(${JSON.stringify(input.toString("hex"))}, "hex"))}));
      } catch { console.log(JSON.stringify({rejected: true})); }`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 4096 },
  );
  assert.equal(result.error, undefined, "image parser must terminate within its deadline");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

it("uses the reviewed local parser in the actual Mozilla linter dependency", () => {
  assert.equal(parserPath, require.resolve("../../scripts/vendor/image-size/index.cjs"));
  for (const name of ["icon.png", "icon-32.png", "icon-48.png", "icon-96.png"]) {
    const { size } = parseBounded(readFileSync(new URL(`../../${name}`, import.meta.url)));
    assert.equal(size.type, "png");
    assert.ok(size.width > 0 && size.height > 0);
  }
});

it("terminates HEIF and JXL zero-sized boxes using the valid EOF-size semantics", () => {
  for (const [make, expected] of [
    [heif, [64, 32]],
    [jxl, [8, 8]],
  ]) {
    for (const length of [undefined, 0]) {
      const { size } = parseBounded(make(length));
      assert.deepEqual([size.width, size.height], expected);
    }
    for (const length of [1, 7, 0xffffffff]) {
      assert.equal(parseBounded(make(length)).rejected, true);
    }
  }
});

it("rejects zero-sized and out-of-bounds ICNS entries while accepting valid entries", () => {
  const { size } = parseBounded(icns(8));
  assert.deepEqual([size.width, size.height], [128, 128]);
  for (const length of [0, 1, 7, 9, 0xffffffff]) {
    assert.equal(parseBounded(icns(length)).rejected, true);
  }
  assert.equal(parseBounded(icns(8).subarray(0, 15)).rejected, true);
});
