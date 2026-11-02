import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { basename, join, join as joinPath } from "node:path"
import type { IslandShape } from "@robot/shared"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Notification,
  nativeTheme,
  screen,
  shell,
  WebContentsView,
} from "electron"
import type { BrowserPage, PageBounds, PlatformService } from "./services/Platform.ts"

/** True when an end-to-end test runs the app. The app then leaves system settings alone. */
export const isTestRun = Boolean(process.env.ROBOT_USER_DATA)

const PAGE_TEXT_MAX = 20_000

const browsers = new Map<string, BrowserPage>()

let mainWindow: BrowserWindow | undefined
/**
 * The window that holds the app. Notifications and the island bring it to the front, and the
 * pages of the agent browsers show inside it.
 */
export const setMainWindow = (win: BrowserWindow) => {
  mainWindow = win
  // A page has no place to show once the window is gone. A new load of the app screen starts with
  // no place for any page: the screen gives the places again when it draws.
  win.once("closed", () => {
    for (const page of browsers.values()) page.close()
  })
  win.webContents.on("did-start-loading", () => {
    for (const page of browsers.values()) page.place(undefined)
  })
}

/**
 * One page per agent, inside the main window. Its session is kept on disk, so logins stay between
 * runs. The screen of the chat says where the page shows. Until it does, the page is hidden.
 */
const electronBrowser = (agentId: string): BrowserPage => {
  let view: WebContentsView | undefined
  let host: BrowserWindow | undefined
  let bounds: PageBounds | undefined
  let userInput = false
  const listeners: (() => void)[] = []
  const live = () => (view && !view.webContents.isDestroyed() ? view : undefined)
  const need = () => {
    const v = live()
    if (!v) throw new Error("The browser is not open. Open a page first.")
    return v.webContents
  }
  const run = async <T>(code: string): Promise<T> => need().executeJavaScript(code, true)
  const apply = () => {
    const v = live()
    if (!v) return
    if (!bounds || !host || host.isDestroyed()) {
      v.setVisible(false)
      return
    }
    // The screen measures in CSS px. The window measures in px after the page zoom.
    const zoom = host.webContents.getZoomFactor()
    v.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(0, Math.round(bounds.width * zoom)),
      height: Math.max(0, Math.round(bounds.height * zoom)),
    })
    v.setVisible(true)
  }
  /** Removes the page from the window and tells the listeners. Does nothing when it is gone. */
  const release = () => {
    const v = view
    if (!v) return
    view = undefined
    bounds = undefined
    userInput = false
    const h = host
    host = undefined
    if (h && !h.isDestroyed()) h.contentView.removeChildView(v)
    if (!v.webContents.isDestroyed()) v.webContents.close()
    for (const l of listeners) l()
  }
  return {
    isOpen: () => live() !== undefined,
    open: async (url) => {
      let v = live()
      if (!v) {
        const h = mainWindow
        if (!h || h.isDestroyed())
          throw new Error("The app window is not open, so the browser has no place to show.")
        const created = new WebContentsView({
          webPreferences: {
            partition: `persist:agent-${agentId}`,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            // The agent goes on with the page while the user looks at another chat.
            backgroundThrottling: false,
          },
        })
        const wc = created.webContents
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
      await v.webContents.loadURL(url)
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
      if (!found) throw new Error(`No element matches ${selector}`)
    },
    type: async (selector, text) => {
      const found = await run<boolean>(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
      )
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
      else if (host && !host.isDestroyed()) host.webContents.focus()
    },
    close: release,
    onClosed: (l) => {
      listeners.push(l)
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
    island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
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
  }
}
