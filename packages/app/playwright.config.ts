import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/report.json" }],
    ...(process.env.CI ? [["github"] as const] : []),
  ],
  use: { baseURL: "http://localhost:5199" },
  webServer: {
    command: "pnpm dev --port 5199 --strictPort",
    url: "http://localhost:5199",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
      },
    },
  ],
});
