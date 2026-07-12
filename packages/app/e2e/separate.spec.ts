import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

const MODELS_DIR = resolve(import.meta.dirname, "../../../data/onnx-split");
const MODEL = resolve(MODELS_DIR, "htdemucs.onnx");
const FIXTURE = resolve(import.meta.dirname, "../../../fixtures/sine-2s.wav");
const NATIVE_OUTPUT = resolve(
  import.meta.dirname,
  "../../../data/output-split",
);

function readFloatWav(buffer: Buffer) {
  const dataOffset = buffer.indexOf("data") + 8;
  expect(dataOffset).toBeGreaterThan(7);
  const samples = new Float32Array((buffer.length - dataOffset) / 4);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = buffer.readFloatLE(dataOffset + index * 4);
  }
  return samples;
}

test("separates a clip fully client-side", async ({ page }) => {
  expect(existsSync(MODEL), `model missing at ${MODEL}`).toBe(true);
  expect(existsSync(FIXTURE), `fixture missing at ${FIXTURE}`).toBe(true);
  for (const name of ["drums", "bass", "other", "vocals"]) {
    expect(
      existsSync(resolve(NATIVE_OUTPUT, `${name}.wav`)),
      `native reference missing for ${name}`,
    ).toBe(true);
  }

  await page.goto("/");
  await page.setInputFiles("#modelFiles", MODEL);
  await expect(
    page.getByTestId("model-file-slot").getByText("Ready"),
  ).toHaveCount(1);
  await page.setInputFiles("#file", FIXTURE);
  await expect(page.locator("#audio-status")).toContainText("Decoded: 2.00s");

  await page.click("#run");
  await expect(
    page.getByRole("progressbar", { name: "Overall separation progress" }),
  ).toBeVisible();
  await expect(page.getByTestId("model-progress")).toContainText(
    "htdemucs.onnx",
  );
  await expect(page.locator("#status")).toContainText("Done in", {
    timeout: 300_000,
  });
  await expect(page.getByTestId("timing-summary")).toContainText("Inference");

  const stems = page.locator("#stems > div");
  await expect(stems).toHaveCount(4);
  for (const name of ["drums", "bass", "other", "vocals"]) {
    await expect(page.locator("#stems")).toContainText(name);
    const row = page.locator("#stems > div").filter({ hasText: name });
    const downloadPromise = page.waitForEvent("download");
    await row.getByRole("link", { name: "Download WAV" }).click();
    const download = await downloadPromise;
    const browser = readFloatWav(readFileSync((await download.path())!));
    const native = readFloatWav(
      readFileSync(resolve(NATIVE_OUTPUT, `${name}.wav`)),
    );
    expect(browser.length).toBe(native.length);
    let maxAbs = 0;
    let squaredError = 0;
    for (let index = 0; index < browser.length; index++) {
      const error = Math.abs(browser[index] - native[index]);
      maxAbs = Math.max(maxAbs, error);
      squaredError += error * error;
    }
    expect(maxAbs, `${name} max absolute error`).toBeLessThan(2e-3);
    expect(squaredError / browser.length, `${name} MSE`).toBeLessThan(1e-7);
  }
  await expect(page.locator("#stems audio")).toHaveCount(4);
  await expect(page.locator("#stems a")).toHaveCount(4);
});
