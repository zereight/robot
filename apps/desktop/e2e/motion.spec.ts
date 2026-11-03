import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shot,
  startRecording,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

interface Seen {
  name: string
  duration: number
  infinite: boolean
}

/**
 * Records every animation and transition that starts, from inside the page. The start events are
 * heard as well as the frames, so a slow runner that skips frames does not hide a short motion.
 */
const watchMotion = (page: Page) =>
  page.evaluate(() => {
    const seen: Seen[] = []
    ;(window as unknown as { __motion: Seen[] }).__motion = seen
    const record = () => {
      for (const a of document.getAnimations()) {
        const timing = a.effect?.getComputedTiming()
        const name =
          a instanceof CSSAnimation
            ? a.animationName
            : a instanceof CSSTransition
              ? a.transitionProperty
              : "other"
        seen.push({
          name,
          duration: Number(timing?.duration ?? 0),
          infinite: timing?.iterations === Number.POSITIVE_INFINITY,
        })
      }
    }
    const loop = () => {
      record()
      requestAnimationFrame(loop)
    }
    window.addEventListener("animationstart", record, true)
    window.addEventListener("transitionrun", record, true)
    loop()
  })

const seenMotion = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motion: Seen[] }).__motion)

/** Freezes every running animation at a share of its length, for a still frame. */
const freezeAt = (page: Page, share: number) =>
  page.evaluate((s) => {
    for (const a of document.getAnimations()) {
      const d = Number(a.effect?.getComputedTiming().duration ?? 0)
      a.pause()
      a.currentTime = d * s
    }
  }, share)

const sendMessage = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

test("motion: short, calm, and off with reduce motion", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await watchMotion(page)
  const stopRecording = await startRecording(page, "motion-tour")

  // A dialog fades and rises in; three still frames show the motion.
  await page.getByTestId("new-agent").click()
  const dialog = page.getByTestId("agent-form").locator("xpath=ancestor::div[@role='dialog']")
  await expect(dialog).toBeVisible()
  // Opened again during the previous exit, the form is fresh.
  await expect(page.getByTestId("agent-name")).toHaveValue("")
  await freezeAt(page, 0.1)
  await shot(page, "motion-01-dialog-10", { moving: true })
  await freezeAt(page, 0.5)
  await shot(page, "motion-02-dialog-50", { moving: true })
  await page.evaluate(() => {
    for (const a of document.getAnimations()) a.finish()
  })
  await shot(page, "motion-03-dialog-100")

  // Escape plays a short exit, then removes the dialog.
  await page.keyboard.press("Escape")
  await expect(page.locator("[data-closing=true]")).toHaveCount(1)
  await expect(page.locator("[role=dialog]")).toHaveCount(0)

  // A new message comes in part by part (face, then words); the working badge opens its eyes and its glow pulses quietly.
  await sendMessage(page, "please go slow")
  const row = page.locator("[data-testid=message][data-enter=true]").first()
  await expect(row).toBeVisible()
  await page.getByTestId("composer-stop").click()

  // The activity panel slides closed and open; a section folds and unfolds.
  await page.getByTestId("toggle-activity-panel").click()
  await expect(page.getByTestId("activity-panel")).toHaveCount(0)
  await page.getByTestId("toggle-activity-panel").click()
  await expect(page.getByTestId("activity-panel")).toBeVisible()
  await page.getByTestId("section-toggle-agents").click()
  await expect(page.locator("[data-place-row]")).toHaveCount(0)
  await page.getByTestId("section-toggle-agents").click()
  await expect(page.locator("[data-place-row]")).toHaveCount(1)

  // Settings open and close with a fade.
  await page.getByTestId("open-settings").click()
  await expect(page.getByTestId("settings")).toBeVisible()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toHaveCount(0)

  // Spec 000: every motion is under 300 ms. Only the "Working…" line loops (spec 003).
  const seen = await seenMotion(page)
  const names = new Set(seen.map((m) => m.name))
  for (const expected of [
    "dialog-in",
    "dialog-out",
    "avatar-in",
    "row-in",
    "mark-in",
    "mark-open",
    "panel-out",
    "section-close",
  ]) {
    expect(
      [...names].some((n) => n.includes(expected)),
      expected,
    ).toBe(true)
  }
  const tooLong = seen.filter((m) => !m.infinite && m.duration >= 300)
  expect(tooLong, JSON.stringify(tooLong.slice(0, 3))).toEqual([])
  const loops = new Set(seen.filter((m) => m.infinite).map((m) => m.name))
  expect([...loops].every((n) => n.includes("pulse"))).toBe(true)

  // Reduce motion on: nothing moves and closing is immediate.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-reduce-motion").getByText("On", { exact: true }).click()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toHaveCount(0)
  await watchMotion(page)
  await page.getByTestId("new-agent").click()
  await expect(page.locator("[role=dialog]")).toBeVisible()
  await page.keyboard.press("Escape")
  expect(await page.locator("[data-closing=true]").count()).toBe(0)
  await sendMessage(page, "hello")
  await expect(page.locator("[data-testid=message][data-author=agent]").last()).toContainText(
    "You said: hello",
  )
  const moving = (await seenMotion(page)).filter((m) => m.duration > 0)
  expect(moving, JSON.stringify(moving.slice(0, 3))).toEqual([])

  await stopRecording()
  await app.close()
  await mock.close()
})
