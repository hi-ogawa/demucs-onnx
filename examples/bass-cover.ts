#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const models = join(repoDir, "data/onnx-lean");

function usage(): string {
  return `Usage: pnpm bass-cover <youtube-id-or-url> [options]

Download YouTube audio, optionally trim it, and separate bass.wav and no_bass.wav.

Options:
  --name <name>     Output basename
  --start <seconds> Trim start time
  --end <seconds>   Trim end time
  -h, --help        Show this help`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function quote(value: string): string {
  return /^[a-zA-Z0-9_./:=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function run(label: string, command: string, args: string[]): void {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`STEP: ${label}`);
  console.log("=".repeat(72));
  console.log(`$ ${[command, ...args].map(quote).join(" ")}`);

  const start = performance.now();
  const result = spawnSync(command, args, { cwd: repoDir, stdio: "inherit" });
  if (result.error) {
    fail(`${label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log("-".repeat(72));
  console.log(
    `DONE: ${label} (${((performance.now() - start) / 1000).toFixed(2)}s)`,
  );
  console.log("-".repeat(72));
}

function numberOption(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail(`--${name} must be a number`);
  }
  return number;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(usage());
  process.exit(0);
}
if (positionals.length !== 1) {
  fail(usage());
}

const [youtube] = positionals;
const start = numberOption("start", values.start);
const end = numberOption("end", values.end);
if (end !== undefined && end <= (start ?? 0)) {
  fail("--end must be greater than --start");
}
if (!existsSync(models)) {
  fail(`missing ${models}\nbuild it first: pnpm build:model htdemucs_ft_bass`);
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "") || "song";
const timeSlug = (value: number): string => String(value).replace(".", "p");
const name = slugify(values.name ?? youtube);
const url =
  youtube.startsWith("http://") || youtube.startsWith("https://")
    ? youtube
    : `https://www.youtube.com/watch?v=${youtube}`;
const inputDir = join(repoDir, "data/input");
mkdirSync(inputDir, { recursive: true });

const source = join(inputDir, `${name}.wav`);
run("download audio", "yt-dlp", [
  "--no-playlist",
  url,
  "-x",
  "--audio-format",
  "wav",
  "-o",
  join(inputDir, `${name}.%(ext)s`),
]);

let demucsInput = source;
if (start !== undefined || end !== undefined) {
  const trimParts = ["trim"];
  if (start !== undefined) {
    trimParts.push(`s${timeSlug(start)}`);
  }
  if (end !== undefined) {
    trimParts.push(`e${timeSlug(end)}`);
  }
  demucsInput = join(inputDir, `${name}-${trimParts.join("-")}.wav`);

  const ffmpegArgs = ["-y"];
  if (start !== undefined) {
    ffmpegArgs.push("-ss", String(start));
  }
  if (end !== undefined) {
    ffmpegArgs.push("-to", String(end));
  }
  ffmpegArgs.push("-i", source, demucsInput);
  run("trim clip", "ffmpeg", ffmpegArgs);
}

const outputDir = join(repoDir, "data/output", basename(demucsInput, ".wav"));
run("separate bass stem", "pnpm", [
  "cli-separate",
  "--name",
  "htdemucs_ft",
  "--two-stems",
  "bass",
  "--method",
  "minus",
  demucsInput,
  outputDir,
]);

console.log(`\nOutput: ${outputDir}/`);
