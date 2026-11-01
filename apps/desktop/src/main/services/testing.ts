import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import type { PlatformService } from "./Platform.ts"
import { Secrets } from "./Secrets.ts"

/** A platform for unit tests: a temp data folder and a trash list. */
export const testPlatform = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "robot-unit-"))
  const trashed: string[] = []
  const platform: PlatformService = {
    appName: "ROBot",
    appVersion: "0.0.0",
    platform: "test",
    dataDir,
    defaultWorkspaceRoot: join(dataDir, "workspaces"),
    systemLocale: () => "en-US",
    pickFolder: async () => undefined,
    openPath: async () => {},
    setStartAtLogin: () => {},
    setThemeSource: () => {},
    copyText: () => {},
    openExternal: async () => {},
    trash: async (path) => {
      trashed.push(path)
    },
  }
  return { platform, dataDir, trashed }
}

/** The full app layer on an in-memory database, with recorded events. */
export const testRuntime = () => {
  const { platform, dataDir, trashed } = testPlatform()
  const events: { event: string; payload: unknown }[] = []
  const runtime = ManagedRuntime.make(
    appLayer({
      platform,
      databaseFile: ":memory:",
      localServerName: "Test computer",
      emit: (event, payload) => events.push({ event, payload }),
      secrets: Secrets.memory,
    }),
  )
  return { runtime, dataDir, trashed, events }
}

export type TestRuntime = ReturnType<typeof testRuntime>["runtime"]
export { Effect, Layer }
