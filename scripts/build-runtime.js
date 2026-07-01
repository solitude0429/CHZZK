import { readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";
import { format, resolveConfig } from "prettier";

const common = {
  bundle: true,
  format: "iife",
  logLevel: "info",
  minify: false,
  platform: "browser",
  sourcemap: false,
  target: ["firefox140"],
};

async function formatOutput(path) {
  const raw = await readFile(path, "utf8");
  const options = (await resolveConfig(path)) ?? {};
  await writeFile(path, await format(raw, { ...options, parser: "babel" }));
}

await build({
  ...common,
  entryPoints: ["src/runtime/background.js"],
  outfile: "background.js",
});
await formatOutput("background.js");

await build({
  ...common,
  entryPoints: ["src/runtime/diagnostics-page.js"],
  outfile: "diagnostics.js",
});
await formatOutput("diagnostics.js");
