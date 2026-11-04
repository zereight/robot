import { defineConfig } from "@playwright/test"

// The performance run of docs/performance.md. Start it with "bun run perf -- run --label <label>".
export default defineConfig({
  testDir: ".",
  testMatch: "perf.spec.ts",
  // The temporary folders of the run stand in one folder that the run removes (e2e/global-setup.ts).
  globalSetup: "../e2e/global-setup.ts",
  globalTeardown: "../e2e/global-teardown.ts",
  outputDir: "../../../build/perf/artifacts",
  timeout: 20 * 60_000,
  workers: 1,
  reporter: [["list"]],
})
