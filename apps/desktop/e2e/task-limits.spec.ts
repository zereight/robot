import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Limits of a task and the retry note (specs 005, 007, 013): the step limit, repeated reads, the
// chain of messages between agents, and the note that shows before a retry.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
/** Sends a text and waits until the reply to it has ended (a message of the user and a reply). */
const ask = async (page: Page, text: string) => {
  const messages = page.getByTestId("message")
  const before = await messages.count()
  await send(page, text)
  await expect(messages).toHaveCount(before + 2, { timeout: 30_000 })
  await settled(page)
}
const place = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]").filter({ hasText: name })
const rows = (page: Page) => page.getByTestId("task-row")

test("limits of a task: step limit, repeated reads, chain of messages, retry note", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgent(page, "Bo")
  await place(page, "Ada").click()

  // --- The step limit is a setting: a whole number from 20 to 2000 (013) ------------------------
  await page.getByTestId("open-settings").click()
  const limit = page.getByTestId("setting-step-limit")
  await expect(limit).toHaveValue("300")
  await limit.fill("19")
  await expect(page.getByTestId("setting-step-limit-row")).toContainText(
    "Use a whole number from 20 to 2000.",
  )
  await limit.blur()
  await expect(limit).toHaveValue("300")
  await limit.fill("20")
  await limit.press("Enter")
  await expect(limit).toHaveValue("20")
  await shot(page, "task-limits-01-setting")
  await page.getByTestId("settings-close").click()

  // --- Step limit: a model that calls a tool without end. The task fails at step 20 (005) ------
  await send(page, "ENDLESS please")
  await expect(page.getByTestId("failed-row")).toContainText("Step limit reached (20).", {
    timeout: 60_000,
  })
  // The reply that streamed stays, and it is marked as stopped.
  const stopped = page.locator("[data-testid=message][data-status=stopped]")
  await expect(stopped).toHaveCount(1)
  await expect(stopped.getByTestId("stopped-mark")).toBeVisible()
  await expect(stopped).toContainText("Working.")
  await expect(stopped.getByTestId("tool-card")).toHaveCount(20)
  await shot(page, "task-limits-02-step-limit")
  await page.getByTestId("page-tasks").click()
  await expect(rows(page).first()).toHaveAttribute("data-state", "failed")
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-error")).toContainText("Step limit reached (20).")
  await page.keyboard.press("Escape")
  await page.getByTestId("page-chats").click()

  // --- Repeated reads: the third step fails, a changed file reads again (005) -------------------
  await ask(page, `TOOL write_file ${JSON.stringify({ path: "note.txt", content: "one" })}`)
  const read = { name: "read_file", args: { path: "note.txt" } }
  const rewrite = { name: "write_file", args: { path: "note.txt", content: "two" } }
  await ask(page, `TOOLS ${JSON.stringify([read, read, read, rewrite, read])}`)
  const last = page.getByTestId("message").last()
  const cards = last.getByTestId("tool-card")
  await expect(cards).toHaveCount(5)
  await expect(cards.nth(2).getByTestId("tool-reason")).toContainText(
    "Read before with the same result.",
  )
  await expect(cards.nth(2).getByTestId("tool-reason")).toHaveAttribute(
    "data-code",
    "repeated_read",
  )
  await expect(cards.nth(1).getByTestId("tool-reason")).toHaveCount(0)
  await expect(cards.nth(4).getByTestId("tool-reason")).toHaveCount(0)
  await shot(page, "task-limits-03-repeated-read")
  // Cards: done, done, failed, done, done.
  await expect(cards.nth(2)).toContainText("Failed")
  await expect(cards.nth(4)).toContainText("Done")

  // --- Chain of messages: the send at depth 8 fails; no more task starts from a send (005, 007) --
  await page.getByTestId("page-tasks").click()
  const before = await rows(page).count()
  await page.getByTestId("page-chats").click()
  await send(page, "PINGPONG with Bo")
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("tasks-filter-source").selectOption("agent")
  // 8 tasks start from sends (depth 1 to 8). Each one's reply comes back as a task of its own.
  await expect(rows(page)).toHaveCount(16, { timeout: 90_000 })
  await expect(page.locator("[data-testid=task-row][data-state=done]")).toHaveCount(16, {
    timeout: 60_000,
  })
  // Nothing else starts: the list stays at 16.
  await page.waitForTimeout(2_000)
  await expect(rows(page)).toHaveCount(16)
  await page.getByTestId("tasks-filter-source").selectOption("")
  await expect(rows(page)).toHaveCount(before + 1 + 16)
  await page.getByTestId("page-chats").click()
  // The failed step shows the reason in the chat of Ada (the task at depth 8 is hers).
  const chainStep = page.locator('[data-testid=tool-reason][data-code="chain_limit"]')
  await expect(chainStep).toHaveCount(1)
  await expect(chainStep).toContainText("The chain of agent messages is at its limit (8).")
  await chainStep.scrollIntoViewIfNeeded()
  await shot(page, "task-limits-04-chain-limit")

  // --- Retry note, in the chat ----------------------------------------------------------------
  await send(
    page,
    `FAILTOOL TOOL write_file ${JSON.stringify({ path: "made.txt", content: "written" })}`,
  )
  await expect(page.getByTestId("failed-row").last()).toBeVisible({ timeout: 30_000 })
  await settled(page)
  const tasksBefore = async () => {
    await page.getByTestId("page-tasks").click()
    const n = await rows(page).count()
    await page.getByTestId("page-chats").click()
    return n
  }
  const count = await tasksBefore()
  // Retry shows the note first, with the write step. Back starts nothing.
  await page.getByTestId("retry").last().click()
  const note = page.getByTestId("retry-note")
  await expect(note).toBeVisible()
  await expect(note).toContainText("The first try may have changed things")
  await expect(note).toContainText("Check the state before you try again.")
  await expect(note.getByTestId("retry-note-step")).toHaveCount(1)
  await expect(note.getByTestId("retry-note-step")).toContainText("Write file")
  await expect(note.getByTestId("retry-note-step")).toContainText("made.txt")
  await expect(note.getByTestId("retry-note-step")).toContainText("Ran")
  await expect(note.getByTestId("retry-note-more")).toHaveCount(0)
  await shot(page, "task-limits-05-retry-note")
  await note.getByTestId("retry-back").click()
  await expect(note).toHaveCount(0)
  await expect(page.getByTestId("failed-row").last()).toBeVisible()
  expect(await tasksBefore()).toBe(count)
  // Retry anyway starts a new task.
  await page.getByTestId("retry").last().click()
  await page.getByTestId("retry-anyway").click()
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Tool said:")
  expect(await tasksBefore()).toBe(count + 1)

  // A task that only read files starts at once on Retry, with no note.
  await ask(page, `TOOL write_file ${JSON.stringify({ path: "plain.txt", content: "plain" })}`)
  await send(page, `FAILTOOL TOOL read_file ${JSON.stringify({ path: "plain.txt" })}`)
  await expect(page.getByTestId("failed-row").last()).toBeVisible({ timeout: 30_000 })
  await settled(page)
  const countRead = await tasksBefore()
  await page.getByTestId("retry").last().click()
  await expect(page.getByTestId("retry-note")).toHaveCount(0)
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Tool said:")
  expect(await tasksBefore()).toBe(countRead + 1)

  // --- Action log: a step of a file says whether it read or wrote (007) ------------------------
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  const wrote = page.locator("[data-testid=action-log-access][data-access=write]")
  const readIt = page.locator("[data-testid=action-log-access][data-access=read]")
  await expect(wrote.first()).toContainText("Write")
  await expect(readIt.first()).toContainText("Read")
  await shot(page, "task-limits-06-action-log")
  await page.getByTestId("settings-close").click()

  // --- Retry note, on the Tasks page, in Korean ------------------------------------------------
  await send(
    page,
    `FAILTOOL TOOL run_command ${JSON.stringify({ command: "echo hi > shell.txt" })}`,
  )
  await expect(page.getByTestId("failed-row").last()).toBeVisible({ timeout: 30_000 })
  await settled(page)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("tasks-filter-state").selectOption("failed")
  await expect(rows(page).first()).toContainText("echo hi > shell.txt")
  const failedCount = await rows(page).count()
  await page.getByTestId("task-open").first().click()
  await page.getByTestId("task-retry").click()
  const koNote = page.getByTestId("retry-note")
  await expect(koNote).toBeVisible()
  await expect(koNote).toContainText("첫 시도에서 바뀐 것이 있을 수 있어요")
  await expect(koNote.getByTestId("retry-note-step")).toContainText("셸 명령")
  await expect(koNote.getByTestId("retry-note-step")).toContainText("echo hi > shell.txt")
  await shot(page, "task-limits-07-retry-note-korean")
  await koNote.getByTestId("retry-back").click()
  await expect(koNote).toHaveCount(0)
  // Back changed nothing: the task is still failed and no task started.
  await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "failed")
  await page.getByTestId("task-retry").click()
  await page.getByTestId("retry-anyway").click()
  await page.keyboard.press("Escape")
  await page.getByTestId("tasks-filter-state").selectOption("")
  await expect(rows(page).first()).toHaveAttribute("data-state", /running|done/)
  await page.getByTestId("tasks-filter-state").selectOption("failed")
  await expect(rows(page)).toHaveCount(failedCount)

  await app.close()
  await mock.close()
})
