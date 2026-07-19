import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  reporter: "list",
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
