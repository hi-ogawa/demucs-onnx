import { Buffer } from "node:buffer";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";

function createSilentWav(durationSeconds: number) {
  const sampleRate = 8_000;
  const channelCount = 1;
  const bytesPerSample = 2;
  const dataSize = durationSeconds * sampleRate * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test("loads the FAB, uploads audio, and survives YouTube navigation", async () => {
  const extensionPath = path.resolve("dist/extension");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const page = await context.newPage();
    await page.goto("https://www.youtube.com/watch?v=7GU_VQfgMT0", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const host = page.locator("#youtube-external-audio-host");
    await expect(host).toBeAttached({ timeout: 15_000 });
    await host
      .getByRole("button", { name: "Show external audio controls" })
      .click();
    await expect(
      host.getByText("External audio", { exact: true }),
    ).toBeVisible();

    await host.locator('input[type="file"]').setInputFiles({
      name: "silent.wav",
      mimeType: "audio/wav",
      buffer: createSilentWav(240),
    });
    await expect(host.getByText("silent.wav", { exact: true })).toBeVisible();

    await page.evaluate(() => {
      document.dispatchEvent(new Event("yt-navigate-start"));
      history.pushState({}, "", "/watch?v=spa-navigation-test");
      document.dispatchEvent(new Event("yt-navigate-finish"));
    });
    await expect(host).toBeAttached();
    await expect(
      host.getByRole("button", { name: "Show external audio controls" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
