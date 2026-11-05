import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

test("routines: create, preview, run now, calendar, pause, edit, delete", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await page.getByTestId("page-routines").click()
  await expect(page.getByTestId("routines-empty")).toBeVisible()
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Morning check")
  await page.getByTestId("routine-prompt").fill("Say good morning")
  // A cron expression that is not valid blocks saving; a valid one shows three runs.
  await page.getByTestId("routine-kind").selectOption("cron")
  await page.getByTestId("routine-cron").fill("nope")
  await expect(page.getByTestId("routine-save")).toBeDisabled()
  await page.getByTestId("routine-cron").fill("*/5 * * * *")
  await expect(page.getByTestId("routine-preview").locator("li")).toHaveCount(3)
  await shot(page, "s13-01-routine-dialog")
  await page.getByTestId("routine-kind").selectOption("daily")
  await page.getByTestId("routine-times").fill("09:00, 18:30")
  await expect(page.getByTestId("routine-preview").locator("li")).toHaveCount(3)
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(1)
  await expect(page.getByTestId("routine-card")).toContainText("Daily at 09:00, 18:30")
  await expect(page.getByTestId("routine-next")).toBeVisible()
  await shot(page, "s13-02-routine-list")

  // Run now: the agent answers in its chat, and the task shows as a routine task.
  await page.getByTestId("routine-run").click()
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-table")).toContainText("Routine", { timeout: 15_000 })
  await expect(page.getByTestId("tasks-table")).toContainText("Done", { timeout: 15_000 })

  // The calendar shows the run, and planned runs.
  await page.getByTestId("page-routines").click()
  await page.getByTestId("routine-view").getByText("Week").click()
  await expect(page.getByTestId("routine-calendar")).toBeVisible()
  await expect(page.locator("[data-testid=calendar-entry][data-state=done]")).toHaveCount(1)
  await expect(
    page.locator("[data-testid=calendar-entry][data-state=planned]").first(),
  ).toBeVisible()
  await shot(page, "s13-03-calendar")
  await page.getByTestId("routine-view").getByText("Month").click()
  await expect(page.getByTestId("routine-calendar")).toHaveAttribute("data-mode", "month")
  await page.getByTestId("routine-view").getByText("List").click()

  // Pause removes the next runs; edit changes the name; delete removes the card.
  await page.getByTestId("routine-enabled").click()
  await expect(page.getByTestId("routine-card")).toHaveAttribute("data-enabled", "false")
  await expect(page.getByTestId("routine-next")).toHaveCount(0)
  await page.getByTestId("routine-edit").click()
  await page.getByTestId("routine-name").fill("Evening check")
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-card")).toContainText("Evening check")
  await page.getByTestId("routine-delete").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(0)
  await app.close()
})
