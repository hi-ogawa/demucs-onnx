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

  await expect(page.getByTestId("model-file-slot")).toHaveCount(1);
  await page
    .getByLabel("Select htdemucs.onnx")
    .setInputFiles(getInputFile("htdemucs_ft_bass.onnx"));
  await expect(
    page.getByText("Expected htdemucs.onnx, received htdemucs_ft_bass.onnx."),
  ).toBeVisible();
  await page
    .getByLabel("Select htdemucs.onnx")
    .setInputFiles(getInputFile("htdemucs.onnx"));
  await expect(
    page.getByText("Expected htdemucs.onnx, received htdemucs_ft_bass.onnx."),
  ).toBeHidden();
  await expect(
    page.getByTestId("model-file-slot").getByText("Ready"),
  ).toHaveCount(1);

  await page.locator("#model").selectOption("htdemucs_ft");
  await expect(page.getByTestId("model-file-slot")).toHaveCount(4);

  await page.locator("#model").selectOption("htdemucs");
  await expect(
    page.getByTestId("model-file-slot").getByText("Ready"),
  ).toHaveCount(1);
});
