import { hostname } from "node:os"
import { join } from "node:path"
import { EVENT_CHANNEL } from "@robot/shared"
import { Effect, ManagedRuntime } from "effect"
import { app, BrowserWindow } from "electron"
import { appLayer } from "./layers.ts"
import { electronPlatform } from "./platform-electron.ts"
import { registerRpc } from "./rpc.ts"
import { Platform } from "./services/Platform.ts"
import { Secrets } from "./services/Secrets.ts"
import { SettingsStore } from "./services/Settings.ts"

// The data folder is "ROBot" in the system app data folder. Tests and portable runs can
// point the app at another folder.
app.setName("ROBot")
app.setPath("userData", process.env.ROBOT_USER_DATA ?? join(app.getPath("appData"), "ROBot"))
if (process.env.ROBOT_SYSTEM_LOCALE)
  app.commandLine.appendSwitch("lang", process.env.ROBOT_SYSTEM_LOCALE)

const broadcast = (event: string, payload: unknown) => {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send(EVENT_CHANNEL, event, payload)
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
  win.once("ready-to-show", () => win.show())
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
  const runtime = makeRuntime()
  // Keep native menus and dialogs in the chosen theme.
  await runtime.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsStore.use((s) => s.get)
      yield* Platform.use((p) => Effect.sync(() => p.setThemeSource(settings.theme)))
    }),
  )
  registerRpc(runtime)
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on("will-quit", () => {
    void runtime.dispose()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
