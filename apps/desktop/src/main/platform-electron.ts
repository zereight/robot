import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { basename, join, join as joinPath } from "node:path"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Notification,
  nativeTheme,
  screen,
  shell,
} from "electron"
import type { BrowserPage, PlatformService } from "./services/Platform.ts"

/** True when an end-to-end test runs the app. The app then leaves system settings alone. */
export const isTestRun = Boolean(process.env.ROBOT_USER_DATA)

const PAGE_TEXT_MAX = 20_000

/** One window per agent. Its session is kept on disk, so logins stay between runs. */
const electronBrowser = (agentId: string): BrowserPage => {
  let win: BrowserWindow | undefined
  const listeners: (() => void)[] = []
  const live = () => (win && !win.isDestroyed() ? win : undefined)
  const need = () => {
    const w = live()
    if (!w) throw new Error("The browser is not open. Open a page first.")
    return w
  }
  const run = async <T>(code: string): Promise<T> =>
    need().webContents.executeJavaScript(code, true)
  return {
    isOpen: () => live() !== undefined,
    open: async (url) => {
      let w = live()
      if (!w) {
        w = new BrowserWindow({
          width: 1100,
          height: 800,
          title: "ROBot browser",
          webPreferences: {
            partition: `persist:agent-${agentId}`,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        })
        const created = w
        created.webContents.setWindowOpenHandler(({ url: next }) => {
          void created.loadURL(next)
          return { action: "deny" }
        })
        created.on("closed", () => {
          win = undefined
          for (const l of listeners) l()
        })
        win = created
      }
      await w.loadURL(url)
      return { url: w.webContents.getURL(), title: w.webContents.getTitle() }
    },
    read: async () => {
      const w = need()
      const text = await run<string>("document.body ? document.body.innerText : ''")
      return {
        url: w.webContents.getURL(),
        title: w.webContents.getTitle(),
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
    close: () => live()?.destroy(),
    onClosed: (l) => {
      listeners.push(l)
    },
  }
}

const browsers = new Map<string, BrowserPage>()

let mainWindow: BrowserWindow | undefined
/** The window that holds the app. Notifications and the island bring it to the front. */
export const setMainWindow = (win: BrowserWindow) => {
  mainWindow = win
}

const ISLAND_SIZE = { bar: { width: 230, height: 34 }, attention: { width: 460, height: 132 } }
let island: BrowserWindow | undefined

/**
 * The island is for macOS. A test run has no island unless the test asks for it, on any system,
 * so that an extra window does not change the focus in the other tests.
 */
const islandAllowed = () =>
  isTestRun ? Boolean(process.env.ROBOT_FORCE_ISLAND) : process.platform === "darwin"

const setIslandShape = (shape: "hidden" | "bar" | "attention") => {
  if (!islandAllowed()) return
  if (shape === "hidden") {
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
  }
  const { width, height } = ISLAND_SIZE[shape]
  const bounds = screen.getPrimaryDisplay().bounds
  island.setBounds({
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y,
    width,
    height,
  })
  island.showInactive()
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
    openPath: async (path) => {
      mkdirSync(path, { recursive: true })
      await shell.openPath(path)
    },
    setStartAtLogin: (enabled) => {
      if (isTestRun || process.platform === "linux") return
      app.setLoginItemSettings({ openAtLogin: enabled })
    },
    setThemeSource: (theme) => {
      nativeTheme.themeSource = theme
    },
    copyText: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
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
    isFocused: () =>
      !(isTestRun && process.env.ROBOT_TEST_UNFOCUSED) &&
      mainWindow !== undefined &&
      !mainWindow.isDestroyed() &&
      mainWindow.isFocused(),
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
      mainWindow.show()
      mainWindow.focus()
    },
    setIslandShape,
    browser: (agentId) => {
      const known = browsers.get(agentId)
      if (known) return known
      const page = electronBrowser(agentId)
      browsers.set(agentId, page)
      return page
    },
  }
}
