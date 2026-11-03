import { hostname } from "node:os"
import { join } from "node:path"
import { EVENT_CHANNEL } from "@robot/shared"
import { Effect, ManagedRuntime } from "effect"
import { app, BrowserWindow } from "electron"
import { appLayer } from "./layers.ts"
import { electronPlatform, isTestRun, setMainWindow } from "./platform-electron.ts"
import { registerRpc } from "./register-rpc.ts"
import { importLoginPath } from "./runtimes/login-path.ts"
import { Database } from "./services/Database.ts"
import { Notifier } from "./services/Notifier.ts"
import { Platform } from "./services/Platform.ts"
import { Secrets } from "./services/Secrets.ts"
import { SettingsStore } from "./services/Settings.ts"

// The data folder is "ROBot" in the system app data folder. Tests and portable runs can
// point the app at another folder.
app.setName("ROBot")
app.setPath("userData", process.env.ROBOT_USER_DATA ?? join(app.getPath("appData"), "ROBot"))
if (process.env.ROBOT_SYSTEM_LOCALE)
  app.commandLine.appendSwitch("lang", process.env.ROBOT_SYSTEM_LOCALE)

// An installed app starts from the desktop with a short PATH. The PATH of the login shell of the
// user has the folders of programs such as pi and node. It is read while the app starts, and a test
// run keeps its own PATH.
const loginPath = app.isPackaged && !isTestRun ? importLoginPath() : Promise.resolve()

/** The longest time that the app waits for its services to close before it quits anyway. */
const CLOSE_MS = 5_000

/**
 * Closes the services in order and waits for them. The database takes no more writes first, so
 * work that the quit cuts off does not record itself as stopped: a task that waits for the user
 * still waits at the next start (spec 005). The link server, the connections, the timers and the
 * database close before the app quits.
 */
const closeRuntime = async (runtime: ReturnType<typeof makeRuntime>) => {
  try {
    await runtime.runPromise(Database.use((db) => Effect.sync(() => db.freeze())))
  } catch (error) {
    console.error("close: freeze failed", error)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_MS)
  })
  try {
    await Promise.race([runtime.dispose(), late])
  } catch (error) {
    console.error("close: dispose failed", error)
  } finally {
    clearTimeout(timer)
  }
}

const broadcast = (event: string, payload: unknown, server?: string) => {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send(EVENT_CHANNEL, event, payload, server)
}

const makeRuntime = () =>
  ManagedRuntime.make(
    appLayer({
      platform: electronPlatform(),
      localServerName: hostname().replace(/\.local$/, ""),
      emit: broadcast,
      secrets: process.env.ROBOT_TEST_SECRETS
        ? Secrets.file(process.env.ROBOT_TEST_SECRETS)
        : Secrets.keychain,
      // Only a test run may send the decision model to another address (spec 013).
      ...(isTestRun && process.env.ROBOT_TEST_DECISION_URL
        ? { decisionUrl: process.env.ROBOT_TEST_DECISION_URL }
        : {}),
    }),
  )

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  setMainWindow(win)
  // A test run shows the window without the focus, so the test does not take it from the user.
  win.once("ready-to-show", () => (isTestRun ? win.showInactive() : win.show()))
  // The window never navigates away from the app and never opens other windows.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"))
  return win
}

app.whenReady().then(async () => {
  // A test run on macOS is a background program: no Dock icon and no place in Stage Manager.
  // So a window that opens does not move the windows of the user.
  if (isTestRun && process.platform === "darwin") app.setActivationPolicy("accessory")
  // A packaged app takes its icon from the bundle. In development the Dock would show the
  // Electron icon, so show the app mark instead.
  else if (!app.isPackaged && process.platform === "darwin")
    app.dock?.setIcon(join(app.getAppPath(), "resources/icon.png"))
  const runtime = makeRuntime()
  // Keep native menus and dialogs in the chosen theme.
  await runtime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsStore.use((s) => s.get)
      yield* Platform.use((p) => Effect.sync(() => p.setThemeSource(settings.theme)))
      // The first start guide is for new users. A data folder that already holds an agent or an
      // account, or a test run that asks to skip it, counts as done.
      if (!settings.firstRunDone) {
        const db = yield* Database
        const used =
          db.get("SELECT 1 FROM agent LIMIT 1") || db.get("SELECT 1 FROM provider_account LIMIT 1")
        if (used || process.env.ROBOT_SKIP_FIRST_RUN)
          yield* SettingsStore.use((s) => s.update({ firstRunDone: true }))
      }
    }),
  )
  await loginPath
  registerRpc(runtime)
  createWindow()
  await runtime.runPromise(Notifier.use((n) => Effect.sync(() => n.refresh())))
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // The quit waits for the services to close. `will-quit` is stopped once, the services close,
  // and then the app ends. (A second `app.quit()` does nothing after `will-quit` was stopped.)
  let closing = false
  app.on("will-quit", (event) => {
    event.preventDefault()
    if (closing) return
    closing = true
    // A late error of a socket or a timer must not open a dialog that stops the quit.
    process.on("uncaughtException", (error) => console.error("error while closing", error))
    void closeRuntime(runtime).finally(() => app.exit(0))
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
