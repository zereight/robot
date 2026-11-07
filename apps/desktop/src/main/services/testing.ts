import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { MemoryNetwork } from "../link/nearby.testing.ts"
import { bindLinkDispatcher } from "../rpc.ts"
import { PAGE_CONTROLS_MAX } from "../web/pageControls.ts"
import type { ConnectionsOptions } from "./Connections.ts"
import type { BrowserAct, BrowserPage, PlatformService } from "./Platform.ts"
import { Rules } from "./Rules.ts"
import { Secrets } from "./Secrets.ts"
import type { WorkflowCheckOptions } from "./WorkflowCheck.ts"

/** One control of a fake page: the selector it answers, and its line in the read list. */
export interface FakeBrowserControl {
  selector: string
  role: string
  label: string
  x: number
  y: number
}

/** What a test puts on a fake page before the agent acts: its controls, focus, errors, load. */
export interface FakeBrowserSeed {
  controls?: FakeBrowserControl[]
  focus?: string | null
  errors?: string[]
  loading?: boolean
}

/** A platform for unit tests: a temp data folder and a trash list. */
export const testPlatform = () => {
  const dataDir = mkdtempSync(join(tmpdir(), "robot-unit-"))
  // A home folder of its own, so a test never reads or writes a real place of the user (spec 007).
  const homeDir = mkdtempSync(join(tmpdir(), "robot-unit-home-"))
  /** The addresses that each host name leads to, for a web page fetch. A name not here fails. */
  const hosts = new Map<string, string[]>()
  const trashed: string[] = []
  /** What the fake browsers did, in order, as "workflow:action". */
  const browserLog: string[] = []
  /** Where the fake browsers were told to show, as "workflow:x,y WxH" or "workflow:hidden". */
  const browserPlaced: string[] = []
  /** Whether the input of the user was let in or kept out, as "workflow:on" or "workflow:off". */
  const browserInput: string[] = []
  const pages = new Map<string, BrowserPage>()
  /** The browser profile that each agent uses now, as the fake platform was told. */
  const browserProfiles = new Map<string, string>()
  /** The browser profiles whose saved data was deleted, in order. */
  const clearedProfiles: string[] = []
  const shell = {
    focused: true,
    notices: [] as { title: string; body: string; click: () => void }[],
    shown: 0,
    /** What "Save as" answers. Undefined means the user cancelled. */
    savePath: undefined as string | undefined,
    /** Whether the computer is held awake now, and the changes of that, as "on" and "off". */
    awake: false,
    awakeLog: [] as string[],
    /** Whether the computer runs on its battery. A test sets it and calls `powerChanged`. */
    battery: false,
    powerListeners: [] as (() => void)[],
    /** The computer changes between its battery and power. */
    powerChanged: () => {
      for (const l of shell.powerListeners) l()
    },
  }
  const browserSeeds = new Map<
    string,
    { controls: FakeBrowserControl[]; focus: string | null; errors: string[]; loading: boolean }
  >()
  const seedBrowserPage = (workflowId: string, seed: FakeBrowserSeed) => {
    browserSeeds.set(workflowId, {
      controls: seed.controls ?? [],
      focus: seed.focus ?? null,
      errors: [...(seed.errors ?? [])],
      loading: seed.loading ?? false,
    })
  }
  const fakeBrowser = (workflowId: string): BrowserPage => {
    let open = false
    let url = ""
    const listeners: (() => void)[] = []
    const state = () => {
      const known = browserSeeds.get(workflowId)
      if (known) return known
      const fresh = {
        controls: [] as FakeBrowserControl[],
        focus: null as string | null,
        errors: [] as string[],
        loading: false,
      }
      browserSeeds.set(workflowId, fresh)
      return fresh
    }
    /** A click or a type: a number picks from the list, a selector must fit exactly one. */
    const act = (target: string): BrowserAct => {
      const s = state()
      if (/^\d+$/.test(target)) {
        const at = Number(target) - 1
        if (at < 0 || at >= s.controls.length) return { ok: false, reason: "none" }
      } else {
        const fits = s.controls.filter((c) => c.selector === target)
        if (fits.length === 0) return { ok: false, reason: "none" }
        if (fits.length > 1)
          return {
            ok: false,
            reason: "many",
            candidates: fits.slice(0, 5).map((c) => ({
              index: s.controls.indexOf(c) + 1,
              role: c.role,
              label: c.label,
              x: c.x,
              y: c.y,
            })),
            total: fits.length,
          }
      }
      const errors = s.errors
      s.errors = []
      return {
        ok: true,
        state: { url, title: "Fake page", loading: s.loading, focus: s.focus, errors },
      }
    }
    return {
      isOpen: () => open,
      open: async (next) => {
        open = true
        url = next
        browserLog.push(`${workflowId}:open ${next}`)
        return { url, title: "Fake page" }
      },
      read: async () => {
        const s = state()
        return {
          url,
          title: "Fake page",
          text: `Text of ${url}`,
          controls: s.controls
            .slice(0, PAGE_CONTROLS_MAX)
            .map((c, i) => ({ index: i + 1, role: c.role, label: c.label })),
          total: s.controls.length,
        }
      },
      click: async (target) => {
        browserLog.push(`${workflowId}:click ${target}`)
        return act(target)
      },
      type: async (target, text) => {
        browserLog.push(`${workflowId}:type ${target} ${text}`)
        return act(target)
      },
      evaluate: async () => {
        throw new Error("The fake browser runs no script")
      },
      place: (bounds) => {
        browserPlaced.push(
          `${workflowId}:${bounds ? `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}` : "hidden"}`,
        )
      },
      allowUserInput: (allowed) => {
        browserInput.push(`${workflowId}:${allowed ? "on" : "off"}`)
      },
      close: () => {
        if (!open) return
        open = false
        browserLog.push(`${workflowId}:close`)
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
    homeDir,
    resolveHost: async (host) => {
      const list = hosts.get(host.toLowerCase())
      if (!list) throw new Error(`ENOTFOUND ${host}`)
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
    },
    systemLocale: () => "en-US",
    pickFolder: async () => undefined,
    pickFiles: async () => [],
    pickSavePath: async () => shell.savePath,
    pickArchive: async () => undefined,
    pickWorkflowFileSave: async () => undefined,
    pickWorkflowFile: async () => undefined,
    openPath: async () => {},
    openFile: async () => {},
    setStartAtLogin: () => {},
    setKeepAwake: (on) => {
      if (shell.awake === on) return
      shell.awake = on
      shell.awakeLog.push(on ? "on" : "off")
    },
    keepAwakeHeld: () => shell.awake,
    onBattery: () => shell.battery,
    onPowerSource: (listener) => {
      shell.powerListeners.push(listener)
    },
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
    browser: (workflowId) => {
      const known = pages.get(workflowId)
      if (known) return known
      const page = fakeBrowser(workflowId)
      pages.set(workflowId, page)
      return page
    },
    setBrowserProfile: (workflowId, profileId) => {
      const before = browserProfiles.get(workflowId)
      if (profileId === undefined) browserProfiles.delete(workflowId)
      else browserProfiles.set(workflowId, profileId)
      if (before !== profileId) pages.get(workflowId)?.close()
    },
    clearBrowserProfile: async (profileId) => {
      clearedProfiles.push(profileId)
    },
    diagnosticReport: async () => ({ text: "report", path: join(dataDir, "logs", "report.txt") }),
  }
  return {
    platform,
    dataDir,
    homeDir,
    hosts,
    trashed,
    browserLog,
    browserPlaced,
    browserInput,
    browserProfiles,
    clearedProfiles,
    shell,
    seedBrowserPage,
  }
}

/** The full app layer on an in-memory database, with recorded events. */
export const testRuntime = (
  options: {
    name?: string
    network?: MemoryNetwork
    decisionUrl?: string
    cacheHosts?: readonly string[]
    /** A database file, for a test that starts the app again on the same data. */
    databaseFile?: string
    /** How connections are reached, and their time limits (spec 018). */
    connections?: ConnectionsOptions
    /** The check of workflows (spec 010). A test turns the check in the background off. */
    check?: WorkflowCheckOptions
  } = {},
) => {
  const {
    platform,
    dataDir,
    homeDir,
    hosts,
    trashed,
    browserLog,
    browserPlaced,
    browserInput,
    browserProfiles,
    clearedProfiles,
    shell,
    seedBrowserPage,
  } = testPlatform()
  const events: { event: string; payload: unknown; server?: string }[] = []
  const runtime = ManagedRuntime.make(
    appLayer({
      platform,
      databaseFile: options.databaseFile ?? ":memory:",
      linkPort: 0,
      nearbySocket: (options.network ?? new MemoryNetwork()).open,
      localServerName: options.name ?? "Test computer",
      emit: (event, payload, server) =>
        events.push(server === undefined ? { event, payload } : { event, payload, server }),
      secrets: Secrets.memory,
      ...(options.decisionUrl ? { decisionUrl: options.decisionUrl } : {}),
      ...(options.cacheHosts ? { cacheHosts: options.cacheHosts } : {}),
      ...(options.connections ? { connections: options.connections } : {}),
      check: { auto: false, ...options.check },
    }),
  )
  // The requests of linked devices run the real handlers, as in the app.
  void bindLinkDispatcher(runtime)
  return {
    runtime,
    dataDir,
    homeDir,
    hosts,
    trashed,
    events,
    browserLog,
    browserPlaced,
    browserInput,
    browserProfiles,
    clearedProfiles,
    shell,
    seedBrowserPage,
  }
}

export type TestRuntime = ReturnType<typeof testRuntime>["runtime"]

/**
 * Saves the rule "Always allow for this workflow" for a fetch of a local host (spec 007, "Addresses of
 * a web page fetch"). A test that fetches from a test server on this computer needs it: a fetch of
 * a local address is a hard step, and it asks without the rule.
 */
export const allowLocalHost = (runtime: TestRuntime, workflowId: string, host = "127.0.0.1") =>
  runtime.runPromise(
    Rules.use((rules) =>
      Effect.sync(() => {
        rules.saveFromCard(workflowId, { kind: "web", host })
      }),
    ),
  )
export { Effect, Layer }
