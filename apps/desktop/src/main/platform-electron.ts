import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir, arch as osArch, release as osRelease, type as osType } from "node:os"
import { basename, join } from "node:path"
import {
  BROWSER_LIMITS,
  type ControlPlace,
  PAGE_INPUT_CHANNEL,
  resolveLocale,
  SCREEN_INPUT_CHANNEL,
  translate,
} from "@robot/shared"
import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  Notification,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  WebContentsView,
} from "electron"
import { getDialogLanguage } from "./dialogLanguage.ts"
import { appendLog, pruneOldLogs, readLogTail } from "./services/logs.ts"
import type {
  BrowserAct,
  BrowserActionState,
  BrowserDialog,
  BrowserInspect,
  BrowserPage,
  NavigationPolicy,
  PageBounds,
  PlatformService,
} from "./services/Platform.ts"
import { type Resolver, systemResolver } from "./web/fetch.ts"
import {
  PAGE_WORLD_ID,
  type PageActAnswer,
  type PageInspectAnswer,
  type PageReadAnswer,
  type PageStateAnswer,
  pageActScript,
  pageInspectScript,
  pageReadScript,
  pageSecureScript,
  pageSelectScript,
  pageStateScript,
} from "./web/pageControls.ts"
import {
  BOX_SCRIPT,
  type BoxMeasure,
  buildReport,
  cleanInputNote,
  createInputDiagnostics,
  type DiagWrite,
  lineBudget,
  PAGE_DRAG_SCRIPT,
  PAGE_NO_DRAG_CSS,
  type PageDrag,
  type PageSnapshot,
} from "./web/pageDiagnostics.ts"
import { fitPage, PAGE_VIEW } from "./web/pageFit.ts"
import { pageUserAgent } from "./web/userAgent.ts"

/** True when an end-to-end test runs the app. The app then leaves system settings alone. */
export const isTestRun = Boolean(process.env.ROBOT_USER_DATA)

/** A file-dialog filter name in the chosen language (spec 013). */
const dialogFilter = (key: "dialog.filter.export" | "dialog.filter.workflows"): string =>
  translate(
    resolveLocale(getDialogLanguage(), process.env.ROBOT_SYSTEM_LOCALE ?? app.getLocale()),
    key,
  )

const PAGE_TEXT_MAX = 20_000

/**
 * A test run can give a table of host names and the addresses they lead to, as JSON in
 * `ROBOT_TEST_HOSTS`. A name that is not in the table fails like a name that does not exist, so a
 * test never reaches the real name service. A real run has none.
 */
const testHosts = (): Resolver | undefined => {
  if (!isTestRun || !process.env.ROBOT_TEST_HOSTS) return undefined
  const table = JSON.parse(process.env.ROBOT_TEST_HOSTS) as Record<string, string[]>
  return async (host) => {
    const list = table[host.toLowerCase()]
    if (!list) throw new Error(`ENOTFOUND ${host}`)
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
  }
}

const browsers = new Map<string, BrowserPage>()
/** The browser profile that each agent uses. An agent that is not here uses its own data. */
const browserProfiles = new Map<string, string>()

/** The name of the saved data that the browser of an agent uses. */
const partitionOf = (agentId: string) => {
  const profile = browserProfiles.get(agentId)
  return profile ? `persist:browser-${profile}` : `persist:agent-${agentId}`
}

/**
 * The rule for the addresses of each page that a workflow uses, by the id of its web contents
 * (spec 007, "Addresses of a web page fetch"). A session is shared by the workflows that use the
 * same browser profile, so the rule is looked up for each request.
 */
interface PageRule {
  policy: () => NavigationPolicy | undefined
  /** The page was kept from this address. */
  blocked: (url: string) => void
  /** A download that the page started was cancelled. */
  download: (host: string) => void
  /**
   * Whether the page may have a permission of the system (a notification, the location, the
   * camera, the clipboard). A page of a workflow has none; a page of the app itself names what it
   * needs.
   */
  permit: (permission: string) => boolean
}
const pageRules = new Map<number, PageRule>()
const guardedSessions = new WeakSet<Electron.Session>()
/**
 * The sessions that hold a page of a workflow, which has a rule for its addresses. A request that
 * no page owns (a service worker, a shared worker) has no rule to ask in such a session, so it is
 * cancelled: the rule is the only thing that keeps a worker of a page from a private address.
 */
const strictSessions = new WeakSet<Electron.Session>()

/** The kinds of request that a page may use to run code outside of its own rule. */
const WORKER_TYPES = new Set(["serviceWorker", "sharedWorker"])

/**
 * Puts the rule on a session once: every request of a page that has a rule is checked (the first
 * load, a frame, a script, an image), and so is the target of each redirect. A request that no
 * page owns is cancelled in a session of a workflow, and so is the script of a service worker or
 * of a shared worker. A download is cancelled: the browser tools take no file from a page (the open
 * rows of B9). Every permission is refused unless the page has a rule that names it.
 */
const guardSession = (data: Electron.Session) => {
  if (guardedSessions.has(data)) return
  guardedSessions.add(data)
  const allowed = async (details: {
    webContentsId?: number
    resourceType?: string
    url: string
  }): Promise<boolean> => {
    const strict = strictSessions.has(data)
    const id = details.webContentsId
    const rule = id === undefined ? undefined : pageRules.get(id)
    if (
      strict &&
      (id === undefined || (details.resourceType && WORKER_TYPES.has(details.resourceType)))
    ) {
      // The worker has no rule of its own, and the page that started it cannot be told apart.
      rule?.blocked(details.url)
      return false
    }
    const policy = rule?.policy()
    if (!rule || !policy) return true
    const ok = await policy(details.url).catch(() => false)
    if (!ok) rule.blocked(details.url)
    return ok
  }
  data.webRequest.onBeforeRequest((details, callback) => {
    void allowed(details).then((ok) => callback({ cancel: !ok }))
  })
  data.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {}
    const found = Object.entries(headers).find(([name]) => name.toLowerCase() === "location")
    const location = Array.isArray(found?.[1]) ? found?.[1][0] : undefined
    if (details.statusCode < 300 || details.statusCode >= 400 || !location) {
      callback({})
      return
    }
    let target: string
    try {
      target = new URL(location, details.url).href
    } catch {
      callback({ cancel: true })
      return
    }
    void allowed({ ...details, url: target }).then((ok) => callback(ok ? {} : { cancel: true }))
  })
  data.on("will-download", (event, item, wc) => {
    const rule = wc ? pageRules.get(wc.id) : undefined
    if (!rule) return
    event.preventDefault()
    item.cancel()
    rule.download(hostOf(item.getURL()))
  })
  // Electron grants every permission that a page asks for, unless the app answers. The app
  // answers no, for a page without a rule that names the permission, and for a worker.
  const permitted = (wc: Electron.WebContents | null, permission: string) =>
    (wc ? pageRules.get(wc.id) : undefined)?.permit(permission) === true
  data.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permitted(wc, permission))
  })
  data.setPermissionCheckHandler((wc, permission) => permitted(wc, permission))
  data.setDevicePermissionHandler(() => false)
  data.setDisplayMediaRequestHandler((_request, callback) => callback(null))
}

/** The dialog that nobody answers is dismissed after this time. A test may make it shorter. */
const dialogMs = () =>
  (isTestRun && Number(process.env.ROBOT_BROWSER_DIALOG_MS)) || BROWSER_LIMITS.dialogMs

/** What each page says about itself for the diagnostic report. */
const snapshots = new Map<string, () => PageSnapshot>()
/**
 * Each page checks a press that the app screen got: did it land inside the place of the page? Then
 * the page is drawn there, but the system gave the press to the screen under it.
 */
const screenPresses = new Map<string, (type: string, x: number, y: number) => void>()

/** The host of an address, or an empty text. The report never holds a path or a query. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

let mainWindow: BrowserWindow | undefined

/**
 * The app log (spec 014): what the app does around its windows and its processes. A line holds
 * the kind of event, sizes, counts and places in the code. It never holds a message or a text.
 */
const appLog: DiagWrite = (event, data) =>
  appendLog(app.getPath("userData"), "app", { event, ...data })
/**
 * The counts of input on the app screen: what the window gives to it, and what its document gets.
 * They stay for the whole run, also when the window is made again.
 */
const screenDiag = createInputDiagnostics(appLog)
/** Lines about the windows and the processes that the app may write in a minute. */
const eventRoom = lineBudget(60)
const logEvent: DiagWrite = (event, data) => {
  if (eventRoom()) appLog(event, data)
}

/** What the app screen says about itself for the diagnostic report. */
const screenSnapshot = (): PageSnapshot => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const wc = win?.webContents
  const content = win?.getContentBounds()
  const size = content ? { x: 0, y: 0, width: content.width, height: content.height } : null
  return {
    page: "app",
    open: win !== undefined,
    plain: true,
    userInput: true,
    placed: null,
    view: size,
    visible: win?.isVisible() ?? null,
    zoom: wc?.getZoomFactor() ?? null,
    inWindow: win ? "main" : "none",
    stackIndex: null,
    stackSize: null,
    pageFocused: wc?.isFocused() ?? null,
    windowFocused: win?.isFocused() ?? null,
    loading: wc?.isLoading() ?? null,
    host: wc ? hostOf(wc.getURL()) : "",
    shownMs: 0,
    pageDrag: null,
    counts: screenDiag.counts(),
  }
}

/** The boxes where the pages show, as the screen measured them the last time that it could. */
let lastBoxes: BoxMeasure[] = []
let boxTimer: ReturnType<typeof setTimeout> | undefined

/** Asks the app screen to measure the boxes of the pages. A screen that does not answer: none. */
const measureBoxes = async (): Promise<BoxMeasure[]> => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  if (!win) return []
  const measured = await Promise.race([
    win.webContents.executeJavaScript(BOX_SCRIPT, true).catch(() => []) as Promise<BoxMeasure[]>,
    new Promise<BoxMeasure[]>((resolve) => setTimeout(() => resolve([]), 1_500)),
  ])
  const measuredAt = new Date().toISOString()
  return Array.isArray(measured) ? measured.map((box) => ({ ...box, measuredAt })) : []
}

/**
 * Measures the boxes a moment after the place of a page stopped changing, and keeps the numbers for
 * the report: the box is gone from the screen when the user makes the report.
 */
const noteBoxesSoon = () => {
  clearTimeout(boxTimer)
  boxTimer = setTimeout(() => {
    void measureBoxes().then((boxes) => {
      for (const box of boxes)
        lastBoxes = [...lastBoxes.filter((known) => known.page !== box.page), box]
    })
  }, 700)
}
/**
 * Moves the page of an agent to another window. Each page has one. A page that the user holds
 * does not move: it closes, because the user cannot hold a page that has no view.
 */
const rehomers = new Map<string, (to: () => BaseWindow) => void>()

/** True from the start of a quit. Pages do not move then: the app ends and takes them along. */
let quitting = false
app.on("before-quit", () => {
  quitting = true
})

/** The window that holds the pages while the app has no main window. Nobody sees it. */
let shelf: BaseWindow | undefined
const shelfWindow = () => {
  if (!shelf || shelf.isDestroyed()) {
    // A page that works needs a size like the one of a real window, also while nobody sees it.
    shelf = new BaseWindow({
      show: false,
      width: PAGE_VIEW.width,
      height: PAGE_VIEW.height,
    })
  }
  return shelf
}
/** Where a page sits: in the main window, or on the shelf while the app has no main window. */
const hostWindow = (): BaseWindow =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : shelfWindow()

/**
 * Writes the app log about one window: the focus, the size, the screen process. A drag of the
 * window moves it on each frame, so a move or a resize is written once, when it is over.
 */
const watchWindow = (win: BrowserWindow) => {
  const wc = win.webContents
  const bounds = () => (win.isDestroyed() ? null : win.getBounds())
  logEvent("window_created", { bounds: bounds() })
  win.on("focus", () => logEvent("window_focus", {}))
  win.on("blur", () => logEvent("window_blur", {}))
  win.on("show", () => logEvent("window_show", {}))
  win.on("hide", () => logEvent("window_hide", {}))
  win.on("minimize", () => logEvent("window_minimize", {}))
  win.on("restore", () => logEvent("window_restore", {}))
  win.on("enter-full-screen", () => logEvent("window_full_screen", { on: true }))
  win.on("leave-full-screen", () => logEvent("window_full_screen", { on: false }))
  let settle: ReturnType<typeof setTimeout> | undefined
  const moved = () => {
    clearTimeout(settle)
    settle = setTimeout(() => logEvent("window_bounds", { bounds: bounds() }), 400)
  }
  win.on("resize", moved)
  win.on("move", moved)
  win.once("closed", () => {
    clearTimeout(settle)
    logEvent("window_closed", {})
  })
  wc.on("did-finish-load", () => logEvent("screen_loaded", {}))
  wc.on("did-fail-load", (_, code, __, ___, isMainFrame) => {
    if (isMainFrame) logEvent("screen_load_failed", { code })
  })
  wc.on("render-process-gone", (_, details) =>
    logEvent("screen_process_gone", { reason: details.reason, exitCode: details.exitCode }),
  )
  wc.on("unresponsive", () => logEvent("screen_unresponsive", {}))
  wc.on("responsive", () => logEvent("screen_responsive", {}))
  // A script of the screen that fails is often the reason that a press does nothing. The line
  // holds the place in the code and never the message: a message can hold text of the user.
  wc.on("console-message", (details) => {
    if (details.level !== "error") return
    logEvent("screen_error", {
      source: basename(details.sourceId.split("?")[0] ?? ""),
      line: details.lineNumber,
    })
  })
}

/** The app log about the computer and the processes: the displays, a crash of a child process. */
const watchApp = () => {
  logEvent("started", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
  })
  app.on("child-process-gone", (_, details) =>
    logEvent("child_process_gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    }),
  )
  const displays = () => ({ count: screen.getAllDisplays().length })
  screen.on("display-added", () => logEvent("display_added", displays()))
  screen.on("display-removed", () => logEvent("display_removed", displays()))
  screen.on("display-metrics-changed", (_, display, changed) =>
    logEvent("display_changed", { changed, scaleFactor: display.scaleFactor }),
  )
  // A watcher only: it does not change what the app does with an error. Only the kind is kept.
  process.on("uncaughtExceptionMonitor", (error, origin) =>
    logEvent("uncaught_error", { origin, name: error.name }),
  )
}

/**
 * The window that holds the app. Notifications and the island bring it to the front, and the
 * pages of the agent browsers show inside it. On macOS the app goes on when the user closes the
 * window, and the agents go on with their pages: the pages wait on a window that nobody sees, and
 * come back to the next main window. Other systems quit with the window, so the pages close.
 */
export const setMainWindow = (win: BrowserWindow) => {
  mainWindow = win
  // Only counts: this never stops a press.
  win.webContents.on("before-mouse-event", (_, mouse) => {
    screenDiag.native(mouse.type, { x: mouse.x, y: mouse.y }, false)
    if (mouse.type !== "mouseDown" && mouse.type !== "mouseMove") return
    for (const check of screenPresses.values()) check(mouse.type, mouse.x, mouse.y)
  })
  // The document of the app screen tells what reached it: the other half of the count above.
  win.webContents.ipc.on(SCREEN_INPUT_CHANNEL, (_, payload: unknown) => {
    const note = cleanInputNote(payload)
    if (note) screenDiag.page(note)
  })
  watchWindow(win)
  for (const move of rehomers.values()) move(() => win)
  win.on("close", () => {
    if (process.platform !== "darwin" || quitting) return
    // The shelf opens only when a page needs it.
    for (const move of rehomers.values()) move(shelfWindow)
  })
  // A page has no place to show once the window is gone.
  win.once("closed", () => {
    if (process.platform !== "darwin") for (const page of browsers.values()) page.close()
  })
  // A new load of the app screen starts with no place for any page: the screen gives the places
  // again when it draws.
  win.webContents.on("did-start-loading", () => {
    for (const page of browsers.values()) page.place(undefined)
  })
}

/**
 * One page per agent, inside the main window. Its session is kept on disk, so logins stay between
 * runs. The session is the one of the browser profile of the agent, or its own. The screen of the chat says where the page shows. Until it does, the page is hidden.
 */
const electronBrowser = (
  agentId: string,
  options: {
    fixedLayout?: boolean
    log?: DiagWrite
    /** The permissions of the system that the page may have. Default: none. */
    permit?: (permission: string) => boolean
  } = {},
): BrowserPage => {
  /** The counts of input and the lines of the log about this page (the diagnostic report). */
  const diag = createInputDiagnostics(options.log ?? (() => {}))
  /**
   * A fixed layout keeps the size of PAGE_VIEW whatever the size of its place. A plain view (the
   * Teams page) fills its place exactly, so the clicks of the user land where the page shows them.
   */
  const fixedLayout = options.fixedLayout ?? true
  let view: WebContentsView | undefined
  let host: BaseWindow | undefined
  let bounds: PageBounds | undefined
  /** The view was visible once, so its page has a size. */
  let sized = false
  let userInput = false
  const listeners: (() => void)[] = []
  /** The rule for the addresses of this page, the hosts it was kept from, and its dialog. */
  let policy: NavigationPolicy | undefined
  let blocked: string[] = []
  let dialogNow: BrowserDialog | null = null
  let dismissed: BrowserDialog | null = null
  let dialogTimer: ReturnType<typeof setTimeout> | undefined
  const dialogWaiters: (() => void)[] = []
  /** The errors of the page since the last action (up to 20), as the debugger told them. */
  const pageErrors: string[] = []
  /** The file input that a chooser belongs to, while a chooser waits. */
  let chooserNode: number | null = null
  let cdpReady = false
  const live = () => (view && !view.webContents.isDestroyed() ? view : undefined)
  const need = () => {
    const v = live()
    if (!v) throw new Error("The browser is not open. Open a page first.")
    return v.webContents
  }
  const run = async <T>(code: string): Promise<T> => need().executeJavaScript(code, true)
  /**
   * Runs a script of the controls in an isolated world: it sees the DOM of the page and none of
   * its globals, so the page cannot forge what the script reads (`PAGE_WORLD_ID`).
   */
  const runIsolated = async <T>(code: string): Promise<T> =>
    (await need().executeJavaScriptInIsolatedWorld(PAGE_WORLD_ID, [{ code }], true)) as T
  /** The short state after an action: address, title, load, focus and the new errors. */
  const actionState = async (): Promise<BrowserActionState> => {
    const wc = need()
    const url = wc.getURL()
    const title = wc.getTitle()
    const loading = wc.isLoading()
    const extra = {
      dialog: dialogNow,
      chooser: chooserNode !== null,
      ...(dismissed ? { dismissed } : {}),
    }
    dismissed = null
    // The errors that the debugger told since the last action. Reading them clears them.
    const errors = pageErrors.splice(0).slice(0, 5)
    // A dialog blocks the page: no script runs until it is answered.
    if (extra.dialog) return { url, title, loading, focus: null, errors, ...extra }
    try {
      const seen = await runIsolated<PageStateAnswer>(pageStateScript())
      return { url, title, loading, focus: seen.focus, errors, ...extra }
    } catch {
      // The action moved to a new page: the state script has no document yet.
      return { url, title, loading, focus: null, errors, ...extra }
    }
  }
  /**
   * The debugger of the page, attached and ready: dialogs of the page come to the app (a dialog
   * that the app does not see would block the page), and a file chooser does not open a window of
   * the system. Undefined when the page has none.
   */
  const cdp = async () => {
    const v = live()
    if (!v) return undefined
    const dbg = v.webContents.debugger
    try {
      if (!dbg.isAttached()) {
        dbg.attach("1.3")
        emulated = undefined
        cdpReady = false
      }
    } catch {
      return undefined
    }
    if (!cdpReady) {
      cdpReady = true
      try {
        await dbg.sendCommand("Page.enable")
        await dbg.sendCommand("Runtime.enable")
        await dbg.sendCommand("DOM.enable")
        await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true })
      } catch {
        cdpReady = false
      }
    }
    return dbg
  }
  const answerDialogNow = async (accept: boolean, text?: string) => {
    const dbg = await cdp()
    if (!dbg || !dialogNow) return false
    clearTimeout(dialogTimer)
    dialogNow = null
    await dbg.sendCommand("Page.handleJavaScriptDialog", {
      accept,
      ...(text !== undefined ? { promptText: text } : {}),
    })
    return true
  }
  /** What the debugger tells: a dialog opens or closes, a file chooser opens. */
  const onCdp = (_: unknown, method: string, params: Record<string, unknown>) => {
    if (method === "Page.javascriptDialogOpening") {
      const kind = String(params.type)
      dialogNow = {
        kind: kind === "alert" || kind === "confirm" || kind === "prompt" ? kind : "beforeunload",
        text: String(params.message ?? ""),
      }
      clearTimeout(dialogTimer)
      // A dialog that nobody answers in time is dismissed, and the node is told (spec 007).
      dialogTimer = setTimeout(() => {
        const was = dialogNow
        void answerDialogNow(false).then((done) => {
          if (done && was) dismissed = was
        })
      }, dialogMs())
      for (const wake of dialogWaiters.splice(0)) wake()
    } else if (method === "Page.javascriptDialogClosed") {
      dialogNow = null
      clearTimeout(dialogTimer)
    } else if (method === "Runtime.exceptionThrown") {
      // A script error or a promise that nobody caught. The page cannot write this list.
      const details = (params.exceptionDetails ?? {}) as {
        text?: string
        exception?: { description?: string }
      }
      const message = (details.exception?.description ?? details.text ?? "error").split("\n")[0]
      if (pageErrors.length < 20) pageErrors.push(String(message).slice(0, 200))
    } else if (method === "Page.fileChooserOpened") {
      chooserNode = typeof params.backendNodeId === "number" ? params.backendNodeId : null
    }
  }
  const DIALOG = Symbol("dialog")
  /** An action that opens a dialog of the page returns at once: the page waits for the answer. */
  const withDialog = <T>(work: Promise<T>): Promise<T | typeof DIALOG> => {
    if (dialogNow) return Promise.resolve(DIALOG)
    return Promise.race([
      work,
      new Promise<typeof DIALOG>((resolve) => {
        dialogWaiters.push(() => resolve(DIALOG))
      }),
    ])
  }
  const FILE_CHOOSER_WAIT_MS = 80
  /** How much the page is drawn smaller than its own size, in the place that it has now. */
  let scaleNow = 1
  /**
   * The page has a document. A view that never loaded a page does not answer the debugger, and the
   * page that loads first would not get its size.
   */
  let started = false
  /** The scale that the page has been given, and the call that gives it. */
  let emulated: number | undefined
  let emulating: Promise<unknown> = Promise.resolve()
  /**
   * Gives the page its own size (`PAGE_VIEW`), whatever the size of its place. The place only
   * scales the picture, so a smaller window does not squeeze the layout of the page, what the
   * agent reads from it, or where a click lands. The page sees this size from its first script on
   * and after each load. The size belongs to a session of the debugger, so it is made again when
   * the session ends.
   */
  const emulate = (scale: number) => {
    if (!fixedLayout) return
    const v = live()
    if (!v || !started) return
    const session = v.webContents.debugger
    try {
      if (!session.isAttached()) {
        session.attach("1.3")
        emulated = undefined
      }
    } catch {
      return
    }
    if (emulated === scale) return
    emulated = scale
    emulating = session
      .sendCommand("Emulation.setDeviceMetricsOverride", {
        width: PAGE_VIEW.width,
        height: PAGE_VIEW.height,
        // 0 keeps the pixel density of the screen.
        deviceScaleFactor: 0,
        mobile: false,
        scale,
        // The view keeps the size that the app gives it.
        dontSetVisibleSize: true,
      })
      .catch(() => {
        if (emulated === scale) emulated = undefined
      })
  }
  /** The app screen, when the page sits in the main window. The shelf has none. */
  const screenOf = () =>
    host && host === mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : undefined
  /**
   * Puts a plain view where it belongs: exactly the place that the screen gives it, or parked
   * and hidden. The page is laid out in the size that the user sees, so a real click lands where
   * the page shows it, with no scale in between.
   */
  const applyPlain = (v: WebContentsView) => {
    const screenContents = screenOf()
    if (!bounds || !screenContents) {
      v.setBounds({ x: 0, y: 0, ...PAGE_VIEW })
      if (!sized) {
        v.setVisible(true)
        sized = true
      }
      v.setVisible(false)
      return
    }
    // The screen measures in CSS px. The window measures in px after the page zoom.
    const zoom = screenContents.getZoomFactor()
    sized = true
    v.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom)),
    })
    v.setVisible(true)
  }
  const apply = () => {
    const v = live()
    if (!v) return
    if (!fixedLayout) {
      applyPlain(v)
      return
    }
    const screenContents = screenOf()
    // The screen measures in CSS px. The window measures in px after the page zoom.
    const zoom = screenContents?.getZoomFactor() ?? 1
    const fit =
      bounds && screenContents
        ? fitPage({
            x: bounds.x * zoom,
            y: bounds.y * zoom,
            width: bounds.width * zoom,
            height: bounds.height * zoom,
          })
        : undefined
    // The page has its size, shown or hidden. Only the scale follows the place.
    if (fit) scaleNow = Math.round(fit.scale * 10_000) / 10_000
    emulate(scaleNow)
    if (!fit) {
      // A page that nobody sees keeps the size of a normal window, so it lays out the same way.
      // A view that was never visible reports a size of 0 by 0 whatever its bounds are, so it is
      // visible for one turn of the loop before it hides, and no frame draws in between.
      v.setBounds({ x: 0, y: 0, ...PAGE_VIEW })
      if (!sized) {
        v.setVisible(true)
        sized = true
      }
      v.setVisible(false)
      return
    }
    sized = true
    v.setBounds(fit.bounds)
    v.setVisible(true)
  }
  /**
   * The page of an agent never keeps the keyboard focus from the chat while the user does not hold
   * the controls (spec 007). A load, a new address or a link that opens in the page can take the
   * focus out of the message box. The focus then goes back to the app screen, so the box keeps
   * the focus and the text. While another program has the focus, nothing moves: the check runs
   * again when the window gets the focus. A test run never moves the system focus, so the window
   * must already have it.
   */
  const returnFocus = () => {
    const v = live()
    const screenContents = screenOf()
    if (!v || userInput || !host || host.isDestroyed() || !host.isFocused() || !screenContents)
      return
    if (v.webContents.isFocused()) screenContents.focus()
  }
  /** Waits one turn, so the move of the focus is over when the check runs. */
  const returnFocusSoon = () => {
    setImmediate(returnFocus)
  }
  /** Removes the page from the window and tells the listeners. Does nothing when it is gone. */
  const release = () => {
    const v = view
    if (!v) return
    view = undefined
    bounds = undefined
    trackShown()
    lastPlaceKey = ""
    diag.state("closed", {})
    scaleNow = 1
    started = false
    emulated = undefined
    userInput = false
    dialogNow = null
    dismissed = null
    clearTimeout(dialogTimer)
    chooserNode = null
    cdpReady = false
    pageErrors.length = 0
    for (const wake of dialogWaiters.splice(0)) wake()
    const h = host
    host = undefined
    if (h && !h.isDestroyed()) {
      h.removeListener("focus", returnFocusSoon)
      h.contentView.removeChildView(v)
      // The shelf has no use once its last page is gone.
      if (h === shelf && h.contentView.children.length === 0) h.destroy()
    }
    if (!v.webContents.isDestroyed()) v.webContents.close()
    for (const l of listeners) l()
  }
  /**
   * Moves the page to another window, hidden. The agent goes on with it. A page that the user
   * holds closes instead (see `rehomers`).
   */
  const rehome = (target: () => BaseWindow) => {
    const v = live()
    if (!v) return
    if (userInput) {
      release()
      return
    }
    const to = target()
    if (host === to || to.isDestroyed()) return
    const from = host
    if (from && !from.isDestroyed()) {
      from.removeListener("focus", returnFocusSoon)
      from.contentView.removeChildView(v)
    }
    bounds = undefined
    host = to
    to.on("focus", returnFocusSoon)
    to.contentView.addChildView(v)
    apply()
    if (from && from === shelf && !from.isDestroyed() && from.contentView.children.length === 0)
      from.destroy()
  }
  rehomers.set(agentId, rehome)
  /** The host of the last page that loaded: the report keeps it after the page closed. */
  let lastHost = ""
  /** How long the page had a place on the screen since it opened. The report needs it. */
  let shownMs = 0
  let shownSince: number | undefined
  const trackShown = () => {
    const shown = live() !== undefined && bounds !== undefined && bounds !== null
    if (shown && shownSince === undefined) shownSince = Date.now()
    else if (!shown && shownSince !== undefined) {
      shownMs += Date.now() - shownSince
      shownSince = undefined
    }
  }
  /** What the page declared about drag areas of the window, at the load with the most. */
  let pageDrag: PageDrag | null = null
  /** The last place that was logged, so the log holds a line for each change and no more. */
  let lastPlaceKey = ""
  const logPlace = () => {
    const v = live()
    const key = `${bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "hidden"}|${v?.getVisible()}`
    if (key === lastPlaceKey) return
    lastPlaceKey = key
    const now = v?.getBounds()
    diag.state("placed", {
      placed: bounds ?? null,
      view: now ?? null,
      visible: v?.getVisible() ?? null,
      zoom: screenOf()?.getZoomFactor() ?? null,
    })
  }
  screenPresses.set(agentId, (type, x, y) => {
    const v = live()
    if (!v?.getVisible()) return
    const b = v.getBounds()
    if (x < b.x || x >= b.x + b.width || y < b.y || y >= b.y + b.height) return
    if (type === "mouseDown") diag.screen({ x, y })
    else diag.screenMove()
  })
  snapshots.set(agentId, () => {
    const v = live()
    const stack = host && !host.isDestroyed() && v ? host.contentView.children : []
    const index = v ? stack.indexOf(v) : -1
    return {
      page: "agent",
      open: v !== undefined,
      plain: !fixedLayout,
      userInput,
      placed: bounds ? { ...bounds } : null,
      view: v ? v.getBounds() : null,
      visible: v ? v.getVisible() : null,
      zoom: screenOf()?.getZoomFactor() ?? null,
      inWindow: !host || host.isDestroyed() ? "none" : host === mainWindow ? "main" : "shelf",
      stackIndex: index >= 0 ? index : null,
      stackSize: index >= 0 ? stack.length : null,
      pageFocused: v ? v.webContents.isFocused() : null,
      windowFocused: host && !host.isDestroyed() ? host.isFocused() : null,
      loading: v ? v.webContents.isLoading() : null,
      host: v ? hostOf(v.webContents.getURL()) : lastHost,
      shownMs: shownMs + (shownSince === undefined ? 0 : Date.now() - shownSince),
      pageDrag,
      counts: diag.counts(),
    }
  })
  return {
    isOpen: () => live() !== undefined,
    open: async (url) => {
      let v = live()
      if (!v) {
        // With no main window the page opens on the shelf: the agent goes on, and nobody sees it.
        const h = hostWindow()
        // Set before the page exists: a session applies its user agent to new pages only. Sites
        // such as Teams turn away the `Electron/` token that Electron adds.
        const data = session.fromPartition(partitionOf(agentId))
        data.setUserAgent(pageUserAgent(data.getUserAgent(), app.getName()))
        guardSession(data)
        const created = new WebContentsView({
          webPreferences: {
            partition: partitionOf(agentId),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            // The agent goes on with the page while the user looks at another chat.
            backgroundThrottling: false,
          },
        })
        const wc = created.webContents
        // The rule for the addresses of this page: the session asks for it on each request.
        const wcId = wc.id
        pageRules.set(wcId, {
          policy: () => policy,
          blocked: (url) => {
            const host = hostOf(url)
            if (blocked.length < 50) blocked.push(host || url.slice(0, 40))
            options.log?.("address_blocked", { host })
          },
          download: (host) => options.log?.("download_refused", { host }),
          permit: (permission) => options.permit?.(permission) === true,
        })
        wc.debugger.on("message", onCdp)
        // A new document starts with no errors.
        wc.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument) pageErrors.length = 0
        })
        wc.on("did-finish-load", () => {
          lastHost = hostOf(wc.getURL())
          diag.state("loaded", { host: lastHost })
        })
        // A web page is never a handle of the window (see PAGE_NO_DRAG_CSS). The page is counted
        // first, so the report can say what it declared, then its drag areas are cancelled.
        wc.on("dom-ready", () => {
          void (async () => {
            try {
              const found = await wc.executeJavaScript(PAGE_DRAG_SCRIPT, true)
              if (found && typeof found === "object") {
                const next: PageDrag = {
                  host: hostOf(wc.getURL()),
                  drag: Number(found.drag) || 0,
                  noDrag: Number(found.noDrag) || 0,
                  scanned: Number(found.scanned) || 0,
                  total: Number(found.total) || 0,
                }
                if (next.drag > 0 || next.noDrag > 0) diag.state("page_drag_areas", { ...next })
                if (!pageDrag || next.drag > pageDrag.drag) pageDrag = next
              }
              await wc.insertCSS(PAGE_NO_DRAG_CSS, { cssOrigin: "user" })
            } catch {
              // A page that is gone, or that does not answer, has nothing to cancel.
            }
          })()
        })
        wc.setWindowOpenHandler(({ url: next }) => {
          if (/^https?:\/\//i.test(next)) wc.loadURL(next).catch(() => {})
          return { action: "deny" }
        })
        // The user's input reaches the page only while the user holds the controls. Keys with
        // Control, Command or Alt stay, so shortcuts of the app work. Wheel and move stay, so
        // the user can scroll and look.
        wc.on("before-input-event", (event, input) => {
          if (!userInput && !input.control && !input.meta && !input.alt) event.preventDefault()
        })
        wc.on("before-mouse-event", (event, mouse) => {
          const refused =
            !userInput &&
            (mouse.type === "mouseDown" || mouse.type === "mouseUp" || mouse.type === "contextMenu")
          // Every press is counted, kept out or not: the report tells a quiet window from a flag.
          diag.native(mouse.type, { x: mouse.x, y: mouse.y }, refused)
          if (refused) event.preventDefault()
        })
        // The document of the page tells what reached it: the other half of the count above.
        wc.ipc.on(PAGE_INPUT_CHANNEL, (_, payload: unknown) => {
          const note = cleanInputNote(payload)
          if (note) diag.page(note)
        })
        wc.on("did-fail-load", (_, code, __, url, isMainFrame) => {
          if (isMainFrame) diag.state("load_failed", { code, host: hostOf(url) })
        })
        wc.on("render-process-gone", (_, details) => {
          diag.state("page_process_gone", { reason: details.reason, exitCode: details.exitCode })
        })
        wc.on("unresponsive", () => diag.state("page_unresponsive", {}))
        wc.on("responsive", () => diag.state("page_responsive", {}))
        // The page takes the focus (a load, a new address, a link): the chat gets it back.
        wc.on("focus", returnFocusSoon)
        // The window gets the focus while the page holds it: the chat gets it back.
        h.on("focus", returnFocusSoon)
        // The session of the debugger ends (a tool of the page took it, or the page crashed): the
        // page gets its size again.
        wc.debugger.on("detach", () => {
          cdpReady = false
          emulated = undefined
          if (view === created && !wc.isDestroyed()) apply()
        })
        // The page can close itself.
        wc.once("destroyed", () => {
          pageRules.delete(wcId)
          if (view === created) release()
        })
        diag.reset()
        shownMs = 0
        shownSince = undefined
        pageDrag = null
        lastPlaceKey = ""
        created.setVisible(false)
        h.contentView.addChildView(created)
        view = created
        host = h
        v = created
        apply()
      }
      try {
        if (!started) {
          // An empty page first: from then on the view answers the debugger, and the page of the
          // address has its size before its first script runs. A plain view has no debugger, so
          // it loads the address at once.
          if (fixedLayout) {
            await v.webContents.loadURL("about:blank")
            emulate(scaleNow)
          }
          started = true
          await cdp()
        }
        // A debugger that does not answer must not keep the agent from the page.
        await Promise.race([emulating, new Promise((resolve) => setTimeout(resolve, 2_000))])
        // The agent gets the page when its document is ready, not at full load: text and
        // controls read from then on, while pictures and late scripts still load behind.
        await new Promise<void>((resolve, reject) => {
          const wc = v.webContents
          const before = wc.getURL()
          let settled = false
          const done = (error?: unknown) => {
            if (settled) return
            settled = true
            wc.removeListener("dom-ready", onReady)
            if (error === undefined) resolve()
            else reject(error)
          }
          // A late frame of the last page may still say it is ready: only a ready with the
          // new address, or the end of the load, opens the page.
          const onReady = () => {
            if (wc.getURL() !== before) done()
          }
          wc.on("dom-ready", onReady)
          try {
            wc.loadURL(url).then(
              () => done(),
              (error) => done(error),
            )
          } catch (error) {
            done(error)
          }
        })
      } finally {
        returnFocusSoon()
      }
      return { url: v.webContents.getURL(), title: v.webContents.getTitle() }
    },
    read: async () => {
      const wc = need()
      const seen = await runIsolated<PageReadAnswer>(pageReadScript(PAGE_TEXT_MAX))
      return {
        url: wc.getURL(),
        title: wc.getTitle(),
        text: seen.text,
        controls: seen.controls,
        total: seen.total,
      }
    },
    evaluate: <T>(code: string) => run<T>(code),
    currentUrl: () => live()?.webContents.getURL() ?? "",
    click: async (target, expect): Promise<BrowserAct> => {
      const running = runIsolated<PageActAnswer>(pageActScript("click", target, "", expect))
      const answer = await withDialog(running)
      returnFocusSoon()
      if (answer === DIALOG) {
        // The page waits for the answer to its dialog, so the script does not end yet.
        running.catch(() => {})
        return { ok: true, state: await actionState() }
      }
      if (!answer.ok) return answer as BrowserAct
      // A file chooser opens a moment after the click.
      await new Promise((resolve) => setTimeout(resolve, FILE_CHOOSER_WAIT_MS))
      return { ok: true, state: await actionState() }
    },
    type: async (target, text, expect): Promise<BrowserAct> => {
      const running = runIsolated<PageActAnswer>(pageActScript("type", target, text, expect))
      const answer = await withDialog(running)
      returnFocusSoon()
      if (answer === DIALOG) {
        running.catch(() => {})
        return { ok: true, state: await actionState() }
      }
      if (!answer.ok) return answer as BrowserAct
      return { ok: true, state: await actionState() }
    },
    inspect: async (target): Promise<BrowserInspect> => {
      const answer = await runIsolated<PageInspectAnswer>(pageInspectScript(target))
      if (answer.ok && answer.facts)
        return { ok: true, facts: answer.facts, formHost: answer.formHost ?? null }
      if (answer.reason === "many" && answer.candidates)
        return {
          ok: false,
          reason: "many",
          candidates: answer.candidates,
          total: answer.total ?? answer.candidates.length,
        }
      return { ok: false, reason: "none" }
    },
    select: async (target, value, expect): Promise<BrowserAct> => {
      const answer = await runIsolated<PageActAnswer>(pageSelectScript(target, value, expect))
      returnFocusSoon()
      if (!answer.ok) return answer as BrowserAct
      return { ok: true, state: await actionState() }
    },
    screenshot: async () => {
      const dbg = await cdp()
      if (dbg) {
        try {
          const shot = (await dbg.sendCommand("Page.captureScreenshot", { format: "png" })) as {
            data: string
          }
          return new Uint8Array(Buffer.from(shot.data, "base64"))
        } catch {
          // The debugger could not make it: the window makes it below.
        }
      }
      return new Uint8Array((await need().capturePage()).toPNG())
    },
    securePlace: async (): Promise<ControlPlace | null> => {
      const wc = need()
      if (await runIsolated<boolean>(pageSecureScript())) return { kind: "page" }
      // A frame of another site can hold the field (spec 007, "Secure fields in frames").
      for (const frame of wc.mainFrame.framesInSubtree) {
        if (frame === wc.mainFrame) continue
        try {
          if (await frame.executeJavaScript(pageSecureScript(), true)) {
            let site = frame.url
            try {
              site = new URL(frame.url).origin
            } catch {
              // The address of the frame is not an address: the card names it as it is.
            }
            return { kind: "frame", site }
          }
        } catch {
          // A frame that is gone or does not answer holds nothing to name.
        }
      }
      return null
    },
    dialog: () => dialogNow,
    answerDialog: async (accept, text) => {
      if (!(await answerDialogNow(accept, text))) return { ok: false }
      // The page goes on once the dialog is answered; its state is read after that.
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { ok: true, state: await actionState() }
    },
    chooserOpen: () => chooserNode !== null,
    upload: async (paths) => {
      const node = chooserNode
      const dbg = await cdp()
      if (node === null || !dbg) return { ok: false, reason: "no_chooser" }
      try {
        await dbg.sendCommand("DOM.setFileInputFiles", { files: paths, backendNodeId: node })
        chooserNode = null
        return { ok: true }
      } catch {
        return { ok: false, reason: "failed" }
      }
    },
    setPolicy: (next) => {
      policy = next
      if (next) {
        // A page with a rule for its addresses: its session turns strict, and a worker that an
        // older page left in it goes.
        const data = session.fromPartition(partitionOf(agentId))
        if (!strictSessions.has(data)) {
          strictSessions.add(data)
          void data.clearStorageData({ storages: ["serviceworkers"] }).catch(() => {})
        }
      }
    },
    drainBlocked: () => {
      const list = blocked
      blocked = []
      return list
    },
    audible: () => live()?.webContents.isCurrentlyAudible() ?? false,
    place: (next) => {
      bounds = next
      apply()
      logPlace()
      trackShown()
      // The report wants the drag areas of the screen over the place, also after the page is gone.
      if (next) noteBoxesSoon()
    },
    allowUserInput: (allowed) => {
      // The Teams link says this again on each place and each tick while its page shows, so a
      // page that was made again takes input: only a change moves the focus, never a repeat.
      if (allowed === userInput) return
      userInput = allowed
      diag.state("user_input", { allowed })
      // A test run never moves the system focus: this call makes the app the active program.
      // No test checks where the keys go.
      if (isTestRun) return
      // The keys go where the control is: into the page, or back to the chat.
      const v = live()
      if (allowed) v?.webContents.focus()
      else screenOf()?.focus()
    },
    close: release,
    onClosed: (l) => {
      listeners.push(l)
    },
  }
}

const lowMemoryListeners: (() => void)[] = []
let memoryTimer: ReturnType<typeof setInterval> | undefined
/**
 * Electron has no event for low memory. The app looks at the free memory of the system every 30
 * seconds, and a share under 3 % is low. On macOS the system keeps almost no memory free, because
 * it fills it with the file cache, so the look never says low there (docs/spec-questions.md, B9).
 */
const watchMemory = () => {
  if (memoryTimer || process.platform === "darwin") return
  memoryTimer = setInterval(() => {
    const info = process.getSystemMemoryInfo()
    if (info.total > 0 && info.free / info.total < 0.03) for (const l of lowMemoryListeners) l()
  }, 30_000)
  memoryTimer.unref()
}

export const electronPlatform = (): PlatformService => {
  /** The hold that keeps the computer from sleeping, while there is one (spec 013). */
  let awakeHold: number | undefined
  const dataDir = app.getPath("userData")
  mkdirSync(dataDir, { recursive: true })
  // Drop audit lines older than 90 days (spec 014, 023, 028). A prune that fails is dropped.
  pruneOldLogs(dataDir)
  watchApp()
  const pageOf = (agentId: string): BrowserPage => {
    const known = browsers.get(agentId)
    if (known) return known
    // The browser log (spec 014) gets the input that the page took or refused, and the changes of
    // its place. The line never holds the id of a workflow.
    const log: DiagWrite = (event, data) =>
      appendLog(dataDir, "browser", { event, page: "agent", ...data })
    const page = electronBrowser(agentId, { log })
    browsers.set(agentId, page)
    return page
  }
  const platformSetBrowserProfile = (agentId: string, profileId: string | undefined) => {
    const before = partitionOf(agentId)
    if (profileId === undefined) browserProfiles.delete(agentId)
    else browserProfiles.set(agentId, profileId)
    // The page that is open keeps the data it began with, so it closes. The next page of the
    // agent opens on the new data.
    if (partitionOf(agentId) !== before) browsers.get(agentId)?.close()
  }
  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    platform: process.platform,
    dataDir,
    defaultWorkspaceRoot: join(dataDir, "workspaces"),
    // A test run can name a home folder of its own. A real run always uses the home of the user.
    homeDir: isTestRun && process.env.ROBOT_TEST_HOME ? process.env.ROBOT_TEST_HOME : homedir(),
    resolveHost: testHosts() ?? systemResolver,
    systemLocale: () => process.env.ROBOT_SYSTEM_LOCALE ?? app.getLocale(),
    pickFolder: async (defaultPath) => {
      if (isTestRun && process.env.ROBOT_TEST_PICK_FOLDER) return process.env.ROBOT_TEST_PICK_FOLDER
      const parent = BrowserWindow.getFocusedWindow()
      const options = {
        defaultPath,
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? undefined : result.filePaths[0]
    },
    pickFiles: async () => {
      if (isTestRun && process.env.ROBOT_TEST_PICK_FILES)
        return JSON.parse(process.env.ROBOT_TEST_PICK_FILES) as string[]
      const options = {
        properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    },
    pickSavePath: async (defaultName) => {
      if (isTestRun && process.env.ROBOT_TEST_SAVE_PATH) return process.env.ROBOT_TEST_SAVE_PATH
      const options = {
        defaultPath: join(app.getPath("documents"), defaultName),
        filters: [{ name: dialogFilter("dialog.filter.export"), extensions: ["zip"] }],
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      return result.canceled ? undefined : result.filePath
    },
    pickArchive: async () => {
      if (isTestRun && process.env.ROBOT_TEST_OPEN_PATH) return process.env.ROBOT_TEST_OPEN_PATH
      const options = {
        filters: [{ name: dialogFilter("dialog.filter.export"), extensions: ["zip"] }],
        properties: ["openFile"] as "openFile"[],
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? undefined : result.filePaths[0]
    },
    pickWorkflowFileSave: async (defaultName) => {
      if (isTestRun && process.env.ROBOT_TEST_WORKFLOW_FILE_SAVE)
        return process.env.ROBOT_TEST_WORKFLOW_FILE_SAVE
      const options = {
        defaultPath: join(app.getPath("documents"), defaultName),
        filters: [{ name: dialogFilter("dialog.filter.workflows"), extensions: ["json"] }],
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      return result.canceled ? undefined : result.filePath
    },
    pickWorkflowFile: async () => {
      if (isTestRun && process.env.ROBOT_TEST_WORKFLOW_FILE_OPEN)
        return process.env.ROBOT_TEST_WORKFLOW_FILE_OPEN
      const options = {
        filters: [{ name: dialogFilter("dialog.filter.workflows"), extensions: ["json"] }],
        properties: ["openFile"] as "openFile"[],
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? undefined : result.filePaths[0]
    },
    openPath: async (path) => {
      // A folder that is not there yet is made. A file is opened as it is.
      if (!existsSync(path)) mkdirSync(path, { recursive: true })
      // Test runs open no window. A test that wants to see the path names a log file.
      if (isTestRun) {
        if (process.env.ROBOT_TEST_OPEN_LOG)
          appendFileSync(process.env.ROBOT_TEST_OPEN_LOG, `${path}\n`)
        return
      }
      await shell.openPath(path)
    },
    openFile: async (path) => {
      // A test run writes the path to a log: no program starts.
      if (isTestRun && process.env.ROBOT_TEST_OPEN_LOG) {
        appendFileSync(process.env.ROBOT_TEST_OPEN_LOG, `${path}\n`)
        return
      }
      const failure = await shell.openPath(path)
      if (failure) throw new Error(failure)
    },
    setKeepAwake: (on) => {
      if (on) {
        if (awakeHold === undefined || !powerSaveBlocker.isStarted(awakeHold))
          awakeHold = powerSaveBlocker.start("prevent-app-suspension")
      } else if (awakeHold !== undefined) {
        powerSaveBlocker.stop(awakeHold)
        awakeHold = undefined
      }
    },
    keepAwakeHeld: () => awakeHold !== undefined && powerSaveBlocker.isStarted(awakeHold),
    // A test run can say that the computer is on its battery, because a test cannot unplug it.
    onBattery: () =>
      isTestRun && process.env.ROBOT_TEST_ON_BATTERY
        ? process.env.ROBOT_TEST_ON_BATTERY === "1"
        : powerMonitor.isOnBatteryPower(),
    onPowerSource: (listener) => {
      powerMonitor.on("on-battery", listener)
      powerMonitor.on("on-ac", listener)
    },
    setStartAtLogin: (enabled) => {
      if (isTestRun || process.platform === "linux") return
      app.setLoginItemSettings({ openAtLogin: enabled })
    },
    setThemeSource: (theme) => {
      nativeTheme.themeSource = theme
    },
    copyText: (text) => clipboard.writeText(text),
    openExternal: async (url) => {
      // Test runs open no browser. A test that wants to see the address names a log file.
      if (isTestRun) {
        if (process.env.ROBOT_TEST_OPEN_LOG)
          appendFileSync(process.env.ROBOT_TEST_OPEN_LOG, `${url}\n`)
        return
      }
      await shell.openExternal(url)
    },
    trash: async (path) => {
      if (!existsSync(path)) return
      // Test runs keep the system trash clean: they move the folder inside the data folder.
      if (isTestRun) {
        const bin = join(dataDir, "test-trash")
        mkdirSync(bin, { recursive: true })
        renameSync(path, join(bin, `${Date.now()}-${basename(path)}`))
        return
      }
      await shell.trashItem(path)
    },
    isFocused: () => {
      // A test run shows its window without the focus, so the system focus tells nothing there.
      // The window counts as focused unless the test asks for the opposite.
      if (isTestRun) return !process.env.ROBOT_TEST_UNFOCUSED
      return mainWindow !== undefined && !mainWindow.isDestroyed() && mainWindow.isFocused()
    },
    notify: (notice, onClick) => {
      if (isTestRun) {
        // A test run never shows a system notification. A test that asks for a log gets one.
        if (process.env.ROBOT_TEST_NOTIFY_LOG)
          appendFileSync(process.env.ROBOT_TEST_NOTIFY_LOG, `${JSON.stringify(notice)}\n`)
        return
      }
      if (!Notification.isSupported()) return
      const n = new Notification(notice)
      n.on("click", onClick)
      n.show()
    },
    showWindow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (isTestRun) {
        // A test run never takes the focus from the user.
        mainWindow.showInactive()
        return
      }
      mainWindow.show()
      mainWindow.focus()
    },
    browser: pageOf,
    diagnosticReport: async () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
      // The screen measures the boxes of the native pages. A kind of page that has no box on the
      // screen now keeps the numbers of the last time that it had one.
      const fresh = await measureBoxes()
      const boxes = [
        ...fresh,
        ...lastBoxes.filter((known) => !fresh.some((box) => box.page === known.page)),
      ]
      const content = win?.webContents
      const text = buildReport({
        madeAt: new Date().toISOString(),
        app: {
          name: app.getName(),
          version: app.getVersion(),
          packaged: app.isPackaged,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          platform: process.platform,
          arch: osArch(),
          os: `${osType()} ${osRelease()}`,
          locale: app.getLocale(),
          upSeconds: Math.round(process.uptime()),
        },
        displays: screen.getAllDisplays().map((d) => ({
          scaleFactor: d.scaleFactor,
          size: d.size,
          workArea: d.workArea,
          rotation: d.rotation,
          internal: d.internal,
          touchSupport: d.touchSupport,
        })),
        window: win
          ? {
              bounds: win.getBounds(),
              content: win.getContentBounds(),
              focused: win.isFocused(),
              visible: win.isVisible(),
              minimized: win.isMinimized(),
              maximized: win.isMaximized(),
              fullScreen: win.isFullScreen(),
              zoomFactor: content?.getZoomFactor(),
              zoomLevel: content?.getZoomLevel(),
              views: win.contentView.children.length,
            }
          : null,
        // A process that is stuck or crowded explains a screen that takes no click.
        processes: app.getAppMetrics().map((m) => ({
          type: m.type,
          cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
          memoryMB: Math.round(m.memory.workingSetSize / 1024),
        })),
        boxes,
        // The screen of the app first, then the pages of the workflows.
        pages: [screenSnapshot(), ...[...snapshots.values()].map((snapshot) => snapshot())],
        // The app and browser tails explain a screen that takes no click; the rest are the
        // audit logs of spec 014 (workflows, outside programs, Teams link).
        logs: [
          { name: "app", lines: readLogTail(dataDir, "app", 100) },
          { name: "browser", lines: readLogTail(dataDir, "browser", 150) },
          { name: "workflows", lines: readLogTail(dataDir, "workflows", 100) },
          { name: "outside", lines: readLogTail(dataDir, "outside", 100) },
          { name: "teams", lines: readLogTail(dataDir, "teams", 100) },
        ],
      })
      // The text also stays on disk, in the logs folder, so it can be found again.
      const dir = join(dataDir, "logs")
      mkdirSync(dir, { recursive: true })
      const path = join(dir, "diagnostic-report.txt")
      writeFileSync(path, text)
      return { text, path }
    },
    setBrowserProfile: platformSetBrowserProfile,
    clearBrowserProfile: async (profileId) => {
      const data = session.fromPartition(`persist:browser-${profileId}`)
      await data.clearStorageData()
      await data.clearCache()
    },
    onLowMemory: (listener) => {
      lowMemoryListeners.push(listener)
      watchMemory()
    },
  }
}
