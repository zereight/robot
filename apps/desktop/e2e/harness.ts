import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type ElectronApplication, _electron as electron, type Page } from "@playwright/test"

const appDir = resolve(import.meta.dirname, "..")
export const shotsDir = resolve(appDir, "../../build/e2e/screenshots")
export const videosDir = resolve(appDir, "../../build/e2e/videos")

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
  // ROBOT_E2E_APP points at a packaged app; without it the tests run the built sources.
  const packaged = process.env.ROBOT_E2E_APP
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged, args: [] } : { args: [appDir] }),
    env: {
      ...base,
      ROBOT_USER_DATA: userData,
      // Secrets go to a file next to the data folder, not inside it, like a keychain would.
      ROBOT_TEST_SECRETS: `${userData}-secrets.json`,
      // Tests skip the first start guide. A test of the guide sets this to an empty string.
      ROBOT_SKIP_FIRST_RUN: "1",
      ...env,
    } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  return { app, page, userData }
}

/** Saves a screenshot. Running motion is shown at its end unless `moving` keeps the frame as is. */
export const shot = async (page: Page, name: string, options: { moving?: boolean } = {}) => {
  mkdirSync(shotsDir, { recursive: true })
  await page.screenshot({
    path: join(shotsDir, `${name}.png`),
    animations: options.moving ? "allow" : "disabled",
  })
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

/**
 * Records the window with the Chrome DevTools screencast. `stop` writes `<name>.mp4` and
 * `<name>.gif` under build/e2e/videos when ffmpeg is on PATH; the frames stay otherwise.
 */
export const startRecording = async (page: Page, name: string) => {
  const framesDir = join(videosDir, `${name}-frames`)
  rmSync(framesDir, { recursive: true, force: true })
  mkdirSync(framesDir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const frames: { file: string; at: number }[] = []
  cdp.on("Page.screencastFrame", (frame) => {
    const file = join(framesDir, `${String(frames.length).padStart(5, "0")}.jpg`)
    writeFileSync(file, Buffer.from(frame.data, "base64"))
    frames.push({ file, at: frame.metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 })
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {})
    if (frames.length < 2) return
    // Each frame shows until the next one, so pauses keep their real length.
    const list = frames
      .map((f, i) => {
        const next = frames[i + 1]?.at ?? f.at + 0.5
        return `file '${f.file}'\nduration ${Math.max(0.001, next - f.at).toFixed(3)}`
      })
      .join("\n")
    const listFile = join(framesDir, "list.txt")
    writeFileSync(listFile, `${list}\nfile '${frames.at(-1)?.file}'\n`)
    const scale = "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    const mp4 = join(videosDir, `${name}.mp4`)
    const made = spawnSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-vf",
      `${scale},fps=30`,
      "-pix_fmt",
      "yuv420p",
      mp4,
    ])
    if (made.status !== 0) return
    spawnSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      mp4,
      "-vf",
      "fps=15,scale=900:-1:flags=lanczos",
      join(videosDir, `${name}.gif`),
    ])
    rmSync(framesDir, { recursive: true, force: true })
  }
}
