import { defineConfig } from "@playwright/test"

const ci = Boolean(process.env.CI)

// Each test starts its own copy of the app with its own data folder, and tests that run two copies
// take free ports from the system (e2e/ports.ts), so every test runs in parallel.
// ROBOT_E2E_WORKERS sets the number of workers; the default is half of the CPU cores.
//
// The whole run makes its temporary folders inside one folder, which the teardown removes
// (e2e/global-setup.ts).
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  outputDir: "../../build/e2e/artifacts",
  timeout: 60_000,
  fullyParallel: true,
  workers: Number(process.env.ROBOT_E2E_WORKERS) || "50%",
  forbidOnly: ci,
  // One retry on CI. The report marks a test that passes on the retry as flaky.
  retries: ci ? 1 : 0,
  reporter: [
    [ci ? "line" : "list"],
    ["html", { outputFolder: "../../build/e2e/report", open: "never" }],
  ],
})
