import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "..");

export default defineConfig({
  testDir: "./e2e",
  // Vite serves instantly but the API is a ts-node-dev process and the first request after a
  // restart can be slow; the default 5s produced failures that vanished on a re-run.
  expect: { timeout: 15_000 },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm run dev:web",
      cwd: repoRoot,
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run dev:api",
      cwd: repoRoot,
      url: "http://localhost:3000/health/db",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
