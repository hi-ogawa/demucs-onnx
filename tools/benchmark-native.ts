import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const data = resolve(root, "data/benchmark");
const fixture = resolve(data, "input-30s.wav");
const models = resolve(root, "data/onnx-lean");
const binary = resolve(root, "target/release/demucs");
const measuredRuns = 3;

interface NativeTiming {
  prepareMs: number;
  loadMs: number;
  inferenceMs: number;
  finalizeMs: number;
  writeMs: number;
  totalMs: number;
  endToEndMs: number;
}

async function main() {
  await mkdir(data, { recursive: true });
  const runs: NativeTiming[] = [];
  for (let index = 0; index <= measuredRuns; index++) {
    const runDir = resolve(data, `native-run-${index}`);
    const timings = resolve(data, `native-run-${index}.json`);
    await rm(runDir, { recursive: true, force: true });
    await exec(
      binary,
      [
        "separate",
        "--models",
        models,
        "--timings-json",
        timings,
        fixture,
        runDir,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const result = JSON.parse(await readFile(timings, "utf8")) as Omit<
      NativeTiming,
      "endToEndMs"
    >;
    if (index > 0) {
      runs.push({
        ...result,
        endToEndMs: result.totalMs,
        totalMs:
          result.prepareMs +
          result.loadMs +
          result.inferenceMs +
          result.finalizeMs,
      });
    }
  }
  await writeFile(
    resolve(data, "native.json"),
    JSON.stringify({ backend: "native", runs }, null, 2),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
