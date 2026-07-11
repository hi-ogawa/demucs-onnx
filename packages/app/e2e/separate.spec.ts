// Flow e2e: upload -> decode -> separate -> stems rendered with players + downloads.
// Exercises the whole client pipeline (decodeAudioData, wasm core, onnxruntime-web);
// numeric parity vs the native CLI is covered by the CLI-side comparisons, not here.
//
// Requires models in data/onnx-lean (see README.md for the regeneration chain).
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MODELS_DIR = resolve(import.meta.dirname, "../../../data/onnx-lean");
const MODEL = resolve(MODELS_DIR, "htdemucs.onnx");
const DFT = resolve(MODELS_DIR, "dft.bin");
const FIXTURE = resolve(import.meta.dirname, "../../../fixtures/sine-10s.wav");

test("separates a clip fully client-side", async ({ page }) => {
  expect(existsSync(MODEL), `model missing at ${MODEL}`).toBe(true);
  expect(existsSync(DFT), `external data missing at ${DFT}`).toBe(true);
  expect(existsSync(FIXTURE), `fixture missing at ${FIXTURE}`).toBe(true);

  await page.goto("/");
  await page.setInputFiles("#file", FIXTURE);
  await expect(page.locator("#status")).toContainText("decoded: 10.00s", { timeout: 15_000 });

  await page.click("#run");
  await expect(page.locator("#status")).toContainText("done in", { timeout: 240_000 });

  const stems = page.locator("#stems > div");
  await expect(stems).toHaveCount(4);
  for (const name of ["drums", "bass", "other", "vocals"]) {
    await expect(page.locator("#stems")).toContainText(name);
  }
  await expect(page.locator("#stems audio")).toHaveCount(4);
  await expect(page.locator("#stems a")).toHaveCount(4);
});
