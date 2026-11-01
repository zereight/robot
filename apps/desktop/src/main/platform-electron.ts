import { existsSync, mkdirSync, renameSync } from "node:fs"
import { basename, join } from "node:path"
import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron"
import type { PlatformService } from "./services/Platform.ts"

/** True when an end-to-end test runs the app. The app then leaves system settings alone. */
export const isTestRun = Boolean(process.env.ROBOT_USER_DATA)

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
  }
}
