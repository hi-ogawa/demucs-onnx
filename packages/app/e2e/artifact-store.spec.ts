import { expect, test } from "@playwright/test";

test("restores selected model files after reload", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#modelFiles", {
    name: "htdemucs.onnx",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("model"),
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open("demucs-artifacts-v2", 1);
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const countRequest = database
          .transaction("artifacts", "readonly")
          .objectStore("artifacts")
          .count();
        return new Promise<number>((resolve, reject) => {
          countRequest.onsuccess = () => resolve(countRequest.result);
          countRequest.onerror = () => reject(countRequest.error);
        });
      }),
    )
    .toBe(1);

  await page.reload();
  await expect(
    page.getByTestId("model-file-slot").getByText("Ready"),
  ).toHaveCount(1);
});
