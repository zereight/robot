import { writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { EVENT_CHANNEL, resolveLocale, translate } from "@robot/shared"
import { Effect, ManagedRuntime } from "effect"
import { app, BrowserWindow, dialog } from "electron"
import { appLayer } from "./layers.ts"
import { electronPlatform, isTestRun, setMainWindow } from "./platform-electron.ts"
import { registerRpc } from "./register-rpc.ts"
import { importLoginPath } from "./runtimes/login-path.ts"
import { Database } from "./services/Database.ts"
import { Host } from "./services/Host.ts"
import { Platform } from "./services/Platform.ts"
import { Secrets } from "./services/Secrets.ts"
import { SettingsStore } from "./services/Settings.ts"
import { describeStartFailure } from "./startup.ts"

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

/**
 * The host program: in the bundle of a packaged app, and the release build of `host/` in a
 * development or test run ("bun run build:host").
 */
const hostBinary = () =>
  app.isPackaged
    ? join(process.resourcesPath, "robot-host")
    : resolve(app.getAppPath(), "../../host/target/release/robot-host")

const hostCommand = (dataDir: string) => ({ command: hostBinary(), args: ["--data", dataDir] })

const makeRuntime = () => {
  const platform = electronPlatform()
  // One profile keeps one secrets file until profiles (022) land. Tests keep the plain file.
  const testSecrets = process.env.ROBOT_TEST_SECRETS
  const secretsSource = testSecrets
    ? { file: testSecrets }
    : { vault: { path: join(platform.dataDir, "secrets.vault"), profile: "default" } }
  return ManagedRuntime.make(
    appLayer({
      platform,
      host: Host.process(hostCommand(platform.dataDir)),
      localServerName: hostname().replace(/\.local$/, ""),
      emit: broadcast,
      secrets: Secrets.host(hostBinary(), secretsSource),
      // Only a test run may send the decision model to another address (spec 013).
      ...(isTestRun && process.env.ROBOT_TEST_DECISION_URL
        ? { decisionUrl: process.env.ROBOT_TEST_DECISION_URL }
        : {}),
      // Only a test run may name another host that takes the cache marker (spec 006).
      ...(isTestRun && process.env.ROBOT_TEST_CACHE_HOST
        ? { cacheHosts: [process.env.ROBOT_TEST_CACHE_HOST] }
        : {}),
    }),
  )
}

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
  const databaseFile = join(app.getPath("userData"), "robot.db")
  let runtime: ReturnType<typeof makeRuntime> | undefined
  try {
    runtime = makeRuntime()
    const started = runtime
    // Keep native menus and dialogs in the chosen theme. This is the first use of the database, so
    // a file that cannot be opened fails here, and a file from a newer version stays untouched.
    await started.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsStore.use((s) => s.get)
        yield* Platform.use((p) => Effect.sync(() => p.setThemeSource(settings.theme)))
        // The first start guide is for new users. A data folder that already holds a workflow or an
        // account, or a test run that asks to skip it, counts as done.
        if (!settings.firstRunDone) {
          const db = yield* Database
          const used =
            db.get("SELECT 1 FROM workflow LIMIT 1") ||
            db.get("SELECT 1 FROM provider_account LIMIT 1")
          if (used || process.env.ROBOT_SKIP_FIRST_RUN)
            yield* SettingsStore.use((s) => s.update({ firstRunDone: true }))
        }
      }),
    )
  } catch (error) {
    // The app must not stay alive with no window. It tells the user and quits.
    const problem = describeStartFailure(databaseFile, error)
    const locale = resolveLocale("system", process.env.ROBOT_SYSTEM_LOCALE ?? app.getLocale())
    const title = translate(locale, problem.title, problem.params)
    const message = translate(locale, problem.message, problem.params)
    console.error("start failed", error)
    // A test run cannot click a native dialog: it writes the text to a file instead.
    if (isTestRun && process.env.ROBOT_TEST_ERROR_FILE)
      writeFileSync(process.env.ROBOT_TEST_ERROR_FILE, JSON.stringify({ title, message }))
    else dialog.showErrorBox(title, message)
    // Close what opened, but do not wait for it for long. Then end the process.
    if (runtime) await closeRuntime(runtime).catch(() => undefined)
    app.exit(1)
    return
  }
  const live: ReturnType<typeof makeRuntime> = runtime
  await loginPath
  registerRpc(live)
  createWindow()
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
    void closeRuntime(live).finally(() => app.exit(0))
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
