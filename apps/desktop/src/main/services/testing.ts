import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ControlExpect } from "@robot/shared"
import { Effect, Layer, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { MemoryNetwork } from "../link/nearby.testing.ts"
import { bindLinkDispatcher } from "../rpc.ts"
import { PAGE_CONTROLS_MAX } from "../web/pageControls.ts"
import type { ConnectionsOptions } from "./Connections.ts"
import type {
  BrowserAct,
  BrowserActionState,
  BrowserDialog,
  BrowserInspect,
  BrowserPage,
  NavigationPolicy,
  PlatformService,
} from "./Platform.ts"
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
  /** The control submits a form with this method (lower case). */
  submit?: { method: string; host?: string }
  /** A password, a code or a card field. */
  secure?: boolean
  /** A click opens this dialog; the click returns while it waits. */
  opens?: BrowserDialog
  /** A click opens a file chooser. */
  chooser?: boolean
  /** A click goes to this address, as a link does. */
  goes?: string
  /** A select field: the options a choice may name. */
  options?: string[]
  /** The tag of the element. Default: `a` for a link, `input` for a box, else `button`. */
  tag?: string
  /** A plain link, as the page proves it. Default: true for a link. */
  plain?: boolean
}

/** What a test puts on a fake page before the agent acts: its controls, focus, errors, load. */
export interface FakeBrowserSeed {
  controls?: FakeBrowserControl[]
  focus?: string | null
  errors?: string[]
  loading?: boolean
  /** The text of the page. Default: "Text of <address>". */
  text?: string
  title?: string
  /** An address that redirects to another one, as a server does: `from -> to`. */
  redirects?: Record<string, string>
  /** The page shows a password field in the page itself, or in a frame of this site. */
  secure?: "page" | { frame: string }
  /** The page plays sound. */
  audible?: boolean
  /** The picture the page gives. */
  picture?: Uint8Array
  /** The page does not answer: the next action waits until the test calls the release. */
  hang?: boolean
  /** A read or an inspect of the page fails with this reason, as a dead page does. */
  fails?: string
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
    /** The system says that memory is low (spec 007, "Idle work"). */
    memoryListeners: [] as (() => void)[],
    lowMemory: () => {
      for (const l of shell.memoryListeners) l()
    },
    /** The computer changes between its battery and power. */
    powerChanged: () => {
      for (const l of shell.powerListeners) l()
    },
  }
  interface Seed {
    controls: FakeBrowserControl[]
    focus: string | null
    errors: string[]
    loading: boolean
    text: string | null
    title: string
    redirects: Record<string, string>
    secure: "page" | { frame: string } | null
    audible: boolean
    picture: Uint8Array
    hang: boolean
    fails: string | null
  }
  const browserSeeds = new Map<string, Seed>()
  const freshSeed = (): Seed => ({
    controls: [],
    focus: null,
    errors: [],
    loading: false,
    text: null,
    title: "Fake page",
    redirects: {},
    secure: null,
    audible: false,
    picture: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    hang: false,
    fails: null,
  })
  const seedBrowserPage = (workflowId: string, seed: FakeBrowserSeed) => {
    browserSeeds.set(workflowId, {
      ...freshSeed(),
      controls: seed.controls ?? [],
      focus: seed.focus ?? null,
      errors: [...(seed.errors ?? [])],
      loading: seed.loading ?? false,
      text: seed.text ?? null,
      title: seed.title ?? "Fake page",
      redirects: seed.redirects ?? {},
      secure: seed.secure ?? null,
      audible: seed.audible ?? false,
      picture: seed.picture ?? freshSeed().picture,
      hang: seed.hang ?? false,
      fails: seed.fails ?? null,
    })
  }
  /** What a test may change on a page that is open. */
  const browserHang = new Map<string, { release: () => void }>()
  const fakeBrowser = (workflowId: string): BrowserPage => {
    let open = false
    let url = ""
    let dialog: BrowserDialog | null = null
    let chooser = false
    let typed = ""
    let policy: NavigationPolicy | undefined
    let blocked: string[] = []
    const listeners: (() => void)[] = []
    const state = () => {
      const known = browserSeeds.get(workflowId)
      if (known) return known
      const fresh = freshSeed()
      browserSeeds.set(workflowId, fresh)
      return fresh
    }
    /** Goes to an address as a page does: each hop meets the rule. */
    const go = async (to: string): Promise<string> => {
      let next = to
      for (let hops = 0; hops < 10; hops++) {
        if (policy && !(await policy(next))) {
          try {
            blocked.push(new URL(next).hostname)
          } catch {
            blocked.push(next)
          }
          return "about:blank"
        }
        const moved = state().redirects[next]
        if (!moved) return next
        next = moved
      }
      return next
    }
    const stall = async () => {
      if (!state().hang) return
      await new Promise<void>((resolve) => browserHang.set(workflowId, { release: resolve }))
    }
    const kindOf = (c: FakeBrowserControl) => ({
      role: c.role,
      label: c.label,
      tag: c.tag ?? (c.role === "link" ? "a" : c.role === "textbox" ? "input" : "button"),
    })
    /** The control must still be the one that a card named (the page may change while it waits). */
    const same = (c: FakeBrowserControl, expect: ControlExpect | undefined) => {
      if (!expect) return true
      const now = kindOf(c)
      return now.role === expect.role && now.label === expect.label && now.tag === expect.tag
    }
    const fit = (target: string): FakeBrowserControl | BrowserAct => {
      const s = state()
      if (/^\d+$/.test(target)) {
        const at = Number(target) - 1
        const found = s.controls[at]
        if (!found) return { ok: false, reason: "none" }
        return found
      }
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
      return fits[0] as FakeBrowserControl
    }
    const current = (): BrowserActionState => {
      const s = state()
      const errors = s.errors
      s.errors = []
      return {
        url,
        title: s.title,
        loading: s.loading,
        focus: s.focus,
        errors,
        dialog,
        chooser,
      }
    }
    const act = async (
      target: string,
      click: boolean,
      expect: ControlExpect | undefined,
    ): Promise<BrowserAct> => {
      await stall()
      // A page that was closed while the step waited does nothing.
      if (!open) return { ok: false, reason: "none" }
      const found = fit(target)
      if (!("selector" in found)) return found
      if (!same(found, expect)) return { ok: false, reason: "changed" }
      browserLog.push(
        `${workflowId}:${click ? "click" : "type"} ${target}${click ? "" : ` ${typed}`}`,
      )
      if (click) {
        if (found.opens) dialog = found.opens
        if (found.chooser) chooser = true
        if (found.goes) url = await go(found.goes)
      }
      return { ok: true, state: current() }
    }
    return {
      isOpen: () => open,
      currentUrl: () => (open ? url : ""),
      open: async (next) => {
        await stall()
        open = true
        url = await go(next)
        dialog = null
        chooser = false
        browserLog.push(`${workflowId}:open ${next}`)
        return { url, title: state().title }
      },
      read: async () => {
        await stall()
        const s = state()
        if (s.fails) throw new Error(s.fails)
        return {
          url,
          title: s.title,
          text: s.text ?? `Text of ${url}`,
          controls: s.controls
            .slice(0, PAGE_CONTROLS_MAX)
            .map((c, i) => ({ index: i + 1, role: c.role, label: c.label })),
          total: s.controls.length,
        }
      },
      click: async (target, expect) => act(target, true, expect),
      type: async (target, text, expect) => {
        typed = text
        return act(target, false, expect)
      },
      inspect: async (target): Promise<BrowserInspect> => {
        const found = fit(target)
        if (!("selector" in found)) return found as BrowserInspect
        return {
          ok: true,
          facts: {
            ...kindOf(found),
            submit: found.submit !== undefined,
            method: found.submit?.method ?? "get",
            secure: found.secure === true,
            plain: found.plain ?? found.role === "link",
          },
          formHost: found.submit?.host ?? null,
        }
      },
      select: async (target, value, expect) => {
        const found = fit(target)
        if (!("selector" in found)) return found
        if (!same(found, expect)) return { ok: false, reason: "changed" }
        browserLog.push(`${workflowId}:select ${target} ${value}`)
        if (!found.options?.includes(value)) return { ok: false, reason: "none" }
        return { ok: true, state: current() }
      },
      screenshot: async () => {
        browserLog.push(`${workflowId}:screenshot`)
        return state().picture
      },
      securePlace: async () => {
        const secure = state().secure
        if (secure === null) return null
        return secure === "page" ? { kind: "page" } : { kind: "frame", site: secure.frame }
      },
      dialog: () => dialog,
      answerDialog: async (accept, text) => {
        if (!dialog) return { ok: false }
        browserLog.push(
          `${workflowId}:dialog ${accept ? "accept" : "dismiss"}${text ? ` ${text}` : ""}`,
        )
        dialog = null
        return { ok: true, state: current() }
      },
      chooserOpen: () => chooser,
      upload: async (paths) => {
        if (!chooser) return { ok: false, reason: "no_chooser" }
        chooser = false
        browserLog.push(`${workflowId}:upload ${paths.length}`)
        return { ok: true }
      },
      setPolicy: (next) => {
        policy = next
      },
      drainBlocked: () => {
        const list = blocked
        blocked = []
        return list
      },
      audible: () => open && state().audible,
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
        dialog = null
        chooser = false
        browserLog.push(`${workflowId}:close`)
        // A step that waits for a page that is gone ends with the page.
        browserHang.get(workflowId)?.release()
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
    onLowMemory: (listener) => {
      shell.memoryListeners.push(listener)
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
    /** Lets a page that was seeded to hang answer. */
    releaseBrowser: (workflowId: string) => browserHang.get(workflowId)?.release(),
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
    /** The clock and the idle timer of the browser work (spec 007). A test calls the sweep. */
    browser?: { now?: () => number; sweepMs?: number }
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
    releaseBrowser,
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
      browser: { sweepMs: 0, ...options.browser },
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
    releaseBrowser,
    platform,
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
