import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const data = resolve(root, "data/benchmark");
const fixture = resolve(data, "input-30s.wav");
const models = resolve(root, "data/onnx-lean");
const binary = resolve(root, "target/release/demucs");
const measuredRuns = 3;

interface Timing {
  loadMs: number;
  inferenceMs: number;
  finalizeMs: number;
  totalMs: number;
  prepareMs?: number;
  writeMs?: number;
}

interface NativeTiming extends Timing {
  prepareMs: number;
  writeMs: number;
  endToEndMs: number;
}

async function main() {
  await mkdir(data, { recursive: true });
  await exec("pnpm", ["tsx", "tools/generate-benchmark-fixture.ts", fixture], {
    cwd: root,
  });
  await exec("cargo", ["build", "--release", "-p", "demucs-cli"], {
    cwd: root,
  });

  const nativeRuns: NativeTiming[] = [];
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
      { cwd: root, maxBuffer: 10 * 1024 * 1024 },
    );
    const result = JSON.parse(await readFile(timings, "utf8")) as Omit<
      NativeTiming,
      "endToEndMs"
    >;
    if (index > 0) {
      nativeRuns.push({
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
    JSON.stringify({ backend: "native", runs: nativeRuns }, null, 2),
  );

  await exec(
    "pnpm",
    ["-C", "packages/app", "benchmark"],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  const webRuns = (
    JSON.parse(await readFile(resolve(data, "web.json"), "utf8")) as {
      runs: Timing[];
    }
  ).runs;

  const result = {
    fixture: { durationSeconds: 30, sampleRate: 44_100, channels: 2 },
    settings: { model: "htdemucs", mode: "full", shifts: 1 },
    environment: {
      platform: process.platform,
      arch: process.arch,
      logicalCpus: availableParallelism(),
      nativeIntraThreads: 4,
    },
    native: summarize(nativeRuns),
    web: summarize(webRuns),
  };
  await writeFile(resolve(data, "summary.json"), JSON.stringify(result, null, 2));
  console.table({
    native: result.native.median,
    web: result.web.median,
  });
  console.log(`Results: ${resolve(data, "summary.json")}`);
}

function summarize(runs: Timing[]) {
  return {
    runs,
    median: {
      loadMs: median(runs.map((run) => run.loadMs)),
      inferenceMs: median(runs.map((run) => run.inferenceMs)),
      finalizeMs: median(runs.map((run) => run.finalizeMs)),
      totalMs: median(runs.map((run) => run.totalMs)),
    },
  };
}

function median(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
