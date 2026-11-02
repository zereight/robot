import { defineConfig } from "@playwright/test"

// Only for the end-to-end run of the phone app (apps/mobile/e2e/run-ios.ts). Not used by CI.
export default defineConfig({
  testDir: ".",
  testMatch: "phone-host.ts",
  outputDir: "../../../../build/e2e/phone/artifacts",
  workers: 1,
  reporter: [["list"]],
})
