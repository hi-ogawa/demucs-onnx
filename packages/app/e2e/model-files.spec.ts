import { expect, test } from "@playwright/test";

function getInputFile(name: string) {
  return {
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(name),
  };
}

test("coordinates individual model file slots", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("model-file-slot")).toHaveCount(2);
  await page
    .getByLabel("Select dft.bin")
    .setInputFiles(getInputFile("htdemucs.onnx"));
  await expect(
    page.getByText("Expected dft.bin, received htdemucs.onnx."),
  ).toBeVisible();
  await page
    .getByLabel("Select dft.bin")
    .setInputFiles(getInputFile("dft.bin"));
  await expect(
    page.getByText("Expected dft.bin, received htdemucs.onnx."),
  ).toBeHidden();
  await page
    .getByLabel("Select htdemucs.onnx")
    .setInputFiles(getInputFile("htdemucs.onnx"));
  await expect(
    page.getByTestId("model-file-slot").getByText("Ready"),
  ).toHaveCount(2);

  await page.locator("#model").selectOption("htdemucs_ft");
  await expect(page.getByTestId("model-file-slot")).toHaveCount(5);
  await expect(page.getByLabel("Select dft.bin").locator("..")).toContainText(
    "Ready",
  );

  await page.locator("#model").selectOption("htdemucs");
  await expect(
    page.getByTestId("model-file-slot").getByText("Ready"),
  ).toHaveCount(2);
});
