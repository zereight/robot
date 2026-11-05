import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// "Record only" on a watch routine (spec question of 009): a change starts no task and asks no
// model. The calendar shows it as Recorded, with the change.

test("watch routines: Record only shows a change in the calendar and starts no task", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const folder = mkdtempSync(join(tmpdir(), "robot-e2e-record-"))
  writeFileSync(join(folder, "old.txt"), "old")
  // A "minute" of a watch is one second in this run; the loop looks every 300 ms.
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_WATCH_MINUTE_MS: "1000",
    ROBOT_TEST_ROUTINE_TICK_MS: "300",
  })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await page.getByTestId("page-routines").click()
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Inbox watch")
  await page.getByTestId("routine-prompt").fill("Sort the new files.")
  await page.getByTestId("routine-trigger").selectOption("watch")
  await page.getByTestId("routine-watch-interval").selectOption("5")
  await page.getByTestId("routine-watch-kind").selectOption("path")
  await page.getByTestId("routine-watch-path").fill(folder)
  await page.getByTestId("routine-watch-record-only").click()
  await expect(page.getByText("asks no model", { exact: false })).toBeVisible()
  await shot(page, "record-only-01-form")
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(1)

  // The first check keeps the result. Then a new file is a change that is only recorded.
  await page.waitForTimeout(1500)
  writeFileSync(join(folder, "new-report.txt"), "new")
  await page.getByTestId("routine-view").getByText("Week").click()
  const recorded = page.locator("[data-testid=calendar-entry][data-state=recorded]")
  await expect(recorded.first()).toBeVisible({ timeout: 20_000 })
  await recorded.first().getByTestId("calendar-change").locator("summary").click()
  await expect(recorded.first().getByTestId("calendar-change")).toContainText(
    "Added: new-report.txt",
  )
  await shot(page, "record-only-02-calendar")
  expect(mock.requests.filter((r) => r.path.endsWith("/chat/completions"))).toHaveLength(0)
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-empty")).toBeVisible()

  await app.close()
  await mock.close()
})

test("workflows: a message trigger with Record only records the run and runs no step", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Ops")
  await page.getByTestId("channel-member-Ada").check()
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Ops")

  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-new").click()
  await page.getByTestId("wf-name").fill("On deploy")
  // A manual trigger has no switch. A message trigger has it.
  await expect(page.getByTestId("wf-trigger-record-only")).toHaveCount(0)
  await page.getByTestId("wf-trigger-kind").selectOption("channel")
  await page.getByTestId("wf-trigger-contains").fill("deploy")
  await page.getByTestId("wf-trigger-record-only").click()
  await expect(page.getByTestId("wf-trigger-record-only")).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("wf-add-agent").click()
  await page.getByTestId("wf-step-prompt").fill("Handle: {{trigger}}")
  await shot(page, "record-only-03-workflow-form")
  await page.getByTestId("wf-save").click()
  await page.getByTestId("wf-back").click()
  await expect(page.getByTestId("wf-card")).toHaveCount(1)

  await page.getByTestId("page-chats").click()
  await page.getByText("Ops", { exact: true }).first().click()
  await page.getByTestId("channel-input").fill("please deploy now")
  await page.getByTestId("channel-input").press("Enter")
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-trigger-record-only")).toHaveAttribute("aria-checked", "true")
  const row = page.getByTestId("wf-run-row")
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await expect(row).toContainText("Recorded")
  await row.click()
  await expect(page.getByTestId("wf-run-recorded")).toBeVisible()
  await expect(page.getByTestId("wf-run-trigger-text")).toHaveText("please deploy now")
  await expect(page.getByTestId("wf-run-step")).toHaveCount(0)
  await shot(page, "record-only-04-workflow-history")
  const handled = mock.requests.filter((r) =>
    String(JSON.stringify(r.body ?? "")).includes("Handle:"),
  )
  expect(handled).toHaveLength(0)

  await app.close()
  await mock.close()
})
