import { expect, test } from "@playwright/test";

test("restores and updates configuration preferences", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "demucs-onnx:main:v1",
      JSON.stringify({
        model: "htdemucs_ft",
        outputMode: "two-stems",
        targetStem: "bass",
        method: "minus",
        shifts: 3,
      }),
    );
  });
  await page.goto("/");

  await expect(page.locator("#model")).toHaveValue("htdemucs_ft");
  await expect(page.locator("#twoStems")).toHaveValue("bass");
  await expect(page.locator("#method")).toHaveValue("minus");
  await expect(page.locator("#method")).toBeEnabled();
  await expect(page.locator("#outputSummary")).toContainText(
    "Creates bass.wav and no_bass.wav.",
  );
  await expect(page.locator("#shifts")).toHaveValue("3");
  await expect(page.locator("#modelFilesStatus")).toContainText(
    "htdemucs_ft_bass.onnx",
  );

  await page.locator("#twoStems").selectOption("");
  await expect(page.locator("#method")).toBeDisabled();
  await expect(page.locator("#outputSummary")).toContainText(
    "Creates vocals.wav, drums.wav, bass.wav, and other.wav.",
  );
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("demucs-onnx:main:v1")),
    )
    .toContain('"outputMode":"four-stems"');
});
