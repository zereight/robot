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

/** Connects a mock provider account in settings and closes settings. */
export const connectMock = async (page: Page, baseUrl: string, apiKey: string, name = "Mock") => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("openai")
  await page.getByTestId("provider-name").fill(name)
  await page.getByTestId("provider-base-url").fill(baseUrl)
  await page.getByTestId("provider-api-key").fill(apiKey)
  await page.getByTestId("provider-submit").click()
  await page.getByTestId("provider-status").last().waitFor()
  await page.getByTestId("settings-close").click()
}

/** Creates an agent with the first model of the first account. */
export const createAgent = async (page: Page, name: string) => {
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill(name)
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: name }).waitFor()
}
