import { defineConfig, devices } from "@playwright/test";

process.env.SYNAPSE_API_TOKEN =
  process.env.SYNAPSE_API_TOKEN || "synapse-e2e-master-token-value-2026";

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Deterministic single-worker execution to prevent cross-spec state pollution
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: "http://localhost:3010",
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command:
        process.env.CONTROL_API_CMD ||
        "pnpm exec tsx e2e/fixtures/start-control-server.ts",
      url: "http://localhost:3000/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: "3000",
        AUTO_MIGRATE: "true",
        ENABLE_AUDIT_SEALER: "true",
        SYNAPSE_MOCK_GITHUB: "true",
        ENABLE_TEST_RESET: "true",
        SYNAPSE_API_TOKEN: process.env.SYNAPSE_API_TOKEN,
      },
    },
    {
      command: "pnpm exec next start -p 3010",
      url: "http://localhost:3010/login",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        SYNAPSE_DEV_AUTH: "true",
        SYNAPSE_MOCK_PROMOTE: "true",
        PORT: "3010",
        SESSION_SECRET:
          process.env.SESSION_SECRET ||
          "development-only-session-secret-min-32-chars-long",
        CONTROL_API_URL: "http://localhost:3000",
        SYNAPSE_API_TOKEN: process.env.SYNAPSE_API_TOKEN,
      },
    },
  ],
});
