#!/usr/bin/env node
// Node CLI over the demucs-napi binding — mirrors demucs-rs-proto's separate flags.
// Usage: node cli.mjs separate --models <dir> [--name htdemucs|htdemucs_ft]
//        [--two-stems <src>] [--method add|minus] [--shifts N] <input.wav> <out_dir>
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const binding = require("./demucs.node");

const argv = process.argv.slice(2);
if (argv[0] !== "separate") {
  console.error("usage: cli.mjs separate --models <dir> [...] <input.wav> <out_dir>");
  process.exit(1);
}

const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) flags[a.slice(2)] = argv[++i];
  else positional.push(a);
}
const [input, outDir] = positional;
if (!flags.models || !input || !outDir) {
  console.error("missing --models, input, or out_dir");
  process.exit(1);
}

const written = binding.separate(flags.models, flags.name ?? "htdemucs", input, outDir, {
  twoStems: flags["two-stems"],
  method: flags.method,
  shifts: flags.shifts !== undefined ? Number(flags.shifts) : undefined,
});
for (const p of written) console.log(`wrote ${p}`);
