import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../../..");
const model = resolve(root, "data/onnx-lean/htdemucs.onnx");
const dft = resolve(root, "data/onnx-lean/dft.bin");
const fixture = resolve(
  root,
  process.env.BENCHMARK_FIXTURE ?? "data/benchmark/input-30s.wav",
);
const expectedDuration = process.env.BENCHMARK_DURATION ?? "30.00";
const output = process.env.BENCHMARK_OUTPUT ?? "web";
const warmupRuns = readCount("BENCHMARK_WARMUP_RUNS", 1);
const measuredRuns = readCount("BENCHMARK_MEASURED_RUNS", 3);
const runs = warmupRuns + measuredRuns;
const runTimeout = Math.max(15_000, Number(expectedDuration) * 3_000);

test.setTimeout(runs * runTimeout + 15_000);

test("benchmarks Chromium WASM inference", async ({ page }) => {
  await page.goto("/?benchmark=1");
  await page.setInputFiles("#modelFiles", [dft, model]);
  await page.setInputFiles("#file", fixture);
  await expect(page.locator("#audio-status")).toContainText(
    `Decoded: ${expectedDuration}s`,
  );

  const runButton = page.locator("#run");
  for (let index = 0; index < runs; index++) {
    await page.evaluate(() => delete window.__demucsBenchmarkResult);
    await runButton.click();
    await expect(runButton).toBeEnabled({ timeout: runTimeout });
    const result = await page.evaluate(() => window.__demucsBenchmarkResult!);
    await writeFile(
      resolve(root, `data/benchmark/${output}-run-${index}.json`),
      JSON.stringify(result, null, 2),
    );
  }
});

function readCount(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
