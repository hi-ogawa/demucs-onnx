import { expect, test } from "@playwright/test";

test("restores selected model files after reload", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#modelFiles", [
    {
      name: "dft.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("dft"),
    },
    {
      name: "htdemucs.onnx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("model"),
    },
  ]);
  await expect(page.locator("#modelFilesStatus")).toHaveText(
    "Required model files selected and stored.",
  );

  await page.reload();
  await expect(page.locator("#modelFilesStatus")).toHaveText(
    "Required model files restored from browser storage.",
  );
});
