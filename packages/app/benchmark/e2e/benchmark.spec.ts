import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { BenchmarkResult } from "../../src/app";

const root = resolve(import.meta.dirname, "../../../..");
const model = resolve(root, "data/onnx-lean/htdemucs.onnx");
const dft = resolve(root, "data/onnx-lean/dft.bin");
const fixture = resolve(root, "data/benchmark/input-30s.wav");
const output = resolve(root, "data/benchmark/web.json");
const measuredRuns = 3;

test("benchmarks Chromium WASM inference", async ({ page }) => {
  for (const path of [model, dft, fixture]) {
    expect(existsSync(path), `missing benchmark input at ${path}`).toBe(true);
  }

  await page.goto("/?benchmark=1");
  await page.setInputFiles("#modelFiles", [dft, model]);
  await page.setInputFiles("#file", fixture);
  await expect(page.locator("#audio-status")).toContainText("Decoded: 30.00s");

  const runs: BenchmarkResult[] = [];
  for (let index = 0; index <= measuredRuns; index++) {
    await page.evaluate(() => delete window.__demucsBenchmarkResult);
    await page.click("#run");
    await page.waitForFunction(() => window.__demucsBenchmarkResult !== undefined, {
      timeout: 15 * 60_000,
    });
    const result = await page.evaluate(() => window.__demucsBenchmarkResult!);
    if (index > 0) {
      runs.push(result);
    }
  }

  await writeFile(output, JSON.stringify({ backend: "web", runs }, null, 2));
});
