import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir, arch as osArch, release as osRelease, type as osType } from "node:os"
import { basename, join, join as joinPath } from "node:path"
import {
  type IslandShape,
  PAGE_INPUT_CHANNEL,
  TEACH_CHANNEL,
  TEACH_ON_CHANNEL,
  type TeachEvent,
  teachEventOf,
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
import { appendLog, readLogTail } from "./services/logs.ts"
import type { BrowserPage, PageBounds, PlatformService } from "./services/Platform.ts"
import { createTeamsSurface, TEAMS_PAGE_KEY, type TeamsSurface } from "./teams/surface.ts"
import { type Resolver, systemResolver } from "./web/fetch.ts"
import {
  BOX_SCRIPT,
  type BoxMeasure,
  buildReport,
  cleanInputNote,
  createInputDiagnostics,
  type DiagWrite,
  type PageSnapshot,
} from "./web/pageDiagnostics.ts"
import { fitPage, PAGE_VIEW } from "./web/pageFit.ts"
import { pageUserAgent } from "./web/userAgent.ts"

/** True when an end-to-end test runs the app. The app then leaves system settings alone. */
export const isTestRun = Boolean(process.env.ROBOT_USER_DATA)

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

/** What each page says about itself for the diagnostic report. */
const snapshots = new Map<string, () => PageSnapshot>()
/**
 * Each page checks a press that the app screen got: did it land inside the place of the page? Then
 * the page is drawn there, but the system gave the press to the screen under it.
 */
const screenPresses = new Map<string, (x: number, y: number) => void>()

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
 * The window that holds the app. Notifications and the island bring it to the front, and the
 * pages of the agent browsers show inside it. On macOS the app goes on when the user closes the
 * window, and the agents go on with their pages: the pages wait on a window that nobody sees, and
 * come back to the next main window. Other systems quit with the window, so the pages close.
 */
export const setMainWindow = (win: BrowserWindow) => {
  mainWindow = win
  // Only counts: this never stops a press.
  win.webContents.on("before-mouse-event", (_, mouse) => {
    if (mouse.type !== "mouseDown") return
    for (const check of screenPresses.values()) check(mouse.x, mouse.y)
  })
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
  options: { fixedLayout?: boolean; log?: DiagWrite } = {},
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
  /** The recorder of "Teach a task" (spec 017), while it runs. */
  let recorder: ((event: TeachEvent) => void) | undefined
  /** Reports the page that shows now, when it is a web page. */
  const reportPage = (wc: Electron.WebContents) => {
    const url = wc.getURL()
    if (recorder && /^https?:\/\//i.test(url)) recorder({ kind: "page", url, title: wc.getTitle() })
  }
  const live = () => (view && !view.webContents.isDestroyed() ? view : undefined)
  const need = () => {
    const v = live()
    if (!v) throw new Error("The browser is not open. Open a page first.")
    return v.webContents
  }
  const run = async <T>(code: string): Promise<T> => need().executeJavaScript(code, true)
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
    lastPlaceKey = ""
    diag.state("closed", {})
    scaleNow = 1
    started = false
    emulated = undefined
    userInput = false
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
  screenPresses.set(agentId, (x, y) => {
    const v = live()
    if (!v?.getVisible()) return
    const b = v.getBounds()
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) diag.screen({ x, y })
  })
  snapshots.set(agentId, () => {
    const v = live()
    const stack = host && !host.isDestroyed() && v ? host.contentView.children : []
    const index = v ? stack.indexOf(v) : -1
    return {
      page: agentId === TEAMS_PAGE_KEY ? "teams" : "agent",
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
      host: v ? hostOf(v.webContents.getURL()) : "",
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
        const created = new WebContentsView({
          webPreferences: {
            partition: partitionOf(agentId),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            // The agent goes on with the page while the user looks at another chat.
            backgroundThrottling: false,
            // The recorder of "Teach a task". It runs in its own world: the page cannot reach it.
            preload: join(import.meta.dirname, "../preload/teach.cjs"),
          },
        })
        const wc = created.webContents
        // The recorder asks at each page whether the app records, and reports the steps of the
        // user. Only this page talks on these channels.
        wc.ipc.on(TEACH_ON_CHANNEL, (event) => {
          event.returnValue = recorder !== undefined
        })
        wc.ipc.on(TEACH_CHANNEL, (_, payload: unknown) => {
          const step = teachEventOf(payload)
          if (step && recorder) recorder(step)
        })
        wc.on("did-finish-load", () => {
          diag.state("loaded", { host: hostOf(wc.getURL()) })
          reportPage(wc)
        })
        wc.on("did-navigate-in-page", (_, __, isMainFrame) => {
          if (isMainFrame) reportPage(wc)
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
          emulated = undefined
          if (view === created && !wc.isDestroyed()) apply()
        })
        // The page can close itself.
        wc.once("destroyed", () => {
          if (view === created) release()
        })
        diag.reset()
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
        }
        // A debugger that does not answer must not keep the agent from the page.
        await Promise.race([emulating, new Promise((resolve) => setTimeout(resolve, 2_000))])
        await v.webContents.loadURL(url)
      } finally {
        returnFocusSoon()
      }
      return { url: v.webContents.getURL(), title: v.webContents.getTitle() }
    },
    read: async () => {
      const wc = need()
      const text = await run<string>("document.body ? document.body.innerText : ''")
      return {
        url: wc.getURL(),
        title: wc.getTitle(),
        text: text.slice(0, PAGE_TEXT_MAX),
      }
    },
    evaluate: <T>(code: string) => run<T>(code),
    click: async (selector) => {
      const found = await run<boolean>(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true })()`,
      )
      returnFocusSoon()
      if (!found) throw new Error(`No element matches ${selector}`)
    },
    type: async (selector, text) => {
      const found = await run<boolean>(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
      )
      returnFocusSoon()
      if (!found) throw new Error(`No element matches ${selector}`)
    },
    place: (next) => {
      bounds = next
      apply()
      logPlace()
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
    record: (listener) => {
      const starts = listener !== undefined && recorder === undefined
      recorder = listener
      const v = live()
      if (!v) return
      v.webContents.send(TEACH_ON_CHANNEL, listener !== undefined)
      // The page that shows when the recording starts is its first step.
      if (starts && !v.webContents.isLoading()) reportPage(v.webContents)
    },
  }
}

/**
 * The bar is wider than the camera notch, so the app mark and the faces sit in the two wings at
 * each side of it. The cards start below the notch. These sizes are where a shape starts. Then
 * the island page measures its content and the window takes that size.
 */
const ISLAND_SIZE: Record<Exclude<IslandShape, "hidden">, { width: number; height: number }> = {
  bar: { width: 340, height: 34 },
  attention: { width: 460, height: 204 },
  result: { width: 460, height: 132 },
}
/** The window never gets a size outside this, whatever the page asks for. */
const ISLAND_LIMIT = { width: [120, 640], height: [20, 560] } as const
/** A menu bar this tall or taller means that the screen has a camera notch. */
const NOTCH_MENU_BAR_MIN = 30
let island: BrowserWindow | undefined
let islandShapeNow: IslandShape = "hidden"

/**
 * The island is for macOS. A test run has no island unless the test asks for it, on any system,
 * so that an extra window does not change the focus in the other tests.
 */
const islandAllowed = () =>
  isTestRun ? Boolean(process.env.ROBOT_FORCE_ISLAND) : process.platform === "darwin"

/** Puts the island window at the top centre of the screen, with the size of its content. */
const placeIsland = (win: BrowserWindow, size: { width: number; height: number }) => {
  const display = screen.getPrimaryDisplay()
  const { bounds } = display
  // The menu bar of a screen with a camera notch is as tall as the notch. The island joins the
  // notch there. A screen without a notch keeps the island under the menu bar.
  const menuBar = display.workArea.y - bounds.y
  const notch = menuBar >= NOTCH_MENU_BAR_MIN ? menuBar : 0
  const next = {
    x: Math.round(bounds.x + (bounds.width - size.width) / 2),
    y: notch > 0 ? bounds.y : bounds.y + menuBar,
    width: size.width,
    height: Math.max(size.height, notch),
  }
  const now = win.getBounds()
  if (
    now.x !== next.x ||
    now.y !== next.y ||
    now.width !== next.width ||
    now.height !== next.height
  )
    win.setBounds(next)
}

const setIslandShape = (shape: IslandShape) => {
  if (!islandAllowed()) return
  if (shape === "hidden") {
    islandShapeNow = "hidden"
    island?.hide()
    return
  }
  if (!island || island.isDestroyed()) {
    island = new BrowserWindow({
      ...ISLAND_SIZE[shape],
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      show: false,
      // Without this, macOS moves the window down, under the menu bar and the camera notch.
      enableLargerThanScreen: true,
      title: "ROBot island",
      webPreferences: {
        preload: joinPath(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    island.setAlwaysOnTop(true, "screen-saver")
    // By default this call turns the app into a background program on macOS. The app then loses
    // its Dock icon and its place in the app switcher, and the user cannot quit it from the Dock.
    island.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) void island.loadURL(`${devUrl}/island.html`)
    else void island.loadFile(joinPath(import.meta.dirname, "../renderer/island.html"))
    islandShapeNow = "hidden"
  }
  // A new shape starts at its own size. The page then fits the window to its content.
  if (shape !== islandShapeNow) placeIsland(island, ISLAND_SIZE[shape])
  islandShapeNow = shape
  island.showInactive()
}

const fitIsland = (size: { width: number; height: number }) => {
  if (!island || island.isDestroyed() || islandShapeNow === "hidden") return
  const clamp = (value: number, [min, max]: readonly [number, number]) =>
    Math.min(max, Math.max(min, Math.ceil(Number.isFinite(value) ? value : min)))
  placeIsland(island, {
    width: clamp(size.width, ISLAND_LIMIT.width),
    height: clamp(size.height, ISLAND_LIMIT.height),
  })
}

export const electronPlatform = (): PlatformService => {
  /** The hold that keeps the computer from sleeping, while there is one (spec 013). */
  let awakeHold: number | undefined
  const dataDir = app.getPath("userData")
  mkdirSync(dataDir, { recursive: true })
  let teamsSurface: TeamsSurface | undefined
  const pageOf = (agentId: string): BrowserPage => {
    const known = browsers.get(agentId)
    if (known) return known
    // The Teams page is for the hands of the user (spec 028): it fills its place exactly, with
    // no fixed layout and no scale, so a click lands where the page shows. An agent keeps the
    // fixed layout, so its place never changes what the agent reads or where a click lands.
    const isTeams = agentId === TEAMS_PAGE_KEY
    // The browser log (spec 014) gets the input that the page took or refused, and the changes of
    // its place. The line says "teams" or "agent", never the id of an agent.
    const log: DiagWrite = (event, data) =>
      appendLog(dataDir, "browser", { event, page: isTeams ? "teams" : "agent", ...data })
    const page = electronBrowser(agentId, isTeams ? { fixedLayout: false, log } : { log })
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
        filters: [{ name: "ROBot export", extensions: ["zip"] }],
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
        filters: [{ name: "ROBot export", extensions: ["zip"] }],
        properties: ["openFile"] as "openFile"[],
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? undefined : result.filePaths[0]
    },
    pickAgentFileSave: async (defaultName) => {
      if (isTestRun && process.env.ROBOT_TEST_AGENT_FILE_SAVE)
        return process.env.ROBOT_TEST_AGENT_FILE_SAVE
      const options = {
        defaultPath: join(app.getPath("documents"), defaultName),
        filters: [{ name: "ROBot agents", extensions: ["json"] }],
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      return result.canceled ? undefined : result.filePath
    },
    pickAgentFile: async () => {
      if (isTestRun && process.env.ROBOT_TEST_AGENT_FILE_OPEN)
        return process.env.ROBOT_TEST_AGENT_FILE_OPEN
      const options = {
        filters: [{ name: "ROBot agents", extensions: ["json"] }],
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
        filters: [{ name: "ROBot workflows", extensions: ["json"] }],
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
        filters: [{ name: "ROBot workflows", extensions: ["json"] }],
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
    setIslandShape,
    fitIsland,
    browser: pageOf,
    teams: () => {
      // The Teams page is a page like the browser of an agent, with a key that no agent has.
      // A test run can load a stand-in site on this computer in place of Teams, and never reaches
      // the real Teams.
      const url = isTestRun ? process.env.ROBOT_TEST_TEAMS_URL : undefined
      teamsSurface ??= createTeamsSurface(pageOf(TEAMS_PAGE_KEY), url ? { url } : {})
      return teamsSurface
    },
    setTeamsProfile: (profileId) => platformSetBrowserProfile(TEAMS_PAGE_KEY, profileId),
    diagnosticReport: async () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
      // The screen measures the box of the Teams page. A screen that does not answer must not stop
      // the report.
      const box = win
        ? await Promise.race([
            win.webContents
              .executeJavaScript(BOX_SCRIPT, true)
              .catch(() => null) as Promise<BoxMeasure | null>,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
          ])
        : null
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
        box,
        // The Teams page first: it is the one that the report is about.
        pages: [...snapshots.values()]
          .map((snapshot) => snapshot())
          .sort((a, b) => Number(b.page === "teams") - Number(a.page === "teams")),
        logs: [
          { name: "teams", lines: readLogTail(dataDir, "teams", 60) },
          { name: "browser", lines: readLogTail(dataDir, "browser", 150) },
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
  }
}
