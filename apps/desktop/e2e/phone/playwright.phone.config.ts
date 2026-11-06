import { defineConfig } from "@playwright/test"

// Only for the end-to-end run of the phone app (apps/mobile/e2e/run-ios.ts). Not used by CI.
export default defineConfig({
  testDir: ".",
  // PHONE_E2E_HOST names the host file. The default has one agent.
  testMatch: process.env.PHONE_E2E_HOST ?? "phone-host.ts",
  outputDir: "../../../../build/e2e/phone/artifacts",
  workers: 1,
  reporter: [["list"]],
})
