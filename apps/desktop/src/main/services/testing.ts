import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TeachEvent } from "@robot/shared"
import { Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { MemoryNetwork } from "../link/nearby.testing.ts"
import { bindLinkDispatcher } from "../rpc.ts"
import { FakeChat } from "../teams/fakeChat.testing.ts"
import type { ConnectionsOptions } from "./Connections.ts"
import type { BrowserPage, PlatformService } from "./Platform.ts"
import { Rules } from "./Rules.ts"
import { Secrets } from "./Secrets.ts"
import { fakeClock } from "./silence.testing.ts"

/**
 * A platform for unit tests: a temp data folder and a trash list. A test that restarts the app
 * gives the same stand-in Teams to both starts, because the outside world does not restart.
 */
export const testPlatform = (options: { chat?: FakeChat } = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "robot-unit-"))
  // A home folder of its own, so a test never reads or writes a real place of the user (spec 007).
  const homeDir = mkdtempSync(join(tmpdir(), "robot-unit-home-"))
  /** The addresses that each host name leads to, for a web page fetch. A name not here fails. */
  const hosts = new Map<string, string[]>()
  const trashed: string[] = []
  /** What the fake browsers did, in order, as "agent:action". */
  const browserLog: string[] = []
  /** Where the fake browsers were told to show, as "agent:x,y WxH" or "agent:hidden". */
  const browserPlaced: string[] = []
  /** Whether the input of the user was let in or kept out, as "agent:on" or "agent:off". */
  const browserInput: string[] = []
  const pages = new Map<string, BrowserPage>()
  /** The stand-in Teams (spec 028). No Teams page opens until the Teams link asks for one. */
  const chat = options.chat ?? new FakeChat()
  /** The browser profile that holds the sign-in of the Teams page now, as the platform was told. */
  const teamsProfile: { id: string | undefined } = { id: undefined }
  /** The browser profile that each agent uses now, as the fake platform was told. */
  const browserProfiles = new Map<string, string>()
  /** The browser profiles whose saved data was deleted, in order. */
  const clearedProfiles: string[] = []
  /** The recorders of "Teach a task" that run now, by agent. A test calls one to act as the user. */
  const recorders = new Map<string, (event: TeachEvent) => void>()
  const shell = {
    focused: true,
    notices: [] as { title: string; body: string; click: () => void }[],
    shapes: [] as string[],
    fits: [] as { width: number; height: number }[],
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
      evaluate: async () => {
        throw new Error("The fake browser runs no script")
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
      record: (listener) => {
        if (listener) recorders.set(agentId, listener)
        else recorders.delete(agentId)
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
    pickAgentFileSave: async () => undefined,
    pickAgentFile: async () => undefined,
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
    setBrowserProfile: (agentId, profileId) => {
      const before = browserProfiles.get(agentId)
      if (profileId === undefined) browserProfiles.delete(agentId)
      else browserProfiles.set(agentId, profileId)
      if (before !== profileId) pages.get(agentId)?.close()
    },
    clearBrowserProfile: async (profileId) => {
      clearedProfiles.push(profileId)
      // The saved sign-in is gone: the stand-in Teams shows a sign-in form again.
      if (profileId === teamsProfile.id) chat.endSession()
    },
    teams: () => chat.surface,
    setTeamsProfile: (profileId) => {
      if (profileId !== teamsProfile.id) chat.closeByUser()
      teamsProfile.id = profileId
    },
  }
  return {
    platform,
    chat,
    teamsProfile,
    dataDir,
    homeDir,
    hosts,
    trashed,
    browserLog,
    browserPlaced,
    browserInput,
    browserProfiles,
    clearedProfiles,
    recorders,
    shell,
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
    /** The stand-in Teams to use. A restart gives the same one to both starts. */
    chat?: FakeChat
    /** How connections are reached, and their time limits (spec 018). */
    connections?: ConnectionsOptions
  } = {},
) => {
  const {
    platform,
    chat,
    teamsProfile,
    dataDir,
    homeDir,
    hosts,
    trashed,
    browserLog,
    browserPlaced,
    browserInput,
    browserProfiles,
    clearedProfiles,
    recorders,
    shell,
  } = testPlatform(options.chat ? { chat: options.chat } : {})
  const events: { event: string; payload: unknown; server?: string }[] = []
  // The clock of the Teams link. A test moves it by hand (`advance`, `sleep`).
  const { clock, advance, sleep } = fakeClock()
  const runtime = ManagedRuntime.make(
    appLayer({
      platform,
      clock,
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
    }),
  )
  // The requests of linked devices run the real handlers, as in the app.
  void bindLinkDispatcher(runtime)
  return {
    runtime,
    chat,
    teamsProfile,
    clock,
    advance,
    sleep,
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
    recorders,
    shell,
  }
}

export type TestRuntime = ReturnType<typeof testRuntime>["runtime"]

/**
 * Saves the rule "Always allow for this agent" for a fetch of a local host (spec 007, "Addresses of
 * a web page fetch"). A test that fetches from a test server on this computer needs it: a fetch of
 * a local address is a hard step, and it asks without the rule.
 */
export const allowLocalHost = (runtime: TestRuntime, agentId: string, host = "127.0.0.1") =>
  runtime.runPromise(
    Rules.use((rules) =>
      Effect.sync(() => {
        rules.saveFromCard(agentId, { kind: "web", host })
      }),
    ),
  )
export { Effect, Layer }
