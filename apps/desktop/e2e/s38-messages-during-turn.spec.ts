import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, type RecordedRequest, startMockProvider } from "./mock-provider.ts"

// The tool step runs `sleep` in a shell, and the stand-in programs are shell scripts.
test.skip(process.platform === "win32", "the steps need a shell")

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })
const userRow = (page: Page, text: string) =>
  page.locator("[data-testid=message][data-author=user]").filter({ hasText: text })
const agentRows = (page: Page) => page.locator("[data-testid=message][data-author=agent]")

/** The messages of each request to the model that holds the text. */
const requestsWith = (requests: readonly RecordedRequest[], text: string) =>
  requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => (r.body as { messages: { role: string; content: string | null }[] }).messages)
    .filter((messages) => messages.some((m) => String(m.content ?? "").includes(text)))

const sleepStep = `TOOL run_command ${JSON.stringify({ command: "sleep 3" })}`

test("messages during a turn: join, delete, answer a question, the queue and Send now", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const report: string[] = ["# S38 messages during a turn", ""]
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const agentsBefore = await agentRows(page).count()

  // The setting has its default: the message joins the current turn.
  await page.getByTestId("open-settings").click()
  await expect(
    page.getByTestId("setting-during-turn").locator('label[data-value="join"] input'),
  ).toBeChecked()
  await shot(page, "s38-01-setting")
  await page.getByTestId("settings-close").click()

  // A tool step of 3 seconds runs. The user changes the course of the turn.
  await send(page, sleepStep)
  await expect(page.getByTestId("tool-card")).toContainText("Running", { timeout: 15_000 })
  await send(page, "Use b.txt instead")
  const joined = userRow(page, "Use b.txt instead")
  await expect(joined.getByTestId("unread-line")).toHaveText(/Read at the next step/)
  await expect(page.getByTestId("queued")).toHaveCount(0)
  await shot(page, "s38-02-read-at-next-step")
  await settled(page)
  // The agent read it at the next step of the same turn: one reply, and the line went away.
  await expect(joined.getByTestId("unread-line")).toHaveCount(0)
  await expect(agentRows(page)).toHaveCount(agentsBefore + 1)
  await expect(agentRows(page).last()).toContainText("You said: Use b.txt instead")
  const withMessage = requestsWith(mock.requests, "Use b.txt instead")
  expect(withMessage).toHaveLength(1)
  // The message came right after the result of the tool step.
  expect(withMessage[0]?.slice(-2).map((m) => m.role)).toEqual(["tool", "user"])
  report.push("- Join: the next request held the message after the tool result. One reply.")

  // A message that the user deletes before the step ends never reaches the model.
  await send(page, sleepStep)
  await expect(page.getByTestId("tool-card").last()).toContainText("Running", {
    timeout: 15_000,
  })
  await send(page, "secret change of plan")
  await userRow(page, "secret change of plan").getByTestId("unread-delete").click()
  await expect(userRow(page, "secret change of plan")).toHaveCount(0)
  await settled(page)
  expect(requestsWith(mock.requests, "secret change of plan")).toHaveLength(0)
  report.push("- Delete: the model never got the deleted message.")

  // A question card waits. The message in the chat is its answer.
  await send(
    page,
    `TOOL ask_user ${JSON.stringify({ question: "Which file?", choices: ["a.txt", "b.txt"] })}`,
  )
  await expect(page.getByTestId("ask-card")).toContainText("Which file?", { timeout: 15_000 })
  await send(page, "the second one")
  await expect(page.getByTestId("tool-answered-in-chat")).toHaveText("Answered in the chat")
  await settled(page)
  await expect(agentRows(page).last()).toContainText("Tool said: the second one")
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await shot(page, "s38-03-answered-in-chat")
  report.push("- Question: the card says 'Answered in the chat'; the tool got the text.")

  // The task detail lists the message that joined the turn, with its time.
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-joined-item")).toHaveCount(1)
  await expect(page.getByTestId("task-joined-item")).toContainText("the second one")
  await shot(page, "s38-04-task-detail")
  await page.keyboard.press("Escape")
  await page.getByTestId("page-chats").click()
  report.push("- Task detail: the joined message shows under the prompt.")

  // Wait in a queue: the message waits above the box, and Send now puts it into the turn.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-during-turn").locator('label[data-value="queue"]').click()
  await page.getByTestId("settings-close").click()
  await send(page, "go slow please")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await send(page, "queued words")
  await expect(page.getByTestId("queued")).toContainText("queued words")
  await expect(page.getByTestId("queue-hold")).toHaveCount(0)
  await shot(page, "s38-05-queue")
  const repliesBefore = await agentRows(page).count()
  await page.getByTestId("queued-send-now").click()
  await expect(page.getByTestId("queued")).toHaveCount(0)
  await settled(page)
  await expect(agentRows(page)).toHaveCount(repliesBefore)
  await expect(agentRows(page).last()).toContainText("You said: queued words")
  report.push("- Queue: Send now put the queued message into the running turn.")

  writeFileSync(join(shotsDir, "s38-report.md"), `${report.join("\n")}\n`)
  await app.close()
  await mock.close()
})

test("a program that takes no input during a turn: the message waits in the queue, with the reason", async () => {
  test.setTimeout(120_000)
  const fake = makeFakeRuntimes()
  fake.setCodex({ loggedIn: true, method: "chatgpt" })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CODEX_BIN: fake.codex,
    ROBOT_CLAUDE_BIN: "none",
  })
  await resizeWindow(app, 1300, 860)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("codex")
  await expect(page.getByTestId("runtime-status")).toHaveText("Signed in.")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("settings-close").click()
  await createAgent(page, "Cody")

  // The setting says "Join the current turn", but Codex reads its prompt once.
  await send(page, "SLOW")
  await expect(page.getByTestId("composer-stop")).toBeVisible({ timeout: 15_000 })
  await send(page, "while codex works")
  await expect(page.getByTestId("queued")).toContainText("while codex works")
  await expect(page.getByTestId("queue-hold")).toHaveText(
    "Codex reads no messages during a turn. Your messages wait here until the turn ends.",
  )
  await expect(page.getByTestId("queued-send-now")).toBeDisabled()
  await expect(userRow(page, "while codex works")).toHaveCount(0)
  await shot(page, "s38-06-runtime-queue")

  // The turn ends: the queued message goes as the next turn.
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("queued")).toHaveCount(0)
  await expect(userRow(page, "while codex works")).toHaveCount(1)
  await expect
    .poll(() => fake.codexCalls().some((c) => String(c.prompt).includes("while codex works")))
    .toBe(true)
  // The history still holds the slow request, so the stand-in works slowly again.
  await page.getByTestId("composer-stop").click()
  await settled(page)
  await app.close()
})
