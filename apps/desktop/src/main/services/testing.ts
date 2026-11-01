import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import type { BrowserPage, PlatformService } from "./Platform.ts"
import { Secrets } from "./Secrets.ts"

/** A platform for unit tests: a temp data folder and a trash list. */
export const testPlatform = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "robot-unit-"))
  const trashed: string[] = []
  /** What the fake browsers did, in order, as "agent:action". */
  const browserLog: string[] = []
  const pages = new Map<string, BrowserPage>()
  const fakeBrowser = (agentId: string): BrowserPage => {
    let open = false
    let url = ""
    const listeners: (() => void)[] = []
    return {
      isOpen: () => open,
      open: async (next) => {
        open = true
        url = next
        browserLog.push(`${agentId}:open ${next}`)
        return { url, title: "Fake page" }
      },
      read: async () => ({ url, title: "Fake page", text: `Text of ${url}` }),
      click: async (selector) => {
        browserLog.push(`${agentId}:click ${selector}`)
      },
      type: async (selector, text) => {
        browserLog.push(`${agentId}:type ${selector} ${text}`)
      },
      close: () => {
        if (!open) return
        open = false
        browserLog.push(`${agentId}:close`)
        for (const l of listeners) l()
      },
      onClosed: (l) => {
        listeners.push(l)
      },
    }
  }
  const platform: PlatformService = {
    appName: "ROBot",
    appVersion: "0.0.0",
    platform: "test",
    dataDir,
    defaultWorkspaceRoot: join(dataDir, "workspaces"),
    systemLocale: () => "en-US",
    pickFolder: async () => undefined,
    pickFiles: async () => [],
    pickSavePath: async () => undefined,
    pickArchive: async () => undefined,
    openPath: async () => {},
    setStartAtLogin: () => {},
    setThemeSource: () => {},
    copyText: () => {},
    openExternal: async () => {},
    trash: async (path) => {
      trashed.push(path)
    },
    browser: (agentId) => {
      let page = pages.get(agentId)
      if (!page) pages.set(agentId, (page = fakeBrowser(agentId)))
      return page
    },
  }
  return { platform, dataDir, trashed, browserLog }
}

/** The full app layer on an in-memory database, with recorded events. */
export const testRuntime = () => {
  const { platform, dataDir, trashed, browserLog } = testPlatform()
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
  return { runtime, dataDir, trashed, events, browserLog }
}

export type TestRuntime = ReturnType<typeof testRuntime>["runtime"]
export { Effect, Layer }
