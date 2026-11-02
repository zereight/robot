import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

interface Played {
  tag: string
  part: string | null
  duration: number
}

/** Records every motion that the app starts with the animate method, as the face reactions do. */
const recordAnimate = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __played: Played[] }
    w.__played = []
    const original = Element.prototype.animate
    Element.prototype.animate = function (this: Element, keyframes, options) {
      w.__played.push({
        tag: this.tagName.toLowerCase(),
        part: this.getAttribute("data-part"),
        duration: Number((options as KeyframeAnimationOptions).duration),
      })
      return original.call(this, keyframes, options)
    }
  })

const played = (page: Page) =>
  page.evaluate(() => (window as unknown as { __played: Played[] }).__played)

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

test("design: faces react once to the end of a reply, a failure and a new agent; not with reduce motion", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 860)
  await recordAnimate(page)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A new agent lands once and blinks.
  await expect
    .poll(async () => (await played(page)).some((p) => p.tag === "svg" && p.duration === 260))
    .toBe(true)

  // The end of a reply: a hop and a blink.
  await send(page, "hello")
  await expect(page.locator("[data-testid=message][data-author=agent]").first()).toContainText(
    "You said: hello",
  )
  await expect
    .poll(async () => (await played(page)).some((p) => p.tag === "svg" && p.duration === 160))
    .toBe(true)
  expect((await played(page)).some((p) => p.part === "eyes" && p.duration === 270)).toBe(true)

  // A failed reply: the face shakes its head once.
  await send(page, "fail once for the face")
  await expect(page.getByTestId("failed-row")).toBeVisible()
  await expect
    .poll(async () => (await played(page)).some((p) => p.tag === "svg" && p.duration === 240))
    .toBe(true)
  await shot(page, "s18-01-face-failed")

  // Every reaction ends by itself in under 300 ms.
  expect((await played(page)).every((p) => p.duration < 300)).toBe(true)

  // Reduce motion on: no face moves.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-reduce-motion").getByText("On", { exact: true }).click()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toHaveCount(0)
  await recordAnimate(page)
  await send(page, "again")
  await expect(page.locator("[data-testid=message][data-author=agent]").last()).toContainText(
    "You said: again",
  )
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
  expect(await played(page)).toEqual([])

  await app.close()
  await mock.close()
})

test("design: the choice thumb follows the checked option; the list edge resists and springs back", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 800)

  // The thumb sits under the checked option and moves when another option is chosen.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  const group = page.getByTestId("setting-theme")
  const thumb = group.locator("span[aria-hidden=true]")
  await expect(thumb).toHaveAttribute("data-ready", "true")
  const before = await thumb.getAttribute("style")
  await group.locator('label[data-value="light"]').click()
  await expect.poll(async () => thumb.getAttribute("style")).not.toBe(before)
  await shot(page, "s18-02-thumb-light")
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toHaveCount(0)

  // Past 400 px the edge follows the pointer with resistance: it shows a little more than 400,
  // never more than 28 px more, and the value stays 400.
  const resizer = page.getByTestId("place-list-resizer")
  const box = await resizer.boundingBox()
  if (!box) throw new Error("no resizer")
  const startX = box.x + box.width / 2
  const y = box.y + 200
  const widthOf = async () => (await page.getByTestId("place-list").boundingBox())?.width ?? 0
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(startX + 400, y, { steps: 5 })
  const stretched = await widthOf()
  expect(stretched).toBeGreaterThan(400)
  expect(stretched).toBeLessThanOrEqual(428.5)
  await expect(resizer).toHaveAttribute("aria-valuenow", "400")
  await page.mouse.up()
  await expect.poll(widthOf).toBe(400)

  await app.close()
})

test("design: the activity panel of a chat shows the running task, with its time and a stop", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const panel = page.getByTestId("agent-activity")
  await expect(panel).toContainText("Nothing is running.")

  // A running reply is a card with its label, state and a clock in figures of one width.
  await send(page, "please go slow")
  const card = page.getByTestId("activity-task")
  await expect(card).toBeVisible()
  await expect(card).toContainText("please go slow")
  await expect(card).toContainText("Running")
  await expect(card.locator("[class*=elapsed]")).toHaveText(/^\d+:\d{2}$/)
  await expect(card.locator("[class*=elapsed]")).toHaveCSS("font-variant-numeric", "tabular-nums")
  await shot(page, "s18-03-activity-running")

  // Stop on the card stops the reply. The card leaves and the empty line comes back.
  await page.getByTestId("activity-stop").click()
  await expect(page.locator("[data-testid=message][data-status=stopped]")).toHaveCount(1)
  await expect(card).toHaveCount(0)
  await expect(panel).toContainText("Nothing is running.")

  await app.close()
  await mock.close()
})
