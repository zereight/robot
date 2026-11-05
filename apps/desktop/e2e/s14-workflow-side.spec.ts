import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"

// The editor of a workflow uses the height of the window. The panel of a node and the runs stand
// in a column on its right, and the user sets the width of that column. The width stays after a
// restart (spec 010, 001).

const openEditor = async (page: Page) => {
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-new").click()
  await expect(page.getByTestId("wf-editor")).toBeVisible()
}

const boxOf = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`${testId} has no box`)
  return box
}

/** The width that the window layout holds now, as the main process keeps it. */
const savedWidth = (page: Page) =>
  page.evaluate(async () => {
    const result = await window.robot.invoke("ui.get", undefined, undefined)
    return result.ok ? (result.value as { workflowSideWidth: number }).workflowSideWidth : -1
  })

const columnWidth = async (page: Page) =>
  Number(await page.getByTestId("wf-resizer").getAttribute("aria-valuenow"))

test("workflow editor: it fills the window, the runs sit on the right, and the column width stays after a restart", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const first = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(first.app, 1500, 1000)
  await openEditor(first.page)

  // The canvas takes the height of the window. It was 420 px high at any size.
  const canvas = await boxOf(first.page, "wf-canvas")
  expect(canvas.height).toBeGreaterThan(600)

  // The panel and the runs share one column on the right of the canvas, the panel on top.
  // The editor can still be settling when it shows, and a box is read at one time and the next at
  // another. So the test waits until the two boxes line up, and does not read them in turn.
  await expect
    .poll(
      async () => {
        const p = await boxOf(first.page, "wf-panel")
        const h = await boxOf(first.page, "wf-history")
        return Math.abs(h.x - p.x)
      },
      { timeout: 5_000 },
    )
    .toBeLessThan(1)
  const panel = await boxOf(first.page, "wf-panel")
  const history = await boxOf(first.page, "wf-history")
  expect(panel.x).toBeGreaterThanOrEqual(canvas.x + canvas.width - 1)
  expect(history.y).toBeGreaterThan(panel.y + panel.height - 1)
  expect(panel.width).toBeCloseTo(340, -1)
  await shot(first.page, "workflow-side-default")

  // A drag of the handle to the left makes the column wider by as much.
  const handle = await boxOf(first.page, "wf-resizer")
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await first.page.mouse.move(x, y)
  await first.page.mouse.down()
  await first.page.mouse.move(x - 50, y, { steps: 4 })
  await first.page.mouse.move(x - 100, y, { steps: 4 })
  await first.page.mouse.up()
  await expect.poll(() => columnWidth(first.page)).toBe(440)
  expect((await boxOf(first.page, "wf-panel")).width).toBeCloseTo(440, -1)
  await shot(first.page, "workflow-side-wider")

  // The arrow keys move it by 20 px: left makes the column wider, right makes it narrower.
  await first.page.getByTestId("wf-resizer").focus()
  await first.page.keyboard.press("ArrowLeft")
  await expect.poll(() => columnWidth(first.page)).toBe(460)
  await first.page.keyboard.press("ArrowRight")
  await first.page.keyboard.press("ArrowRight")
  await expect.poll(() => columnWidth(first.page)).toBe(420)

  // A drag far past the edge stops at the limits: 240 px and 720 px.
  const edge = await boxOf(first.page, "wf-resizer")
  const ex = edge.x + edge.width / 2
  const ey = edge.y + edge.height / 2
  await first.page.mouse.move(ex, ey)
  await first.page.mouse.down()
  await first.page.mouse.move(ex + 600, ey, { steps: 6 })
  await first.page.mouse.up()
  await expect.poll(() => columnWidth(first.page)).toBe(240)
  const narrow = await boxOf(first.page, "wf-resizer")
  await first.page.mouse.move(narrow.x + narrow.width / 2, narrow.y + narrow.height / 2)
  await first.page.mouse.down()
  await first.page.mouse.move(narrow.x - 900, narrow.y + 20, { steps: 6 })
  await first.page.mouse.up()
  await expect.poll(() => columnWidth(first.page)).toBe(720)
  // The canvas keeps room, also with the widest column.
  expect((await boxOf(first.page, "wf-canvas")).width).toBeGreaterThanOrEqual(240)

  // Set a width to keep, and wait until the main process holds it before the app ends.
  await first.page.getByTestId("wf-resizer").focus()
  for (let i = 0; i < 20; i++) await first.page.keyboard.press("ArrowRight")
  await expect.poll(() => columnWidth(first.page)).toBe(320)
  await expect.poll(() => savedWidth(first.page)).toBe(320)
  await first.app.close()

  // After the start the column has the width that the user set, in English and in Korean.
  const second = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(second.app, 1500, 1000)
  await openEditor(second.page)
  await expect.poll(() => columnWidth(second.page)).toBe(320)
  expect((await boxOf(second.page, "wf-panel")).width).toBeCloseTo(320, -1)
  await expect(second.page.getByRole("separator", { name: "Resize side column" })).toBeVisible()
  await second.app.close()

  const korean = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(korean.app, 1500, 1000)
  await korean.page.getByTestId("page-workflows").click()
  await korean.page.getByTestId("wf-new").click()
  await expect(korean.page.getByTestId("wf-editor")).toBeVisible()
  await expect(korean.page.getByRole("separator", { name: "오른쪽 열 크기 조절" })).toBeVisible()
  expect(await columnWidth(korean.page)).toBe(320)
  await korean.app.close()
})

test("workflow editor: in a small window the column leaves room to the canvas", async () => {
  const first = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(first.app, 900, 700)
  await openEditor(first.page)
  // A wide column asked for in a small window is held back, so the canvas stays usable.
  await first.page.getByTestId("wf-resizer").focus()
  for (let i = 0; i < 30; i++) await first.page.keyboard.press("ArrowLeft")
  const canvas = await boxOf(first.page, "wf-canvas")
  expect(canvas.width).toBeGreaterThanOrEqual(230)
  const panel = await boxOf(first.page, "wf-panel")
  expect(panel.width).toBeGreaterThanOrEqual(240)
  await shot(first.page, "workflow-side-small-window")
  await first.app.close()
})
