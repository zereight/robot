import { defineConfig } from "@playwright/test"

// Only for the end-to-end run of the phone app (apps/mobile/e2e/run-ios.ts). Not used by CI.
export default defineConfig({
  testDir: ".",
  // The temporary folders of the run stand in one folder that the run removes (e2e/global-setup.ts).
  globalSetup: "../global-setup.ts",
  globalTeardown: "../global-teardown.ts",
  // PHONE_E2E_HOST names the host file: the default has one agent, "phone-channel-host.ts" has a channel.
  testMatch: process.env.PHONE_E2E_HOST ?? "phone-host.ts",
  outputDir: "../../../../build/e2e/phone/artifacts",
  workers: 1,
  reporter: [["list"]],
})
