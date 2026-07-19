import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../../..");

test("captures one Chromium timing run", async ({ page }) => {
  await page.goto("/?benchmark=1");
  await page.setInputFiles("#modelFiles", [
    resolve(root, "data/onnx-lean/dft.bin"),
    resolve(root, "data/onnx-lean/htdemucs.onnx"),
  ]);
  await page.setInputFiles(
    "#file",
    resolve(root, "data/benchmark/input-30s.wav"),
  );
  await page.click("#run");
  await page.waitForFunction(
    () => window.__demucsBenchmarkResult !== undefined,
    {
      timeout: 15 * 60_000,
    },
  );
  const result = await page.evaluate(() => window.__demucsBenchmarkResult);
  await writeFile(
    resolve(root, "data/benchmark/small-web.json"),
    JSON.stringify(result, null, 2),
  );
});
