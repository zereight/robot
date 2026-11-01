import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  outputDir: "../../build/e2e/artifacts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "../../build/e2e/report", open: "never" }]],
})
