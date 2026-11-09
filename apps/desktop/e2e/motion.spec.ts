import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot, startHangingRun } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Specs 039 and 000 (motion): one period for every spinner, one for every pulse, nothing else
// loops, and reduce motion stops the loops and leaves the marks in place.

test.setTimeout(90_000)

interface Looping {
  name: string
  duration: number
  easing: string
  visible: boolean
}

/** Every animation that never ends, as the page runs it now. */
const loops = (page: Page) =>
  page.evaluate((): Looping[] =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY)
      .map((a) => {
        const target = (a.effect as KeyframeEffect).target as HTMLElement | null
        const box = target?.getBoundingClientRect()
        return {
          name: a instanceof CSSAnimation ? a.animationName : "other",
          duration: Number(a.effect?.getComputedTiming().duration ?? 0),
          easing: a.effect?.getComputedTiming().easing ?? "",
          visible: Boolean(box && box.width > 0 && box.height > 0),
        }
      }),
  )

const setReduceMotion = (page: Page, value: "system" | "on" | "off") =>
  page.evaluate(async (reduceMotion) => {
    const invoke = (
      window as unknown as {
        robot: { invoke: (m: string, i?: unknown) => Promise<{ ok: boolean }> }
      }
    ).robot.invoke
    const result = await invoke("settings.update", { reduceMotion })
    if (!result.ok) throw new Error(JSON.stringify(result))
  }, value)

test("motion: spinners and pulses share one period, and reduce motion stills them", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
  })
  await resizeWindow(app, 1200, 800)
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("Looping")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()

  // One run works until the test ends. The canvas, the chat head and the run view all show it.
  await startHangingRun(page, { openaiUrl: mock.openaiUrl, key: GOOD_KEY })
  await expect(page.getByTestId("graph-node-running")).toBeVisible()
  const runningNode = page
    .getByTestId("graph-node")
    .filter({ has: page.getByTestId("graph-node-running") })
  const [box, name, spin] = await Promise.all([
    runningNode.boundingBox(),
    runningNode.locator("span[class*=nodeName]").boundingBox(),
    page.getByTestId("graph-node-running").boundingBox(),
  ])
  if (box === null || name === null || spin === null) throw new Error("no box for the running node")
  expect(spin.x, "spinner starts after the name ends").toBeGreaterThanOrEqual(name.x + name.width)
  expect(spin.x + spin.width, "spinner stays inside the node").toBeLessThanOrEqual(
    box.x + box.width,
  )
  expect(
    Math.abs(spin.y + spin.height / 2 - (name.y + name.height / 2)),
    "spinner is on the name line",
  ).toBeLessThan(2)
  // Every button centers its icon on its text line.
  for (const id of ["workflow-run", "workflow-stop"]) {
    const drift = await page.getByTestId(id).evaluate((el) => {
      const icon = el.querySelector("svg")
      const text = [...el.childNodes].find(
        (n): n is Text => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
      )
      if (!icon || !text) throw new Error("no icon or text in the button")
      const range = document.createRange()
      range.selectNodeContents(text)
      const a = icon.getBoundingClientRect()
      const b = range.getBoundingClientRect()
      return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2))
    })
    expect(drift, `${id} icon is on the text line`).toBeLessThan(1)
  }
  // The check label only truncates when the header is really out of room: never while the spacer
  // still holds free space.
  const headerRoom = await page.evaluate(() => {
    const label = document.querySelector('[data-testid="workflow-header-check"]') as HTMLElement
    const spacer = document.querySelector('[data-testid="workflow-header-spacer"]') as HTMLElement
    if (!label || !spacer) throw new Error("no check label or spacer in the header")
    return {
      cut: label.scrollWidth - label.clientWidth,
      free: spacer.getBoundingClientRect().width,
    }
  })
  expect(
    headerRoom.cut <= 1 || headerRoom.free < 2,
    "check label takes its natural width first",
  ).toBe(true)
  // Every toolbar button stays whole: the toolbar never scrolls.
  const toolbarCut = await page
    .getByTestId("graph-toolbar")
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(toolbarCut, "toolbar buttons fit without scrolling").toBeLessThanOrEqual(1)
  // The graph starts below the floating note.
  const note = await page.getByTestId("graph-readonly").boundingBox()
  if (note === null) throw new Error("no box for the floating note")
  expect(box.y, "graph starts below the floating note").toBeGreaterThanOrEqual(note.y + note.height)
  // At rest, the first line of the run strip body sits clear of its tabs.
  const [sHead, sBody] = await page.getByTestId("strip-body").evaluate((el) => {
    let first = el.firstElementChild
    while (first?.firstElementChild) first = first.firstElementChild
    return [el.getBoundingClientRect().top, first?.getBoundingClientRect().top ?? 0]
  })
  expect(sBody - sHead, "run strip body starts below its tabs with space").toBeGreaterThanOrEqual(8)
  await expect(page.getByTestId("chat-spinner")).toBeVisible()
  // The spinners have a text alternative, as the app shows the state in words (specs/039).
  await expect(page.getByTestId("chat-spinner")).toHaveText("Running")
  await expect(page.getByTestId("graph-node").first()).toHaveAttribute("aria-label", /Running/)
  // A chat turn that works shows the pulse of the working mark.
  await page.getByTestId("chat-input").fill("[[hang]]")
  await page.getByTestId("chat-input").press("Enter")
  await expect(page.getByTestId("working-line")).toBeVisible()
  await expect(page.getByTestId("working-line").getByTestId("work-mark")).toBeVisible()
  // One working line: the badge shows nowhere else, not even on the streaming row (spec 003).
  const streaming = page.getByTestId("message").last()
  await expect(streaming).toHaveAttribute("data-author", "assistant")
  await expect(streaming.getByTestId("work-mark")).toHaveCount(0)
  await page.getByTestId("runs-list").locator("button").first().click()
  await expect(page.getByTestId("run-node-state-1")).toHaveText("Running")
  await page.getByTestId("run-back").click()
  await page.getByTestId("tab-graph").click()
  await expect(page.getByTestId("graph-node-running")).toBeVisible()
  await shot(page, "motion-01-spinners", { moving: true })

  // The spinners on the canvas and in the chat turn with one period, with a steady speed.
  const spins = (await loops(page)).filter((l) => l.name.includes("spin"))
  expect(spins.length).toBeGreaterThanOrEqual(2)
  expect(new Set(spins.map((s) => s.duration)).size).toBe(1)
  expect(new Set(spins.map((s) => s.easing)).size).toBe(1)
  expect(spins[0]?.easing).toBe("linear")
  const spinPeriod = spins[0]?.duration ?? 0

  // The chat also shows the pulse of the working mark while the responsible document works. The
  // pulse is slower than the spinner, and no other motion loops.
  const everything = await loops(page)
  const pulses = everything.filter((l) => l.name.includes("pulse"))
  expect(pulses.length, "the chat working mark pulses").toBeGreaterThanOrEqual(1)
  for (const p of pulses) expect(p.duration).toBeGreaterThan(spinPeriod)
  expect(new Set(pulses.map((p) => p.duration)).size).toBeLessThanOrEqual(1)
  const strange = everything.filter((l) => !l.name.includes("spin") && !l.name.includes("pulse"))
  expect(strange, JSON.stringify(strange)).toEqual([])

  // Reduce motion on, with no restart: nothing loops, and each mark is still in its place.
  await page.evaluate(() => {
    ;(window as unknown as { __same: boolean }).__same = true
  })
  await setReduceMotion(page, "on")
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true")
  await expect.poll(() => loops(page)).toEqual([])
  await expect(page.getByTestId("graph-node-running")).toBeVisible()
  await expect(page.getByTestId("chat-spinner")).toBeVisible()
  await expect(page.getByTestId("working-line").getByTestId("work-mark")).toBeVisible()
  // The words stay with reduce motion on: the mark is still, and it still says "Running".
  await expect(page.getByTestId("chat-spinner")).toHaveText("Running")
  await expect(page.getByTestId("graph-node").first()).toHaveAttribute("aria-label", /Running/)
  await shot(page, "motion-02-still")

  // Off again: they move again, in the same window.
  await setReduceMotion(page, "off")
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "false")
  await expect
    .poll(async () => (await loops(page)).filter((l) => l.name.includes("spin")).length)
    .toBeGreaterThanOrEqual(2)
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)

  // "Follow the system": the system asks for less motion, so the marks stop. It works at once.
  await setReduceMotion(page, "system")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true")
  await expect.poll(() => loops(page)).toEqual([])
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "false")
  await expect.poll(async () => (await loops(page)).length).toBeGreaterThanOrEqual(2)

  await app.close()
  await mock.close()
})

test('motion: the spinners say "Running" in Korean too, with reduce motion on', async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "ko-KR",
  })
  await resizeWindow(app, 1200, 800)
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("반복")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
  await setReduceMotion(page, "on")
  await startHangingRun(page, { openaiUrl: mock.openaiUrl, key: GOOD_KEY })
  await expect(page.getByTestId("graph-node-running")).toBeVisible()
  await expect(page.getByTestId("chat-spinner")).toHaveText("실행 중")
  await expect(page.getByTestId("graph-node").first()).toHaveAttribute("aria-label", /실행 중/)
  await expect.poll(() => loops(page)).toEqual([])
  await app.close()
  await mock.close()
})

test("motion: a motion that ends takes under 300 ms, and a dialog leaves with an exit", async () => {
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
  })
  await resizeWindow(app, 1200, 800)
  await page.evaluate(() => {
    const seen: { name: string; duration: number; infinite: boolean }[] = []
    ;(window as unknown as { __motion: typeof seen }).__motion = seen
    const record = () => {
      for (const a of document.getAnimations()) {
        const timing = a.effect?.getComputedTiming()
        seen.push({
          name: a instanceof CSSAnimation ? a.animationName : "other",
          duration: Number(timing?.duration ?? 0),
          infinite: timing?.iterations === Number.POSITIVE_INFINITY,
        })
      }
    }
    window.addEventListener("animationstart", record, true)
    // The frames too, so that a slow runner which skips an event does not hide a short motion.
    const loop = () => {
      record()
      requestAnimationFrame(loop)
    }
    loop()
    // The exit lasts about 120 ms: the page watches for it, and keeps the most elements that were
    // closing at one time.
    const w = window as unknown as { __closing: number }
    w.__closing = 0
    new MutationObserver(() => {
      w.__closing = Math.max(w.__closing, document.querySelectorAll("[data-closing=true]").length)
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-closing"],
    })
  })
  await page.getByTestId("new-workflow-empty").click()
  const dialog = page.locator("[role=dialog]")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  const state = await page.evaluate(() => ({
    closing: (window as unknown as { __closing: number }).__closing,
    seen: (
      window as unknown as {
        __motion: { name: string; duration: number; infinite: boolean }[]
      }
    ).__motion,
  }))
  expect(state.closing).toBe(1)
  expect(state.seen.some((m) => m.name.includes("dialog-in"))).toBe(true)
  expect(state.seen.some((m) => m.name.includes("dialog-out"))).toBe(true)
  const tooLong = state.seen.filter((m) => !m.infinite && m.duration >= 300)
  expect(tooLong, JSON.stringify(tooLong.slice(0, 3))).toEqual([])

  // Reduce motion: the exit is at once, and no motion has a length.
  await setReduceMotion(page, "on")
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true")
  // A transition that started before the switch (for example the exit of the first dialog) may
  // still run for 120 ms. Wait for it to end, then count only what starts after the switch.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
  await page.evaluate(() => {
    ;(window as unknown as { __motion: unknown[] }).__motion.length = 0
  })
  await page.getByTestId("new-workflow-empty").click()
  await expect(page.locator("[role=dialog]")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator("[role=dialog]")).toHaveCount(0)
  const moving = await page.evaluate(() =>
    (window as unknown as { __motion: { duration: number }[] }).__motion.filter(
      (m) => m.duration > 0,
    ),
  )
  expect(moving, JSON.stringify(moving.slice(0, 3))).toEqual([])
  await app.close()
})
