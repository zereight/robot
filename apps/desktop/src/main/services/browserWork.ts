import {
  BROWSER_LIMITS,
  type BrowserBounds,
  type BrowserState,
  browserAddress,
  browserHost,
  kindOfAddress,
  redactSecrets,
  worstKind,
} from "@robot/shared"
import { appendLog } from "./logs.ts"
import type { BrowserPage, NavigationPolicy, PlatformService } from "./Platform.ts"

/**
 * The browser work of the workflows (spec 007, "Browser details", "Idle work"). The platform holds
 * one page for each workflow. This holds what the platform does not know: when the page was used
 * last, the hosts that the user allowed on this page, whether the user holds the page, and the
 * address that an unloaded page loads again.
 *
 * Browser data (cookies, logins) is kept for each workflow: the platform opens the page on the
 * data of the browser profile of the workflow, or on data of its own (BrowserProfiles).
 */

interface Entry {
  lastUsed: number
  /** The address of a page that idle work unloaded. The next use loads it again. */
  unloadedUrl: string | null
  /** The user holds the page (a take-control card waits). */
  held: boolean
  /** The window shows the page now. */
  shown: boolean
  /** The hosts of local addresses that the user allowed for this page. */
  localHosts: Set<string>
  /** True while `unload` closes the page, so that the close does not forget the address. */
  unloading: boolean
  /** The tasks whose Stop closes the page, by signal. */
  stops: WeakSet<AbortSignal>
}

export interface BrowserWorkOptions {
  readonly platform: PlatformService
  /** The clock. A test gives a clock of its own. */
  readonly now?: () => number
  /** Called when a page opened, closed, was unloaded, or the user took or gave back control. */
  readonly changed: (workflowId: string) => void
  /** How often idle work looks at the pages. 0: never (a test calls `sweep`). */
  readonly sweepMs?: number
}

/** A name leads to local addresses for this long, as the page rule remembers it. */
const RESOLVE_KEEP_MS = 30_000

export type BrowserWork = ReturnType<typeof makeBrowserWork>

export const makeBrowserWork = (options: BrowserWorkOptions) => {
  const { platform } = options
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  const resolved = new Map<string, { at: number; kind: "never" | "local" | "public" }>()

  const entry = (workflowId: string): Entry => {
    let e = entries.get(workflowId)
    if (!e) {
      e = {
        lastUsed: now(),
        unloadedUrl: null,
        held: false,
        shown: false,
        localHosts: new Set(),
        unloading: false,
        stops: new WeakSet(),
      }
      entries.set(workflowId, e)
    }
    return e
  }

  /** The line of the browser log (spec 014). It holds no text of a page, no secret and no id. */
  const log = (event: string, data: Record<string, unknown> = {}) => {
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data))
      safe[key] = typeof value === "string" ? redactSecrets(value).slice(0, 300) : value
    appendLog(platform.dataDir, "browser", { event, page: "workflow", ...safe })
  }

  /** What a host name leads to, as the look-up of the platform tells. Kept for a short time. */
  const kindOfName = async (host: string) => {
    const known = resolved.get(host)
    if (known && now() - known.at < RESOLVE_KEEP_MS) return known.kind
    const found = await platform.resolveHost(host)
    const kind = worstKind(found.map((f) => kindOfAddress(f.address)))
    resolved.set(host, { at: now(), kind })
    return kind
  }

  /**
   * The rule for the addresses of one page (spec 007, "Addresses of a web page fetch"): only
   * `http` and `https` load, with `data:` and `blob:` for the page itself. A link-local or a
   * metadata address never loads. A local address loads only when the user allowed that host for
   * this page, in the card for an address that the node opened. A name that leads to an address
   * is judged by the address.
   */
  const policyOf =
    (workflowId: string): NavigationPolicy =>
    async (url) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return false
      }
      const scheme = parsed.protocol
      if (scheme === "data:" || scheme === "blob:" || scheme === "about:") return true
      if (scheme === "ws:" || scheme === "wss:") {
        parsed = new URL(url.replace(/^ws/, "http"))
      } else if (scheme !== "http:" && scheme !== "https:") return false
      const checked = browserAddress(parsed.href)
      if (checked.kind === "refused") return false
      const allowed = entry(workflowId).localHosts
      if (checked.writing.kind === "local") return allowed.has(checked.host)
      if (checked.writing.kind === "name") {
        try {
          const kind = await kindOfName(checked.host)
          if (kind === "never") return false
          if (kind === "local") return allowed.has(checked.host)
        } catch {
          // A name that does not resolve does not load. Fail closed.
          return false
        }
      }
      return true
    }

  const pages = new Set<string>()
  /** The page of a workflow, with its address rule and its listeners. */
  const page = (workflowId: string): BrowserPage => {
    const p = platform.browser(workflowId)
    if (!pages.has(workflowId)) {
      pages.add(workflowId)
      p.setPolicy(policyOf(workflowId))
      p.onClosed(() => {
        const e = entry(workflowId)
        e.held = false
        e.shown = false
        if (!e.unloading) e.unloadedUrl = null
        options.changed(workflowId)
      })
    }
    return p
  }

  const touch = (workflowId: string) => {
    entry(workflowId).lastUsed = now()
  }

  const stateOf = (workflowId: string): BrowserState => {
    const e = entries.get(workflowId)
    const p = pages.has(workflowId) ? platform.browser(workflowId) : undefined
    const open = p?.isOpen() ?? false
    return {
      open,
      unloaded: !open && !!e?.unloadedUrl,
      host: e?.unloadedUrl ? browserHost(e.unloadedUrl) : "",
      title: "",
      held: e?.held ?? false,
    }
  }

  /** Loads the page again when idle work unloaded it. Does nothing for a page that is open. */
  const ensureLoaded = async (workflowId: string, signal?: AbortSignal) => {
    const e = entry(workflowId)
    const p = page(workflowId)
    if (p.isOpen() || !e.unloadedUrl) return
    const url = e.unloadedUrl
    e.unloadedUrl = null
    signal?.throwIfAborted()
    await p.open(url)
    options.changed(workflowId)
  }

  /**
   * Unloads the page of a workflow: it closes, and its tab stays with the address, so the next use
   * loads it again (spec 007, "Idle work"). A page that a step found dead is unloaded the same way.
   */
  const unload = (workflowId: string) => {
    if (!pages.has(workflowId)) return
    const e = entry(workflowId)
    const p = platform.browser(workflowId)
    const url = p.currentUrl()
    e.unloading = true
    try {
      p.close()
    } finally {
      e.unloading = false
    }
    e.unloadedUrl = url || null
    options.changed(workflowId)
  }

  /**
   * Unloads the pages that nobody used for 10 minutes (spec 007, "Idle work"). With `all`, the
   * system said that memory is low: it unloads every idle page at once, without the time. A page
   * that plays sound, or that the user holds, stays. Returns the workflows that were unloaded.
   */
  const sweep = (all = false): string[] => {
    const done: string[] = []
    for (const [workflowId, e] of entries) {
      if (!pages.has(workflowId)) continue
      const p = platform.browser(workflowId)
      if (!p.isOpen() || e.held) continue
      if (!all && now() - e.lastUsed < BROWSER_LIMITS.idleMs) continue
      if (p.audible()) continue
      unload(workflowId)
      done.push(workflowId)
    }
    return done
  }

  /** Holds the page for the user, or gives it back. The page takes the user's input while held. */
  const hold = (workflowId: string, on: boolean) => {
    const e = entry(workflowId)
    if (e.held === on) return
    e.held = on
    if (pages.has(workflowId)) {
      const p = platform.browser(workflowId)
      p.allowUserInput(on)
      if (!on) {
        p.place(undefined)
        e.shown = false
      }
    }
    options.changed(workflowId)
  }

  /** Shows the page in a place of the window, or hides it. The user's input needs a hold. */
  const place = (workflowId: string, bounds: BrowserBounds | null) => {
    if (!pages.has(workflowId)) return
    const e = entry(workflowId)
    const p = platform.browser(workflowId)
    if (!p.isOpen()) return
    e.shown = bounds !== null
    p.place(bounds ?? undefined)
    p.allowUserInput(e.held && bounds !== null)
  }

  /** Closes the page of a workflow now, and forgets what idle work knew about it. */
  const forget = (workflowId: string) => {
    const e = entries.get(workflowId)
    if (e) e.unloadedUrl = null
    if (pages.has(workflowId)) platform.browser(workflowId).close()
    entries.delete(workflowId)
    options.changed(workflowId)
  }

  /**
   * Stop of a task ends its browser work at once (spec 007): the page closes. The browser data
   * stays, so the next page opens signed in.
   */
  const closeOnStop = (workflowId: string, signal: AbortSignal) => {
    const e = entry(workflowId)
    if (e.stops.has(signal)) return
    e.stops.add(signal)
    const stop = () => {
      const started = now()
      const p = pages.has(workflowId) ? platform.browser(workflowId) : undefined
      const was = p?.isOpen() ?? false
      e.held = false
      e.unloadedUrl = null
      p?.close()
      log("stop", { open: was, ms: now() - started })
      options.changed(workflowId)
    }
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
  }

  /** Closes the page for good (the tool "close browser"): the next page opens anew. */
  const close = (workflowId: string) => {
    const e = entry(workflowId)
    e.unloadedUrl = null
    if (pages.has(workflowId)) platform.browser(workflowId).close()
    options.changed(workflowId)
  }

  /** The user allows a local host for this page, on the card of an address. */
  const allowLocal = (workflowId: string, host: string) => {
    entry(workflowId).localHosts.add(host)
  }

  platform.onLowMemory(() => sweep(true))
  const sweepMs = options.sweepMs ?? 60_000
  if (sweepMs > 0) setInterval(() => sweep(), sweepMs).unref()

  return {
    page,
    touch,
    state: stateOf,
    ensureLoaded,
    sweep,
    unload,
    close,
    kindOfName,
    hold,
    place,
    forget,
    closeOnStop,
    allowLocal,
    log,
    isLocalAllowed: (workflowId: string, host: string) => entry(workflowId).localHosts.has(host),
    policy: policyOf,
  }
}
