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
  const shell = {
    focused: true,
    notices: [] as { title: string; body: string; click: () => void }[],
    shapes: [] as string[],
    fits: [] as { width: number; height: number }[],
    shown: 0,
  }
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
    pickAgentFileSave: async () => undefined,
    pickAgentFile: async () => undefined,
    pickWorkflowFileSave: async () => undefined,
    pickWorkflowFile: async () => undefined,
    openPath: async () => {},
    setStartAtLogin: () => {},
    setThemeSource: () => {},
    copyText: () => {},
    openExternal: async () => {},
    trash: async (path) => {
      trashed.push(path)
    },
    isFocused: () => shell.focused,
    notify: (notice, click) => {
      shell.notices.push({ ...notice, click })
    },
    showWindow: () => {
      shell.shown++
    },
    setIslandShape: (shape) => {
      shell.shapes.push(shape)
    },
    fitIsland: (size) => {
      shell.fits.push(size)
    },
    browser: (agentId) => {
      const known = pages.get(agentId)
      if (known) return known
      const page = fakeBrowser(agentId)
      pages.set(agentId, page)
      return page
    },
  }
  return { platform, dataDir, trashed, browserLog, shell }
}

/** The full app layer on an in-memory database, with recorded events. */
export const testRuntime = () => {
  const { platform, dataDir, trashed, browserLog, shell } = testPlatform()
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
  return { runtime, dataDir, trashed, events, browserLog, shell }
}

export type TestRuntime = ReturnType<typeof testRuntime>["runtime"]
export { Effect, Layer }
