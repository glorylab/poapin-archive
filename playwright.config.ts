import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "line",
  outputDir: "test-results/playwright",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      XDG_CACHE_HOME: resolve(".wrangler/playwright/cache"),
      XDG_CONFIG_HOME: resolve(".wrangler/playwright/config"),
      WRANGLER_LOG_PATH: resolve(".wrangler/playwright/logs"),
      WRANGLER_REGISTRY_PATH: resolve(".wrangler/playwright/registry"),
    },
  },
});
