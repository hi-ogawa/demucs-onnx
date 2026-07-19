import { readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";

const data = resolve(import.meta.dirname, "../data/benchmark");

interface Timing {
  loadMs: number;
  inferenceMs: number;
  finalizeMs: number;
  totalMs: number;
  chunks: ChunkTiming[];
}

interface ChunkTiming {
  prepareInputMs: number;
  ortRunMs: number;
  outputCopyMs: number;
  processOutputMs: number;
}

async function main() {
  const native = Object.fromEntries(
    await Promise.all(
      ["default", "1", "2", "4", "8", "16"].map(async (threads) => [
        threads,
        summarize(await readNativeRuns(threads)),
      ]),
    ),
  );
  const webRuns = await readRuns("web.json");
  const result = {
    fixture: { durationSeconds: 30, sampleRate: 44_100, channels: 2 },
    settings: { model: "htdemucs", mode: "full", shifts: 1 },
    environment: {
      platform: process.platform,
      arch: process.arch,
      logicalCpus: availableParallelism(),
    },
    native,
    web: summarize(webRuns),
  };
  const output = resolve(data, "summary.json");
  await writeFile(output, JSON.stringify(result, null, 2));
  console.table(
    Object.fromEntries([
      ...Object.entries(result.native).map(([threads, summary]) => [
        `native-${threads}`,
        summary.median,
      ]),
      ["web", result.web.median],
    ]),
  );
  console.log(`Results: ${output}`);
}

async function readNativeRuns(threads: string) {
  return await Promise.all(
    [1, 2, 3].map(async (index) => {
      const result = JSON.parse(
        await readFile(
          resolve(data, `native-threads-${threads}-run-${index}.json`),
          "utf8",
        ),
      ) as Timing & { prepareMs: number };
      return {
        ...result,
        endToEndMs: result.totalMs,
        totalMs:
          result.prepareMs +
          result.loadMs +
          result.inferenceMs +
          result.finalizeMs,
      };
    }),
  );
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
      prepareInputMs: median(runs.map((run) => sum(run, "prepareInputMs"))),
      ortRunMs: median(runs.map((run) => sum(run, "ortRunMs"))),
      outputCopyMs: median(runs.map((run) => sum(run, "outputCopyMs"))),
      processOutputMs: median(runs.map((run) => sum(run, "processOutputMs"))),
    },
  };
}

function sum(run: Timing, field: keyof ChunkTiming) {
  return run.chunks.reduce((total, chunk) => total + chunk[field], 0);
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
