import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { MemoryNetwork } from "../link/nearby.testing.ts"
import { bindLinkDispatcher } from "../rpc.ts"
import type { BrowserPage, PlatformService } from "./Platform.ts"
import { Secrets } from "./Secrets.ts"

/** A platform for unit tests: a temp data folder and a trash list. */
export const testPlatform = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "robot-unit-"))
  const trashed: string[] = []
  /** What the fake browsers did, in order, as "agent:action". */
  const browserLog: string[] = []
  /** Where the fake browsers were told to show, as "agent:x,y WxH" or "agent:hidden". */
  const browserPlaced: string[] = []
  /** Whether the input of the user was let in or kept out, as "agent:on" or "agent:off". */
  const browserInput: string[] = []
  const pages = new Map<string, BrowserPage>()
  const shell = {
    focused: true,
    notices: [] as { title: string; body: string; click: () => void }[],
    shapes: [] as string[],
    fits: [] as { width: number; height: number }[],
    shown: 0,
    /** What "Save as" answers. Undefined means the user cancelled. */
    savePath: undefined as string | undefined,
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
      place: (bounds) => {
        browserPlaced.push(
          `${agentId}:${bounds ? `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : "hidden"}`,
        )
      },
      allowUserInput: (allowed) => {
        browserInput.push(`${agentId}:${allowed ? "on" : "off"}`)
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
    pickSavePath: async () => shell.savePath,
    pickArchive: async () => undefined,
    pickAgentFileSave: async () => undefined,
    pickAgentFile: async () => undefined,
    pickWorkflowFileSave: async () => undefined,
    pickWorkflowFile: async () => undefined,
    openPath: async () => {},
    openFile: async () => {},
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
  return { platform, dataDir, trashed, browserLog, browserPlaced, browserInput, shell }
}

/** The full app layer on an in-memory database, with recorded events. */
export const testRuntime = (options: { name?: string; network?: MemoryNetwork } = {}) => {
  const { platform, dataDir, trashed, browserLog, browserPlaced, browserInput, shell } =
    testPlatform()
  const events: { event: string; payload: unknown }[] = []
  const runtime = ManagedRuntime.make(
    appLayer({
      platform,
      databaseFile: ":memory:",
      linkPort: 0,
      nearbySocket: (options.network ?? new MemoryNetwork()).open,
      localServerName: options.name ?? "Test computer",
      emit: (event, payload) => events.push({ event, payload }),
      secrets: Secrets.memory,
    }),
  )
  // The requests of linked devices run the real handlers, as in the app.
  void bindLinkDispatcher(runtime)
  return { runtime, dataDir, trashed, events, browserLog, browserPlaced, browserInput, shell }
}

export type TestRuntime = ReturnType<typeof testRuntime>["runtime"]
export { Effect, Layer }
