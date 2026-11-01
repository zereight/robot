import { join } from "node:path"
import { app, BrowserWindow } from "electron"
import { registerRpc } from "./rpc.ts"

// Tests and portable runs can point the app at a separate data folder.
const userDataOverride = process.env.ROBOT_USER_DATA
if (userDataOverride) app.setPath("userData", userDataOverride)

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
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"))
  return win
}

app.whenReady().then(() => {
  registerRpc()
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
