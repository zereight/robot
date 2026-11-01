import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test"

const appDir = resolve(import.meta.dirname, "..")
export const shotsDir = resolve(appDir, "../../build/e2e/screenshots")

export interface Launched {
  readonly app: ElectronApplication
  readonly page: Page
  readonly userData: string
}

export const freshUserData = () => mkdtempSync(join(tmpdir(), "robot-e2e-"))

export const launch = async (
  userData = freshUserData(),
  env: Record<string, string> = {},
): Promise<Launched> => {
  // A parent shell can set ELECTRON_RUN_AS_NODE, which stops Electron from opening windows.
  const { ELECTRON_RUN_AS_NODE: _, ...base } = process.env
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...base,
      ROBOT_USER_DATA: userData,
      // Secrets go to a file next to the data folder, not inside it, like a keychain would.
      ROBOT_TEST_SECRETS: `${userData}-secrets.json`,
      ...env,
    } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  return { app, page, userData }
}

export const shot = async (page: Page, name: string) => {
  mkdirSync(shotsDir, { recursive: true })
  await page.screenshot({ path: join(shotsDir, `${name}.png`) })
}

/** Resizes the app window to an outer size in px. */
export const resizeWindow = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.setContentSize(size.width, size.height)
    },
    { width, height },
  )
