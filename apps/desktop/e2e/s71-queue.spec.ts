import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 003 and 005, "Queue": a thread that waits for another thread, the limit of the message
// queue, "Run next", and "Agents working at once" (S71, S72, 013).

const agentMessages = (page: Page) => page.locator("[data-testid=message][data-author=agent]")
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const openThreads = async (page: Page) => {
  await page.getByTestId("thread-list").click()
  await expect(page.getByTestId("thread-menu")).toBeVisible()
}
const openAgent = (page: Page, name: string) =>
  page
    .getByTestId("place-list")
    .locator('[data-testid^="place-agent-"]')
    .filter({ hasText: name })
    .click()

const start = async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  return { mock, app, page }
}

test("threads share one queue: the line, Run next, and the limit of 10 messages", async () => {
  test.setTimeout(120_000)
  const { mock, app, page } = await start()

  // A turn runs in the main thread. A message in a new thread waits for it.
  await send(page, "run long in main")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await openThreads(page)
  await page.getByTestId("thread-create").click()
  await expect(page.getByTestId("thread-current")).toHaveText("New thread")
  await send(page, "from thread B")
  await expect(page.getByTestId("queued-task-behind")).toHaveText("Waits for another thread")
  await expect(page.getByTestId("queued-run-next")).toBeVisible()
  await shot(page, "s71-01-waits-for-another-thread")
  await page.getByTestId("queued-run-next").click()
  await expect(page.getByTestId("composer-error")).toHaveCount(0)

  // The turn of the main thread ends: the task of thread B starts.
  await openThreads(page)
  await page.getByTestId("thread-main").click()
  await page.getByTestId("composer-stop").click()
  await openThreads(page)
  await page.getByTestId("thread-item").filter({ hasText: "from thread B" }).click()
  await expect(agentMessages(page).last()).toContainText("You said: from thread B")
  await expect(page.getByTestId("queued-task-line")).toHaveCount(0)

  // Fill the message queue with 10 messages: the 11th stays in the box with the reason.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-during-turn").locator('label[data-value="queue"]').click()
  await page.getByTestId("settings-close").click()
  await send(page, "run long in thread B")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  for (let i = 1; i <= 10; i++) await send(page, `waits ${i}`)
  await expect(page.getByTestId("queued")).toHaveCount(10)
  await send(page, "the eleventh")
  await expect(page.getByTestId("composer-error")).toHaveText(
    "10 messages wait. Remove one or wait.",
  )
  await expect(page.getByTestId("composer-input")).toHaveValue("the eleventh")
  await shot(page, "s71-02-queue-full")
  await page.getByTestId("composer-stop").click()

  await app.close()
  await mock.close()
})

test("agents working at once: the field refuses 0 and 9, and a task waits for a free slot", async () => {
  test.setTimeout(120_000)
  const { mock, app, page } = await start()
  await createAgent(page, "Bo")

  // The field refuses 9 and 0, and keeps the old value.
  await page.getByTestId("open-settings").click()
  const field = page.getByTestId("setting-agents-at-once")
  await expect(field).toHaveValue("4")
  for (const value of ["9", "0"]) {
    await field.fill(value)
    await expect(page.getByTestId("setting-agents-at-once-row")).toContainText(
      "Use a whole number from 1 to 8.",
    )
    await field.press("Enter")
    await expect(field).toHaveValue("4")
  }
  await field.fill("1")
  await field.press("Enter")
  await expect(field).toHaveValue("1")
  await shot(page, "s72-01-agents-at-once")
  await page.getByTestId("settings-close").click()

  // With one slot, a task of a second agent waits for it.
  await openAgent(page, "Ada")
  await send(page, "run long for Ada")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await openAgent(page, "Bo")
  await send(page, "hello from Bo")
  await expect(page.getByTestId("queued-task-behind")).toHaveText("Waits for a free slot. Slots: 1")
  await shot(page, "s72-02-waits-for-a-free-slot")

  // The Tasks page shows the same line and "Run next" on the queued task.
  await page.getByTestId("page-tasks").click()
  const queued = page.locator("[data-testid=task-row][data-state=queued]")
  await expect(queued.getByTestId("task-behind")).toHaveText("Waits for a free slot. Slots: 1")
  await expect(queued.getByTestId("task-run-next")).toBeVisible()
  await page.getByTestId("page-chats").click()

  // Raise the number: the task starts at once.
  await page.getByTestId("open-settings").click()
  await field.fill("2")
  await field.press("Enter")
  await page.getByTestId("settings-close").click()
  await openAgent(page, "Bo")
  await expect(agentMessages(page).last()).toContainText("You said: hello from Bo")

  await app.close()
  await mock.close()
})
