import { expect, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"

const modKey = process.platform === "darwin" ? "Meta" : "Control"

test("layout: rail, place list, panel, width and sections survive a restart", async () => {
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 800)

  const tiles = page.getByTestId("server-tile")
  await expect(tiles).toHaveCount(1)
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("section-channels")).toContainText("No channels yet.")
  await expect(page.getByTestId("section-agents")).toContainText("No agents yet.")
  await expect(page.getByTestId("no-place")).toBeVisible()
  await expect(page.getByTestId("activity-panel")).toBeVisible()
  await shot(page, "s2-01-start")

  // Search: Cmd/Ctrl+K focuses it, Escape clears it.
  await page.keyboard.press(`${modKey}+k`)
  await expect(page.getByTestId("place-search")).toBeFocused()
  await page.keyboard.type("zzz")
  await expect(page.getByTestId("place-list")).toContainText("No places match.")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("place-search")).toHaveValue("")

  // Panel, section and width.
  await page.getByTestId("toggle-activity-panel").click()
  await expect(page.getByTestId("activity-panel")).toBeHidden()
  await page.getByTestId("section-toggle-agents").click()
  await expect(page.getByTestId("section-toggle-agents")).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByTestId("section-agents")).not.toContainText("No agents yet.")

  const resizer = page.getByTestId("place-list-resizer")
  const box = await resizer.boundingBox()
  if (!box) throw new Error("no resizer")
  const startX = box.x + box.width / 2
  const y = box.y + 200
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(startX + 400, y, { steps: 5 })
  await page.mouse.up()
  await expect(resizer).toHaveAttribute("aria-valuenow", "400")
  await resizer.focus()
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft")
  await expect(resizer).toHaveAttribute("aria-valuenow", "340")
  expect(Math.round((await page.getByTestId("place-list").boundingBox())?.width ?? 0)).toBe(340)

  // Pages.
  await page.getByTestId("page-help").click()
  await expect(page.getByTestId("help-page")).toBeVisible()
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("page-later")).toBeVisible()
  await page.getByTestId("page-chats").click()
  await expect(page.getByTestId("no-place")).toBeVisible()

  // Add server is not available yet and says so.
  await page.getByTestId("server-add").click()
  await expect(page.getByTestId("add-server-dialog")).toBeVisible()
  await shot(page, "s2-02-add-server")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("add-server-dialog")).toBeHidden()
  await shot(page, "s2-03-changed")
  await app.close()

  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1200, 800)
  await expect(page.getByTestId("activity-panel")).toBeHidden()
  await expect(page.getByTestId("section-toggle-agents")).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByTestId("place-list-resizer")).toHaveAttribute("aria-valuenow", "340")
  await expect(page.getByTestId("server-tile").first()).toHaveAttribute("aria-pressed", "true")
  await shot(page, "s2-04-after-restart")
  await app.close()
})

test("layout: at 760 px the rail is 56 px wide and the activity panel is hidden", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 800)
  await expect(page.getByTestId("activity-panel")).toBeVisible()
  await expect.poll(async () => (await page.getByTestId("rail").boundingBox())?.width).toBe(72)

  await resizeWindow(app, 760, 700)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(760)
  await expect(page.getByTestId("activity-panel")).toBeHidden()
  await expect.poll(async () => (await page.getByTestId("rail").boundingBox())?.width).toBe(56)
  await shot(page, "s2-05-narrow")

  await resizeWindow(app, 1000, 700)
  await expect(page.getByTestId("activity-panel")).toBeVisible()
  await app.close()
})
