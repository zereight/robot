import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, join as joinPath } from "node:path"
import {
  type IslandShape,
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
  screen,
  session,
  shell,
  WebContentsView,
} from "electron"
import type { BrowserPage, PageBounds, PlatformService } from "./services/Platform.ts"
import { type Resolver, systemResolver } from "./web/fetch.ts"
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
const electronBrowser = (agentId: string): BrowserPage => {
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
  const apply = () => {
    const v = live()
    if (!v) return
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
        wc.on("did-finish-load", () => reportPage(wc))
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
          if (
            !userInput &&
            (mouse.type === "mouseDown" || mouse.type === "mouseUp" || mouse.type === "contextMenu")
          )
            event.preventDefault()
        })
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
          // address has its size before its first script runs.
          await v.webContents.loadURL("about:blank")
          started = true
          emulate(scaleNow)
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
    },
    allowUserInput: (allowed) => {
      userInput = allowed
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
  const dataDir = app.getPath("userData")
  mkdirSync(dataDir, { recursive: true })
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
    browser: (agentId) => {
      const known = browsers.get(agentId)
      if (known) return known
      const page = electronBrowser(agentId)
      browsers.set(agentId, page)
      return page
    },
    setBrowserProfile: (agentId, profileId) => {
      const before = partitionOf(agentId)
      if (profileId === undefined) browserProfiles.delete(agentId)
      else browserProfiles.set(agentId, profileId)
      // The page that is open keeps the data it began with, so it closes. The next page of the
      // agent opens on the new data.
      if (partitionOf(agentId) !== before) browsers.get(agentId)?.close()
    },
    clearBrowserProfile: async (profileId) => {
      const data = session.fromPartition(`persist:browser-${profileId}`)
      await data.clearStorageData()
      await data.clearCache()
    },
  }
}
