import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const rowOf = (scope: Locator | Page, name: string) =>
  scope.locator(`[data-place-row][data-place-name="${name}"]`)
const namesIn = (section: Locator) =>
  section.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("[data-place-row]")].map((row) => row.dataset.placeName),
  )

/** Takes a row with the mouse and drops it on the lower half of another row. */
const dropBelow = async (page: Page, row: Locator, target: Locator) => {
  await row.hover()
  await page.mouse.down()
  const box = await target.boundingBox()
  if (!box) throw new Error("no target")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8, { steps: 12 })
  await expect(target).toHaveAttribute("data-drop-edge", "after")
  await page.mouse.up()
}

test("pinned places and the order of places", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
  const unassigned = page.getByTestId("unassigned-section")
  const pinned = page.getByTestId("pinned-section")
  await expect.poll(() => namesIn(unassigned)).toEqual(["Ada", "Bo", "Cy"])
  await expect(pinned).toHaveCount(0)

  // Pin: the place shows in the group and not in its section.
  await rowOf(page, "Bo").click({ button: "right" })
  await page.getByTestId("place-pin").click()
  await expect.poll(() => namesIn(pinned)).toEqual(["Bo"])
  await expect.poll(() => namesIn(unassigned)).toEqual(["Ada", "Cy"])
  await rowOf(page, "Cy").click({ button: "right" })
  await page.getByTestId("place-pin").click()
  await expect.poll(() => namesIn(pinned)).toEqual(["Bo", "Cy"])
  await shot(page, "s147-01-pinned")

  // The first place of a list cannot move up, the last cannot move down.
  await rowOf(pinned, "Bo").click({ button: "right" })
  await expect(page.getByTestId("place-move-up")).toBeDisabled()
  await page.getByTestId("place-move-down").click()
  await expect.poll(() => namesIn(pinned)).toEqual(["Cy", "Bo"])
  // The order stays after a restart.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 900)
  await expect.poll(() => namesIn(page.getByTestId("pinned-section"))).toEqual(["Cy", "Bo"])

  // Drag: a row drops below another row of the same list. A line shows the spot.
  const group = page.getByTestId("pinned-section")
  await rowOf(group, "Bo").click()
  await dropBelow(page, rowOf(group, "Cy"), rowOf(group, "Bo"))
  await expect.poll(() => namesIn(group)).toEqual(["Bo", "Cy"])
  // A drag never opens the place.
  await expect(rowOf(group, "Cy")).not.toHaveAttribute("aria-current", "true")

  // The menu entries are off while the filter has a text.
  await page.getByTestId("place-search").fill("o")
  await rowOf(page, "Bo").click({ button: "right" })
  await expect(page.getByTestId("place-move-up")).toBeDisabled()
  await expect(page.getByTestId("place-move-down")).toBeDisabled()
  await page.keyboard.press("Escape")
  await page.getByTestId("place-search").fill("")

  // Unpin: the place goes back to its section, last.
  await rowOf(group, "Bo").click({ button: "right" })
  await page.getByTestId("place-unpin").click()
  await expect.poll(() => namesIn(page.getByTestId("unassigned-section"))).toEqual(["Ada", "Bo"])
  await app.close()
  await mock.close()
})
