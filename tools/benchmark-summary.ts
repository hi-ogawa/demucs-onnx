import { readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

const data = resolve(import.meta.dirname, "../data/benchmark");

interface Timing {
  loadMs: number;
  inferenceMs: number;
  finalizeMs: number;
  totalMs: number;
}

async function main() {
  const nativeRuns = await readRuns("native.json");
  const webRuns = await readRuns("web.json");
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
  const output = resolve(data, "summary.json");
  await writeFile(output, JSON.stringify(result, null, 2));
  console.table({
    native: result.native.median,
    web: result.web.median,
  });
  console.log(`Results: ${output}`);
}

async function readRuns(file: string) {
  return (
    JSON.parse(await readFile(resolve(data, file), "utf8")) as {
      runs: Timing[];
    }
  ).runs;
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
