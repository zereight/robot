import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type ElectronApplication,
  _electron as electron,
  type Locator,
  type Page,
} from "@playwright/test"
import { freeNearbyPort } from "./ports.ts"

const appDir = resolve(import.meta.dirname, "..")
export const shotsDir = resolve(appDir, "../../build/e2e/screenshots")
export const videosDir = resolve(appDir, "../../build/e2e/videos")

export interface Launched {
  readonly app: ElectronApplication
  readonly page: Page
  readonly userData: string
}

let nearbyOfWorker: Promise<number> | undefined
/**
 * One port for the name service of the copies that this worker starts. Without it, a copy that
 * shows a pairing code speaks on the real port, and reaches other computers and other test runs.
 */
const nearbyPortOfWorker = () => {
  nearbyOfWorker ??= freeNearbyPort()
  return nearbyOfWorker
}

export const freshUserData = () => mkdtempSync(join(tmpdir(), "robot-e2e-"))

/**
 * The window of the app. A test run can also open the status island, and which of the two windows
 * Playwright reports first depends on the system, so the island page is skipped. The page of the
 * Teams link and the browser of an agent are web pages: the link can open its page at the start,
 * so a page with an address on the web is skipped too. Such a page is blank until its load starts,
 * so a blank page is skipped as well, and the next turn of the loop looks again. The app itself
 * loads from a file.
 */
export const mainPage = async (app: ElectronApplication): Promise<Page> => {
  const first = await app.firstWindow()
  for (let tries = 0; tries < 100; tries++) {
    for (const candidate of app.windows()) {
      await candidate.waitForLoadState("domcontentloaded")
      const url = candidate.url()
      if (!url.includes("island.html") && url !== "about:blank" && !/^https?:\/\//i.test(url))
        return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return first
}

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
      ROBOT_LINK_NEARBY_PORT: String(await nearbyPortOfWorker()),
      ...env,
    } as Record<string, string>,
  })
  const page = await mainPage(app)
  // macOS fits a new window into the free part of the screen, so on a small screen or beside a
  // Dock at the side it opens narrower than 1200 px and the layout changes (spec 001).
  await resizeWindow(app, 1200, 800)
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

/**
 * True when the button is filled with the colour of danger of the theme that is on (spec 000,
 * "Danger buttons"). A probe paints the token, because the browser gives the colour of a filled
 * background in a form that the token text does not always match.
 */
export const isDangerButton = (button: Locator) =>
  button.evaluate((el) => {
    const probe = document.createElement("div")
    probe.style.background = "var(--c-danger)"
    document.body.append(probe)
    const danger = getComputedStyle(probe).backgroundColor
    probe.remove()
    return getComputedStyle(el).backgroundColor === danger
  })

/**
 * Resizes the app window to a content size in px. The window starts hidden and shows when its page
 * is ready. A window that is resized before it shows is fitted to the screen at the moment it
 * shows, and it can end up smaller than asked. So this waits for the window to show first.
 */
export const resizeWindow = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(
    async ({ BrowserWindow }, size) => {
      // The island and browser windows are not the app window; it is the one that has the app title.
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "ROBot")
      if (!win) return
      if (!win.isVisible()) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000)
          win.once("show", () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      win.setContentSize(size.width, size.height)
    },
    { width, height },
  )

/**
 * Ends the app at once, as when the power goes. The number of the process that Playwright starts is
 * not always the number of the app: on Windows the app is a child of it, and a kill of the parent
 * leaves the app running with its connections open. So the app tells its own number.
 */
export const killAtOnce = async (app: ElectronApplication) => {
  const pid = await app.evaluate(() => process.pid)
  process.kill(pid, "SIGKILL")
}

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
  let recording = true
  cdp.on("Page.screencastFrame", (frame) => {
    // A frame can arrive after the stop, when the folder is gone already.
    if (!recording) return
    const file = join(framesDir, `${String(frames.length).padStart(5, "0")}.jpg`)
    writeFileSync(file, Buffer.from(frame.data, "base64"))
    frames.push({ file, at: frame.metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 })
  return async () => {
    recording = false
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

/** The page side of a call to the main process, for a test that needs data the screens cannot make. */
type Invoke = (method: string, input?: unknown) => Promise<{ ok: boolean; value?: unknown }>

export interface NodeSpec {
  readonly kind?: "text" | "decision" | "approval"
  readonly name: string
  readonly prompt?: string
  readonly permission?: string | null
  readonly continueOnFailure?: boolean
  /** A decision node: the labels of the options. */
  readonly options?: readonly string[]
  /** An approval node: the question. */
  readonly question?: string
}

export interface FlowSpec {
  readonly provider: { openaiUrl: string; key: string }
  /** The permission level of the workflow. The app starts at "Ask for risky steps". */
  readonly level?: string
  readonly nodes: readonly NodeSpec[]
  /** `[from, to, option]`: indexes into `nodes`; `option` is the index of the option of a decision node, or of the output (Approve, Reject) of an approval node. */
  readonly edges?: readonly (readonly [number, number, number?])[]
}

/**
 * Makes the nodes and connections of the first workflow of the open app, and the account of the
 * stand-in provider, with the same calls as the window. It returns the id of the workflow.
 */
export const buildFlow = async (page: Page, spec: FlowSpec) =>
  page.evaluate(async (spec) => {
    const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
    const call = async (method: string, input?: unknown) => {
      const result = await invoke(method, input)
      if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result)}`)
      return result.value as never
    }
    const servers = (await call("servers.list")) as { id: string; kind: string }[]
    const server = servers.find((s) => s.kind === "local")
    const flows = (await call("workflows.list", { serverId: server?.id })) as { id: string }[]
    const flow = flows[0]
    let accounts = (await call("providers.list")) as { id: string }[]
    if (accounts.length === 0) {
      await call("providers.connect", {
        kind: "openai",
        name: "Mock",
        baseUrl: spec.provider.openaiUrl,
        apiKey: spec.provider.key,
      })
      accounts = (await call("providers.list")) as { id: string }[]
    }
    if (spec.level) await call("workflows.setPermission", { id: flow?.id, level: spec.level })
    type Made = { id: string; options: { id: string }[] }
    const made: Made[] = []
    for (const [index, n] of spec.nodes.entries()) {
      const node = (await call("workflows.node.add", {
        workflowId: flow?.id,
        node: {
          kind: n.kind ?? "text",
          name: n.name,
          // The grid of the editor (GraphEditor `placeFor`), so that the nodes do not stack.
          x: 24 + (index % 4) * 216,
          y: 24 + Math.floor(index / 4) * 120,
          ...(n.kind === "decision"
            ? { question: "Which way?", threshold: 0.9, options: n.options ?? ["Yes", "No"] }
            : n.kind === "approval"
              ? { question: n.question ?? "Approve this run?" }
              : {
                  prompt: n.prompt ?? "",
                  accountId: accounts[0]?.id,
                  model: "mock-fast",
                  ...(n.permission !== undefined ? { permission: n.permission } : {}),
                  ...(n.continueOnFailure ? { continueOnFailure: true } : {}),
                }),
        },
      })) as Made
      made.push(node)
    }
    const outputs = ["approve", "reject"] as const
    for (const [from, to, option] of spec.edges ?? []) {
      const kind = spec.nodes[from]?.kind ?? "text"
      const optionId =
        kind === "decision" && option !== undefined
          ? (made[from]?.options[option]?.id ?? null)
          : null
      const output = kind === "approval" && option !== undefined ? (outputs[option] ?? null) : null
      await call("workflows.connect", {
        workflowId: flow?.id,
        from: made[from]?.id,
        to: made[to]?.id,
        optionId,
        output,
      })
    }
    return flow?.id ?? ""
  }, spec)

/** Starts a run through the same call as the Run button. */
export const startRunCall = async (page: Page, workflowId: string, trigger?: string) =>
  page.evaluate(
    async ({ workflowId, trigger }) => {
      const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
      const result = await invoke("runs.start", { workflowId, ...(trigger ? { trigger } : {}) })
      if (!result.ok) throw new Error(JSON.stringify(result))
      return (result.value as { id: string }).id
    },
    { workflowId, trigger },
  )

/**
 * Starts a real run that works until the test ends: one text node on the stand-in provider that
 * never answers (`[[hang]]`). The app has the account, the node and the run, as a user would make
 * them.
 */
export const startHangingRun = async (
  page: Page,
  provider: { openaiUrl: string; key: string },
  prompt = "[[hang]]",
) => {
  const workflowId = await buildFlow(page, { provider, nodes: [{ name: "Work", prompt }] })
  return startRunCall(page, workflowId)
}

/**
 * Selects a node of the canvas. An open node panel floats over the canvas and can hide the node
 * (spec 001), so the panel closes first, as a user does.
 */
export const selectNode = async (page: Page, node: Locator) => {
  if (await page.getByTestId("node-side").isVisible()) {
    await page.getByTestId("node-panel-close").click()
  }
  await node.click()
}
