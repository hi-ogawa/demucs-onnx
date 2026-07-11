// Flow e2e: upload -> decode -> separate -> stems rendered with players + downloads.
// Exercises the whole client pipeline (decodeAudioData, wasm core, onnxruntime-web);
// numeric parity vs the native CLI is covered by the CLI-side comparisons, not here.
//
// Requires models in ../data/onnx-lean (see plan.md for the regeneration chain).
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MODELS = resolve(import.meta.dirname, "../../data/onnx-lean/htdemucs.onnx");

/** 2s stereo f32 wav: L = 220Hz sine, R = 110Hz sine. */
function fixtureWav(): Buffer {
  const sr = 44100;
  const frames = 2 * sr;
  const nch = 2;
  const buf = Buffer.alloc(44 + frames * nch * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * nch * 4, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * nch * 4, 28);
  buf.writeUInt16LE(nch * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * nch * 4, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeFloatLE(0.4 * Math.sin((2 * Math.PI * 220 * i) / sr), 44 + i * 8);
    buf.writeFloatLE(0.4 * Math.sin((2 * Math.PI * 110 * i) / sr), 48 + i * 8);
  }
  return buf;
}

test("separates a clip fully client-side", async ({ page }) => {
  test.skip(!existsSync(MODELS), `models missing at ${MODELS}`);

  await page.goto("/");
  await page.setInputFiles("#file", {
    name: "fixture.wav",
    mimeType: "audio/wav",
    buffer: fixtureWav(),
  });
  await expect(page.locator("#status")).toContainText("decoded: 2.00s", { timeout: 15_000 });

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
