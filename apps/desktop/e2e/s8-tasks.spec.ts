import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
const rows = (page: Page) => page.getByTestId("task-row")

test("tasks: list, filter, stop, retry, restart reason", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-empty")).toBeVisible()
  await page.getByTestId("page-chats").click()

  // A finished turn is a done task. A failed one can be tried again.
  await send(page, "first question")
  await settled(page)
  await send(page, "fail once please")
  await expect(page.locator("[data-testid=message][data-status=failed]")).toHaveCount(1)
  await settled(page)
  // A slow turn is running while the task page shows it; it is stopped from the detail box.
  await send(page, "please go slow")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await page.getByTestId("page-tasks").click()
  await expect(rows(page).first()).toHaveAttribute("data-state", "running")
  await expect(rows(page).first()).toContainText("please go slow")
  await shot(page, "s8-01-tasks-running")
  await page.getByTestId("task-open").first().click()
  await page.getByTestId("task-stop").click()
  await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "cancelled")
  await shot(page, "s8-02-task-detail")
  await page.keyboard.press("Escape")

  // Filters and search.
  await expect(rows(page)).toHaveCount(3)
  await page.getByTestId("tasks-filter-state").selectOption("cancelled")
  await expect(rows(page)).toHaveCount(1)
  await page.getByTestId("tasks-filter-state").selectOption("failed")
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText("fail once")
  await page.getByTestId("tasks-filter-state").selectOption("")
  await page.getByTestId("tasks-search").fill("FIRST")
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText("first question")
  await page.getByTestId("tasks-search").fill("zzz")
  await expect(page.getByTestId("tasks-no-match")).toBeVisible()
  await page.getByTestId("tasks-search").fill("")

  // Retry a cancelled task: it asks again and links to the old one.
  await page.getByTestId("task-open").first().click()
  await page.getByTestId("task-retry").click()
  await page.getByTestId("task-open-source").click()
  await expect(page.getByTestId("chat-start")).toContainText("Ada")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await page.getByTestId("composer-stop").click()
  await settled(page)
  await page.getByTestId("page-tasks").click()
  await expect(rows(page)).toHaveCount(4)
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-detail")).toContainText("Tries again an earlier task.")
  await page.keyboard.press("Escape")

  // Korean.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("tasks-table")).toContainText("취소됨")
  await shot(page, "s8-03-tasks-korean")

  // Restart in the middle of a turn: the task shows as failed or cancelled, never running.
  await page.getByTestId("page-chats").click()
  await send(page, "slow again")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await page.getByTestId("page-tasks").click()
  await expect(page.locator("[data-testid=task-row][data-state=running]")).toHaveCount(0)
  await expect(page.locator("[data-testid=task-row][data-state=queued]")).toHaveCount(0)
  await app.close()
  await mock.close()
})
