// Measures a packaged build of the app as docs/performance.md says. Start it with
// "bun run perf -- run --label <label>", not on its own: that command finds the app and the folder.
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { type ElectronApplication, _electron as electron, type Page, test } from "@playwright/test"
import { median } from "@robot/shared"
import { connectMock, createAgent, mainPage } from "../e2e/harness.ts"
import { GOOD_KEY, MARKDOWN_REPLY, startMockProvider } from "../e2e/mock-provider.ts"
import {
  frameGaps,
  lateParts,
  type Measure,
  measureSizes,
  medianAndWorst,
  type PerfReport,
  percentile,
  reportMarkdown,
  safeLabel,
  worst,
} from "../scripts/perf-lib.ts"

const appDir = resolve(import.meta.dirname, "..")
const APP = process.env.ROBOT_E2E_APP ?? ""
const LABEL = safeLabel(process.env.ROBOT_PERF_LABEL ?? "run")
const SAMPLES = Math.max(1, Number(process.env.ROBOT_PERF_SAMPLES) || 5)
const OUT = process.env.ROBOT_PERF_OUT ?? resolve(appDir, "../../build/perf")
/** Messages in the chat that the launch opens: 50 questions and 50 replies. */
const MESSAGES = 100
const TYPING_KEYS = 20
const IDLE_SECONDS = 12
const LATE_MS = 100
/** The time to first reply of the task must match the time on the screen within this. */
const MATCH_MS = 100
/** Caches of the window engine. Cold launch clears them; warm launch keeps them. */
const ENGINE_CACHES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Shared Dictionary",
]
/** A window behind other windows still draws frames, so the numbers do not depend on the desk. */
const FLAGS = [
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
]

test("performance of the packaged app", async () => {
  test.setTimeout(20 * 60_000)
  if (!APP || !existsSync(APP)) throw new Error(`No packaged app at "${APP}".`)
  const mock = await startMockProvider()
  // A new data folder for this run, with nothing of the user in it.
  const userData = mkdtempSync(join(os.tmpdir(), "robot-perf-"))
  const env = {
    ROBOT_USER_DATA: userData,
    ROBOT_TEST_SECRETS: `${userData}-secrets.json`,
    ROBOT_SKIP_FIRST_RUN: "1",
    ROBOT_SYSTEM_LOCALE: "en-US",
  }
  const start = async () => {
    const { ELECTRON_RUN_AS_NODE: _, ...base } = process.env
    const app = await electron.launch({
      executablePath: APP,
      args: FLAGS,
      env: { ...base, ...env } as Record<string, string>,
    })
    return { app, page: await mainPage(app) }
  }

  // ---------------------------------------------------------------- the data folder
  {
    const { app, page } = await start()
    await connectMock(page, mock.openaiUrl, GOOD_KEY, "Fake")
    for (const name of ["Cy", "Bo", "Ada"]) await createAgent(page, name)
    // The chat of Ada is open, and stays the open place after a restart.
    await page.waitForTimeout(500)
    await app.close()
  }
  {
    const db = new DatabaseSync(join(userData, "robot.db"))
    const ada = db.prepare("SELECT id FROM agent WHERE name = 'Ada'").get() as { id: string }
    const insert = db.prepare(
      `INSERT INTO message (id, agent_id, author, parts, status, model, created_at, finished_at)
       VALUES (?, ?, ?, ?, 'done', ?, ?, ?)`,
    )
    const first = Date.now() - MESSAGES * 60_000
    for (let i = 0; i < MESSAGES; i++) {
      const user = i % 2 === 0
      const text = user
        ? `Question ${i / 2 + 1}: how does step ${i} of the plan work, and what can go wrong?`
        : `${MARKDOWN_REPLY}\n\nNote ${i}: \`step_${i}\` is done.`
      const at = first + i * 60_000
      insert.run(
        randomUUID(),
        ada.id,
        user ? "user" : "agent",
        JSON.stringify([{ kind: "text", text }]),
        user ? null : "mock-fast",
        at,
        user ? null : at + 2000,
      )
    }
    db.close()
  }

  // ---------------------------------------------------------------- launch
  const ready = (count: number) => {
    const list = document.querySelector("[data-testid=place-list]")
    const input = document.querySelector<HTMLTextAreaElement>("[data-testid=composer-input]")
    return (
      list !== null &&
      list.childElementCount > 0 &&
      document.querySelectorAll("[data-testid=message]").length >= count &&
      input !== null &&
      !input.disabled
    )
  }
  const launchOnce = async (cold: boolean, keepOpen: boolean) => {
    if (cold)
      for (const name of ENGINE_CACHES)
        rmSync(join(userData, name), { recursive: true, force: true })
    const t0 = performance.now()
    const launched = await start()
    await launched.page.waitForFunction(ready, MESSAGES, { polling: "raf", timeout: 60_000 })
    const ms = performance.now() - t0
    if (!keepOpen) await launched.app.close()
    return { ms, launched }
  }
  const cold: number[] = []
  const warm: number[] = []
  for (let i = 0; i < SAMPLES; i++) cold.push((await launchOnce(true, false)).ms)
  let app: ElectronApplication | undefined
  let page: Page | undefined
  for (let i = 0; i < SAMPLES; i++) {
    const last = i === SAMPLES - 1
    const { ms, launched } = await launchOnce(false, last)
    warm.push(ms)
    if (last) ({ app, page } = launched)
  }
  if (!app || !page) throw new Error("The app did not stay open.")
  await page.waitForTimeout(1000)

  // ---------------------------------------------------------------- settings
  const settingsDrawn: number[] = []
  const settingsSettled: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const pending = page.evaluate(
      () =>
        new Promise<[number, number]>((done) => {
          const afterPaint = () =>
            new Promise<number>((r) =>
              requestAnimationFrame(() => setTimeout(() => r(performance.now()), 0)),
            )
          document.addEventListener(
            "click",
            async (event) => {
              const start = event.timeStamp
              const content = () => document.querySelector("[data-testid=settings] section h1")
              while (!content()) await new Promise((r) => requestAnimationFrame(r))
              const drawn = (await afterPaint()) - start
              // The end of its motion: every animation with an end has finished.
              await Promise.all(
                document
                  .getAnimations()
                  .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
                  .map((a) => a.finished.catch(() => undefined)),
              )
              done([drawn, (await afterPaint()) - start])
            },
            { capture: true, once: true },
          )
        }),
    )
    await page.waitForTimeout(50)
    await page.getByTestId("open-settings").click()
    const [drawn, settled] = await pending
    settingsDrawn.push(drawn)
    settingsSettled.push(settled)
    await page.getByTestId("settings-close").click()
    await page.getByTestId("settings").waitFor({ state: "detached" })
    await page.waitForTimeout(300)
  }

  // ---------------------------------------------------------------- typing
  const composer = page.getByTestId("composer-input")
  await composer.click()
  await page.evaluate(() => {
    const w = window as unknown as { __typing: number[]; __stopTyping: () => void }
    w.__typing = []
    const input = document.querySelector("[data-testid=composer-input]") as HTMLElement
    const onKey = (event: KeyboardEvent) => {
      const start = event.timeStamp
      // The next drawn frame: the frame callback runs before the paint, the task after it.
      requestAnimationFrame(() => setTimeout(() => w.__typing.push(performance.now() - start), 0))
    }
    input.addEventListener("keydown", onKey, { capture: true })
    w.__stopTyping = () => input.removeEventListener("keydown", onKey, { capture: true })
  })
  for (let i = 0; i < TYPING_KEYS; i++) {
    await page.keyboard.press("a")
    await page.waitForTimeout(120)
  }
  const typing = await page.evaluate(() => {
    const w = window as unknown as { __typing: number[]; __stopTyping: () => void }
    w.__stopTyping()
    return w.__typing
  })
  await composer.fill("")

  // ---------------------------------------------------------------- idle
  await page.waitForTimeout(2000)
  const metrics = () =>
    (app as ElectronApplication).evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().reduce(
        (sum, m) => ({
          cpu: sum.cpu + m.cpu.percentCPUUsage,
          memoryKb: sum.memoryKb + m.memory.workingSetSize,
        }),
        { cpu: 0, memoryKb: 0 },
      ),
    )
  // The first reading of the CPU use starts its count, so it is left out.
  await metrics()
  const idleCpu: number[] = []
  const idleMemory: number[] = []
  for (let i = 0; i < IDLE_SECONDS; i++) {
    await page.waitForTimeout(1000)
    const m = await metrics()
    idleCpu.push(m.cpu)
    idleMemory.push(m.memoryKb / 1024)
  }

  // ---------------------------------------------------------------- streaming
  await page.evaluate(() => {
    const w = window as unknown as {
      __stream: { frames: number[]; drawn: Record<number, number>; running: boolean }
    }
    w.__stream = { frames: [], drawn: {}, running: true }
    const loop = () => {
      const s = w.__stream
      if (!s.running) return
      s.frames.push(performance.timeOrigin + performance.now())
      const messages = document.querySelectorAll("[data-testid=message]")
      const text = messages[messages.length - 1]?.textContent ?? ""
      for (const m of text.matchAll(/p(\d{3})\b/g)) {
        const index = Number(m[1])
        if (!(index in s.drawn)) s.drawn[index] = Date.now()
      }
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
  mock.sent.length = 0
  const before = await page.locator("[data-testid=message]").count()
  await composer.fill("stream parts")
  await composer.press("Enter")
  // The reply has ended when it is the last message and it is done.
  await page.waitForFunction(
    (count) => {
      const messages = document.querySelectorAll<HTMLElement>("[data-testid=message]")
      return (
        messages.length >= count + 2 && messages[messages.length - 1]?.dataset.status === "done"
      )
    },
    before,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(300)
  const stream = await page.evaluate(() => {
    const w = window as unknown as {
      __stream: { frames: number[]; drawn: Record<number, number>; running: boolean }
    }
    w.__stream.running = false
    return { frames: w.__stream.frames, drawn: w.__stream.drawn }
  })
  const sent = mock.sent.flatMap((s) => {
    const m = /^p(\d{3}) $/.exec(s.text)
    return m ? [{ index: Number(m[1]), at: s.at }] : []
  })
  const drawn = new Map(Object.entries(stream.drawn).map(([k, v]) => [Number(k), v]))
  const firstSent = Math.min(...sent.map((s) => s.at))
  const lastDrawn = Math.max(...drawn.values())
  const streamFrames = frameGaps(stream.frames.filter((at) => at >= firstSent && at <= lastDrawn))

  // ---------------------------------------------------------------- time to first reply
  const screenReply: number[] = []
  const taskReply: number[] = []
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("page-chats").click()
    await composer.waitFor()
    await page.evaluate(() => {
      const w = window as unknown as { __reply: { start: number; end: number } }
      w.__reply = { start: 0, end: 0 }
      const before = document.querySelectorAll("[data-testid=message]").length
      const input = document.querySelector("[data-testid=composer-input]") as HTMLElement
      input.addEventListener(
        "keydown",
        (event) => {
          w.__reply.start = Date.now() - (performance.now() - event.timeStamp)
        },
        { capture: true, once: true },
      )
      const loop = () => {
        const messages = document.querySelectorAll("[data-testid=message]")
        const last = messages[messages.length - 1]
        if (messages.length >= before + 2 && /Hello!/.test(last?.textContent ?? "")) {
          w.__reply.end = Date.now()
          return
        }
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })
    await composer.fill(`first reply ${i + 1} pause 500ms`)
    await composer.press("Enter")
    await page.waitForFunction(
      () => (window as unknown as { __reply: { end: number } }).__reply.end > 0,
      null,
      { timeout: 30_000 },
    )
    const reply = await page.evaluate(
      () => (window as unknown as { __reply: { start: number; end: number } }).__reply,
    )
    screenReply.push(reply.end - reply.start)
    await page
      .locator("[data-testid=message][data-status=streaming]")
      .waitFor({ state: "detached" })
    // The time that the task keeps, from its detail.
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("task-open").first().click()
    const ms = await page.getByTestId("task-time-first-reply").getAttribute("data-ms")
    taskReply.push(ms ? Number(ms) : Number.NaN)
    await page.keyboard.press("Escape")
  }
  await app.close()
  await mock.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(`${userData}-secrets.json`, { force: true })

  // ---------------------------------------------------------------- report
  const gaps = screenReply.map((s, i) => Math.abs(s - (taskReply[i] ?? Number.NaN)))
  const matches = gaps.every((g) => g <= MATCH_MS)
  const sizes = measureSizes(resolve(appDir, "out"))
  const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)
  const measures: Measure[] = [
    ...medianAndWorst("launch.cold", "Cold launch", "ms", cold),
    ...medianAndWorst("launch.warm", "Warm launch", "ms", warm),
    ...medianAndWorst("settings.drawn", "Settings, content drawn", "ms", settingsDrawn),
    ...medianAndWorst("settings.settled", "Settings, end of motion", "ms", settingsSettled),
    ...medianAndWorst("typing", "Typing, key to next frame", "ms", typing),
    ...medianAndWorst("idle.cpu", "Idle CPU, all processes", "%", idleCpu),
    ...medianAndWorst("idle.memory", "Idle memory, all processes", "MB", idleMemory),
    {
      id: "stream.frame.median",
      name: "Streaming, frame time, median",
      unit: "ms",
      value: r1(median(streamFrames)),
    },
    {
      id: "stream.frame.p95",
      name: "Streaming, frame time, 95th percentile",
      unit: "ms",
      value: r1(percentile(streamFrames, 95)),
    },
    {
      id: "stream.frame.worst",
      name: "Streaming, frame time, worst",
      unit: "ms",
      value: r1(worst(streamFrames)),
    },
    { id: "stream.parts", name: "Streaming, parts sent", unit: "count", value: sent.length },
    {
      id: "stream.late",
      name: `Streaming, parts drawn late (more than ${LATE_MS} ms)`,
      unit: "count",
      value: lateParts(sent, drawn, LATE_MS),
    },
    {
      id: "firstReply.screen",
      name: "Time to first reply, on the screen, median",
      unit: "ms",
      value: r1(median(screenReply)),
    },
    {
      id: "firstReply.task",
      name: "Time to first reply, from the task, median",
      unit: "ms",
      value: r1(median(taskReply)),
    },
    {
      id: "firstReply.gap",
      name: "Time to first reply, largest gap screen to task",
      unit: "ms",
      value: r1(worst(gaps)),
    },
    ...Object.entries(sizes).map(
      ([group, bytes]): Measure => ({
        id: `size.${group}`,
        name: `Size of the built files: ${group}`,
        unit: "bytes",
        value: bytes,
      }),
    ),
  ]
  const pkg = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf8")) as {
    version: string
  }
  const report: PerfReport = {
    format: 1,
    label: LABEL,
    createdAt: new Date().toISOString(),
    app: { version: pkg.version, path: APP },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    },
    notes: [
      `${SAMPLES} samples of each launch and of Settings; ${TYPING_KEYS} key presses; ${IDLE_SECONDS} idle samples, one each second.`,
      "Cold launch: the caches of the window engine (HTTP, code, GPU, Dawn and shader caches) are cleared before each start. The file cache of the system is not emptied.",
      "Warm launch: the app starts again after a full quit, with the caches kept.",
      `A launch counts from the start of the process to the frame where the place list, the chat of ${MESSAGES} messages and the message box are drawn. It includes the time that the test tool needs to connect.`,
      "The app runs with a new data folder made for this run, one account of a fake provider on this computer, and 3 agents. Nothing goes to the network.",
      "The app runs in its test mode: the window shows without the focus. The window engine does not slow down a window behind other windows.",
      `Streaming: the fake provider sends one part every 50 ms for 10 seconds. A part is late when it shows more than ${LATE_MS} ms after it was sent.`,
      `Time to first reply: the fake provider waits 500 ms. The time that the task keeps ${matches ? "matches" : "does NOT match"} the time on the screen within ${MATCH_MS} ms (3 messages).`,
      "Sizes are of the build in apps/desktop/out, which the packaged app holds. Source maps do not count.",
      "Times, CPU use and memory are for information. Only the sizes can fail CI.",
    ],
    measures,
    samples: {
      "launch.cold": cold,
      "launch.warm": warm,
      "settings.drawn": settingsDrawn,
      "settings.settled": settingsSettled,
      typing,
      "idle.cpu": idleCpu,
      "idle.memory": idleMemory,
      "stream.frames": streamFrames,
      "firstReply.screen": screenReply,
      "firstReply.task": taskReply,
    },
  }
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(OUT, `${LABEL}.md`), reportMarkdown(report))
  console.log(reportMarkdown(report))
})
