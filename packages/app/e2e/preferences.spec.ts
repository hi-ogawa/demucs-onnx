import { expect, test } from "@playwright/test";

test("restores and updates configuration preferences", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "demucs-onnx:main:v2",
      JSON.stringify({
        model: "htdemucs_ft",
        twoStems: "bass",
        method: "minus",
        shifts: 3,
      }),
    );
  });
  await page.goto("/");

  await expect(page.locator("#model")).toHaveValue("htdemucs_ft");
  await expect(
    page.getByRole("radio", { name: /Bass \+ backing/ }),
  ).toBeChecked();
  await expect(page.locator("#method")).toHaveValue("minus");
  await expect(page.locator("#method")).toBeEnabled();
  await expect(page.locator("#outputSummary")).toContainText(
    "Creates bass.wav and backing.wav.",
  );
  await expect(page.locator("#shifts")).toHaveValue("3");
  await expect(page.getByLabel("Select htdemucs_ft_bass.onnx")).toBeAttached();

  await page.getByRole("radio", { name: /Four stems/ }).check();
  await expect(page.locator("#method")).toBeDisabled();
  await expect(page.locator("#outputSummary")).toContainText(
    "Creates vocals.wav, drums.wav, bass.wav, and other.wav.",
  );
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("demucs-onnx:main:v2")),
    )
    .toContain('"twoStems":null');
});

test("uses the default output configuration", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("radio", { name: /Four stems/ })).toBeChecked();
  await expect(page.locator("#method")).toHaveValue("minus");
  await expect(page.locator("#method")).toBeDisabled();
});
