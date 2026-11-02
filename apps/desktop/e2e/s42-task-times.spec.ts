import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)

/** The time in ms that the task detail shows, or null for "—". */
const shownMs = async (page: Page, id: "wait" | "first-reply" | "total") => {
  const value = await page.getByTestId(`task-time-${id}`).getAttribute("data-ms")
  return value ? Number(value) : null
}

test("task times: wait, first reply and total, kept through a restart, median on usage", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // The fake provider waits 2 seconds, then streams the reply.
  await send(page, "hello pause 2000ms")
  await settled(page)
  // A turn that fails before any reply.
  // Its own words: the fake provider fails a message once per run of the tests.
  await send(page, "fail once for the times")
  await expect(page.locator("[data-testid=message][data-status=failed]")).toHaveCount(1)

  await page.getByTestId("page-tasks").click()
  const rows = page.getByTestId("task-row")
  await expect(rows).toHaveCount(2)
  // Newest first: the failed task is the first row.
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "failed")
  await expect(page.getByTestId("task-time-first-reply")).toHaveText("—")
  expect(await shownMs(page, "first-reply")).toBeNull()
  expect(await shownMs(page, "wait")).not.toBeNull()
  await page.keyboard.press("Escape")

  await page.getByTestId("task-open").nth(1).click()
  await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "done")
  const firstReply = (await shownMs(page, "first-reply")) ?? -1
  const total = (await shownMs(page, "total")) ?? -1
  const wait = (await shownMs(page, "wait")) ?? -1
  // 2 seconds or a little more.
  expect(firstReply).toBeGreaterThanOrEqual(2000)
  expect(firstReply).toBeLessThan(4000)
  expect(total).toBeGreaterThanOrEqual(firstReply)
  expect(wait).toBeGreaterThanOrEqual(0)
  await expect(page.getByTestId("task-time-first-reply")).toHaveText(/^\d+\.\d s$/)
  await shot(page, "s42-01-task-times")
  await page.keyboard.press("Escape")

  // A restart keeps the times that are known.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1200, 860)
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("task-open").nth(1).click()
  expect(await shownMs(page, "first-reply")).toBe(firstReply)
  expect(await shownMs(page, "total")).toBe(total)
  expect(await shownMs(page, "wait")).toBe(wait)
  await page.keyboard.press("Escape")

  // The usage page shows the median "First reply" of the done chat tasks of the day.
  await page.getByTestId("page-usage").click()
  const day = page.getByTestId("usage-day-row").filter({ hasText: "Ada" }).first()
  await expect(day.getByTestId("usage-first-reply")).toHaveAttribute("data-ms", String(firstReply))
  await shot(page, "s42-02-usage-median")

  // Korean shows the same times in its own words.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await expect(day.getByTestId("usage-first-reply")).toHaveText(/^\d+\.\d초$/)
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-times")).toContainText("첫 답변")
  await shot(page, "s42-03-task-times-korean")
  await app.close()
  await mock.close()
})
