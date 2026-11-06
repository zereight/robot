import { expect, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, killAtOnce, launch, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 003: the chat of a workflow.

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

const say = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text)
  await page.getByTestId("chat-input").press("Enter")
}

test("chat: empty state, send, markdown reply, stop, join and delete, find", async () => {
  const mock = await startMockProvider()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const userData = freshUserData()
  let { app, page } = await launch(userData, env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")

  // A new chat shows the name of the workflow and the start line.
  await expect(page.getByTestId("chat-empty")).toContainText("Weekly report")
  await expect(page.getByTestId("chat-empty")).toContainText("This is the start of your chat.")
  await expect(page.getByTestId("chat-input")).toHaveAttribute(
    "placeholder",
    "Message Weekly report",
  )
  await shot(page, "w5-30-chat-empty")

  // Send: the message shows at once, and the reply streams in under the name of the workflow.
  await say(page, "hello budget")
  await expect(page.getByTestId("message").first()).toContainText("hello budget")
  await expect(page.getByTestId("message").nth(1)).toContainText("You said: hello budget")
  await expect(page.getByTestId("message").nth(1).getByText("Weekly report")).toBeVisible()
  await expect(page.getByTestId("working-line")).toHaveCount(0)

  // Replies render Markdown. Shift+Enter makes a new line and does not send.
  await page.getByTestId("chat-input").fill("**bold** and `code`")
  await page.getByTestId("chat-input").press("Shift+Enter")
  await page.getByTestId("chat-input").pressSequentially("- item")
  await page.getByTestId("chat-input").press("Enter")
  const markdown = page.getByTestId("message-text").last()
  await expect(markdown.locator("strong")).toHaveText("bold")
  await expect(markdown.locator("code")).toHaveText("code")
  await expect(markdown.locator("li")).toHaveText("item")

  // Stop: the send button is a stop button while the reply works. The partial reply stays.
  await say(page, "slow please")
  await expect(page.getByTestId("working-line")).toBeVisible()
  await expect(page.getByTestId("chat-send")).toHaveCount(0)
  await expect(page.getByText("word2 ")).toBeVisible()
  await shot(page, "w5-31-chat-working")
  await page.getByTestId("chat-stop").click()
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect(page.getByTestId("message-stopped")).toBeVisible()
  await expect(page.getByTestId("chat-send")).toBeVisible()
  await expect(page.getByText("word1 ")).toBeVisible()

  // A message sent during a turn joins it: "Read at the next step", and Delete takes it back.
  await say(page, "slow again")
  await expect(page.getByTestId("working-line")).toBeVisible()
  await say(page, "never read this")
  await expect(page.getByTestId("message-pending")).toContainText("Read at the next step")
  await page.getByTestId("message-delete").click()
  await expect(page.getByTestId("message-pending")).toHaveCount(0)
  await expect(page.getByText("never read this")).toHaveCount(0)
  await page.getByTestId("chat-stop").click()
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  expect(JSON.stringify(mock.requests)).not.toContain("never read this")

  // Find: Cmd+F opens a bar, the count is "n of m", Enter goes on, Escape closes it.
  await say(page, "budget again")
  await expect(page.getByTestId("message-text").last()).toContainText("You said: budget again")
  await page.getByTestId("chat-input").press("Meta+f")
  await expect(page.getByTestId("find-bar")).toBeVisible()
  await page.getByTestId("find-input").fill("budget")
  await expect(page.getByTestId("find-count")).toHaveText("1 of 4")
  await page.getByTestId("find-input").press("Enter")
  await expect(page.getByTestId("find-count")).toHaveText("2 of 4")
  await page.getByTestId("find-input").press("Shift+Enter")
  await expect(page.getByTestId("find-count")).toHaveText("1 of 4")
  await shot(page, "w5-32-chat-find")
  await page.getByTestId("find-input").press("Escape")
  await expect(page.getByTestId("find-bar")).toHaveCount(0)

  // Reply: a quote line shows above the box and above the sent message.
  await page.getByTestId("message").first().hover()
  await page.getByTestId("message-reply").first().click()
  await expect(page.getByTestId("reply-line")).toContainText("hello budget")
  await say(page, "about that")
  await expect(page.getByTestId("message-quote")).toContainText("hello budget")
  await expect(page.getByTestId("reply-line")).toHaveCount(0)

  // The messages stay after a restart, and the chat opens at the same place.
  const count = await page.getByTestId("message").count()
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await expect(page.getByTestId("message")).toHaveCount(count)
  await expect(page.getByTestId("message-quote")).toContainText("hello budget")
  await app.close()
  await mock.close()
})

test("chat: skills in the slash list, a dropped file, and the queue", async () => {
  const mock = await startMockProvider()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(freshUserData(), env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await page.evaluate(async () => {
    const servers = await window.robot.invoke("servers.list", undefined)
    if (!servers.ok) throw new Error("no servers")
    const serverId = servers.value[0]?.id ?? ""
    await window.robot.invoke("skills.create", {
      serverId,
      name: "summarise",
      description: "Make it short",
      instructions: "Summarise in three lines.",
    })
  })

  // A slash first opens the list. A path never does.
  await page.getByTestId("chat-input").fill("/su")
  await expect(page.getByTestId("skill-picker")).toBeVisible()
  await expect(page.getByTestId("skill-option")).toHaveCount(1)
  await shot(page, "w5-33-chat-skills")
  await page.getByTestId("chat-input").fill("~/notes/todo")
  await expect(page.getByTestId("skill-picker")).toHaveCount(0)
  await page.getByTestId("chat-input").fill("/su")
  await page.getByTestId("skill-option").click()
  await expect(page.getByTestId("skill-chip")).toContainText("summarise")
  await say(page, "the news")
  await expect(page.getByTestId("message-skill").first()).toContainText("summarise")
  await expect(page.getByTestId("message").nth(1)).toContainText("Summarise in three lines.")

  // A dropped file shows as a chip, and goes with the message.
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(["hello file"], "notes.txt", { type: "text/plain" }))
    document
      .querySelector('[data-testid="composer"]')
      ?.dispatchEvent(
        new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
      )
  })
  await expect(page.getByTestId("attached-file")).toContainText("notes.txt")
  await say(page, "see the file")
  await expect(page.getByTestId("message-file").first()).toContainText("notes.txt")
  await expect(page.getByTestId("message-file")).toHaveCount(1)

  // With "Wait in a queue", a message waits above the box and goes when the turn ends.
  await page.evaluate(() => window.robot.invoke("settings.update", { duringTurn: "queue" }))
  await say(page, "slow queue")
  await expect(page.getByTestId("working-line")).toBeVisible()
  await say(page, "queued message")
  await expect(page.getByTestId("queued-message")).toContainText("queued message")
  await shot(page, "w5-34-chat-queue")
  await page.getByTestId("queued-edit").click()
  await expect(page.getByTestId("chat-input")).toHaveValue("queued message")
  await expect(page.getByTestId("queued-message")).toHaveCount(0)
  await say(page, "queued message")
  await expect(page.getByTestId("queued-message")).toHaveCount(1)
  await page.getByTestId("chat-stop").click()
  await expect(page.getByTestId("queued-message")).toHaveCount(0, { timeout: 10_000 })
  await expect(
    page.getByTestId("message-text").filter({ hasText: "queued message" }).first(),
  ).toBeVisible()
  await page
    .getByTestId("chat-stop")
    .click({ timeout: 2000 })
    .catch(() => undefined)
  await app.close()
  await mock.close()
})

test("chat: no provider blocks the box, and a restart cuts a request with a notice", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await newWorkflow(page, "Weekly report")
  await expect(page.getByTestId("chat-blocked")).toContainText("Connect a model provider")
  await expect(page.getByTestId("chat-input")).toHaveCount(0)
  await shot(page, "w5-35-chat-blocked")
  await page.getByTestId("chat-connect").click()
  await expect(page.getByTestId("settings-nav-providers")).toBeVisible()
  await page.getByTestId("settings-close").click()
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await expect(page.getByTestId("chat-input")).toBeVisible()

  // The app ends while the reply streams. After the restart a notice offers "Continue".
  await say(page, "slow start")
  await expect(page.getByText("word2 ")).toBeVisible()
  await killAtOnce(app)
  ;({ app, page } = await launch(userData, env))
  await expect(page.getByTestId("restart-notice")).toContainText(
    "The restart stopped your request.",
  )
  await expect(page.getByTestId("message-stopped")).toBeVisible()
  await shot(page, "w5-36-chat-notice")
  await page.getByTestId("notice-continue").click()
  await expect(page.getByTestId("restart-notice")).toHaveCount(0)
  await expect(
    page.getByTestId("message").filter({ hasText: "Please go on" }).first(),
  ).toBeVisible()
  await app.close()
  await mock.close()
})
