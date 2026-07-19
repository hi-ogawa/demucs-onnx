import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 60 * 60_000,
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
