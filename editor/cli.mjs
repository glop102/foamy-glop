#!/usr/bin/env node
// Export a scenario to an OpenFOAM case directory, the same files the
// editor's "Export case" button packs into a .tar.gz.
//
//   node editor/cli.mjs scenario.json out/dir
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportCase } from "./src/export.js";

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error("usage: foamy-export scenario.json out/dir");
  process.exit(2);
}
if (existsSync(outDir) && readdirSync(outDir).some((f) => !f.startsWith("."))) {
  if (!existsSync(join(outDir, "scenario.json"))) {
    console.error(`${outDir} is not empty and is not an exported case; refusing to write into it.`);
    process.exit(1);
  }
}

let result;
try {
  result = exportCase(JSON.parse(readFileSync(input, "utf8")));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
for (const p of result.problems) console.error(`${p.level}: ${p.msg}`);
for (const [path, f] of Object.entries(result.files)) {
  const full = join(outDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, f.content);
  chmodSync(full, f.mode);
}
console.log(`wrote ${Object.keys(result.files).length} files to ${outDir}`);
