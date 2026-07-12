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
  await expect(page.locator("#model-storage-status")).toHaveText(
    "Model files stored in browser.",
  );

  await page.reload();
  await expect(
    page.getByTestId("model-file-slot").getByText("Ready"),
  ).toHaveCount(2);
});
