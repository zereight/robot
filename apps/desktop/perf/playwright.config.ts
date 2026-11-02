import { defineConfig } from "@playwright/test"

// The performance run of docs/performance.md. Start it with "bun run perf -- run --label <label>".
export default defineConfig({
  testDir: ".",
  testMatch: "perf.spec.ts",
  outputDir: "../../../build/perf/artifacts",
  timeout: 20 * 60_000,
  workers: 1,
  reporter: [["list"]],
})
