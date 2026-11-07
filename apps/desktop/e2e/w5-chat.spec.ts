import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { connectMock, freshUserData, killAtOnce, launch, shot, startHangingRun } from "./harness.ts"
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

test("chat: Reply and Copy are reachable with the keyboard", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await say(page, "hello keys")
  await expect(page.getByTestId("message").nth(1)).toContainText("You said: hello keys")
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await page.mouse.move(0, 0)

  const reply = page.getByTestId("message").nth(1)
  const actions = reply.getByTestId("message-actions")
  await expect(actions).toHaveCSS("opacity", "0")

  // Tab backwards from the box until the focus reaches the buttons of the last row.
  await page.getByTestId("chat-input").focus()
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")
  let at = ""
  for (let i = 0; i < 12 && at !== "message-copy"; i++) {
    await page.keyboard.press("Shift+Tab")
    at = await focused()
  }
  expect(at).toBe("message-copy")
  await expect(actions).toHaveCSS("opacity", "1")
  await shot(page, "w5-37-chat-actions-keyboard")
  await page.keyboard.press("Shift+Tab")
  expect(await focused()).toBe("message-reply")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("reply-line")).toContainText("You said: hello keys")
  await app.close()
  await mock.close()
})

test("chat: the header names the model; a program answers in text only and the chat says so", async () => {
  const mock = await startMockProvider()
  const fake = makeFakeRuntimes()
  fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: fake.claude,
  })
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await page.evaluate(async () => {
    await window.robot.invoke("providers.connect", { kind: "claude_code", name: "Claude" })
  })
  await newWorkflow(page, "Weekly report")
  await expect(page.getByTestId("chat-model")).toHaveValue(/mock-fast/)
  await expect(page.getByTestId("chat-model").locator("option:checked")).toHaveText(
    "Mock · mock-fast",
  )
  await expect(page.getByTestId("chat-no-feedback")).toHaveCount(0)

  // The user picks the program: the chat says that feedback is not there, and the program gets
  // no tools and does not run in the folder of the workflow.
  await page.getByTestId("chat-model").selectOption({ label: "Claude · opus" })
  await expect(page.getByTestId("chat-no-feedback")).toContainText("You cannot give feedback")
  await shot(page, "w5-38-chat-program")
  await say(page, "hello program")
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect
    .poll(() => fake.claudeCalls().filter((c) => "prompt" in c).length, { timeout: 10_000 })
    .toBe(1)
  const turn = fake.claudeCalls().find((c) => "prompt" in c) as { args: string[] }
  expect(turn.args[turn.args.indexOf("--tools") + 1]).toBe("")

  // The choice stays: another message goes to the same program.
  await say(page, "and again")
  await expect
    .poll(() => fake.claudeCalls().filter((c) => "prompt" in c).length, { timeout: 10_000 })
    .toBe(2)
  await expect(mock.requests).toHaveLength(0)

  await page.getByTestId("chat-model").selectOption({ label: "Mock · mock-fast" })
  await expect(page.getByTestId("chat-no-feedback")).toHaveCount(0)
  await app.close()
  await mock.close()
})

test("chat: the tool card of feedback says 'Added feedback to the run'", async () => {
  const mock = await startMockProvider()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const userData = freshUserData()
  const { app, page } = await launch(userData, env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await startHangingRun(page, { openaiUrl: mock.openaiUrl, key: GOOD_KEY })
  await say(page, 'tool add_run_feedback {"text":"Too long. Keep it short."}')
  await expect(page.getByTestId("tool-card")).toContainText("Added feedback to the run")
  await expect(page.getByTestId("tool-card")).not.toContainText("add_run_feedback")
  await expect(page.getByTestId("tool-card")).not.toContainText("Too long")
  await expect(page.getByTestId("note-feedback_added")).toBeVisible()
  await shot(page, "w5-39-chat-feedback-card")
  await app.close()
  await mock.close()
})

test("chat: a program that cannot be locked to text only is not used, and the chat says why", async () => {
  const mock = await startMockProvider()
  const fake = makeFakeRuntimes()
  fake.setCodex({ loggedIn: true, method: "chatgpt" })
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_CODEX_BIN: fake.codex }
  let { app, page } = await launch(userData, env)
  await page.evaluate(async () => {
    await window.robot.invoke("providers.connect", { kind: "codex", name: "Codex" })
  })
  await newWorkflow(page, "Weekly report")
  // Only such an account is connected: the no-provider state, with the reason.
  await expect(page.getByTestId("chat-blocked")).toBeVisible()
  await expect(page.getByTestId("chat-blocked-reason")).toHaveText(
    "The chat cannot use Codex: the program cannot be locked to text only. Use a model account.",
  )
  await shot(page, "w5-40-chat-unsafe-account")
  await app.close()

  // The same in Korean.
  ;({ app, page } = await launch(userData, { ...env, ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  await expect(page.getByTestId("chat-blocked-reason")).toContainText("채팅에서는 Codex 계정을")
  await shot(page, "w5-41-chat-unsafe-account-ko")
  await app.close()

  // A model account joins: the chat uses it, and the picker does not list the program.
  ;({ app, page } = await launch(userData, env))
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await expect(page.getByTestId("chat-model")).toBeVisible()
  const options = await page.getByTestId("chat-model").locator("option").allTextContents()
  expect(options.length).toBeGreaterThan(0)
  expect(options.some((o) => o.includes("Codex"))).toBe(false)
  await say(page, "hello")
  await expect(page.getByTestId("message").nth(1)).toContainText("You said: hello")
  expect(fake.codexCalls().filter((c) => Array.isArray(c.args))).toHaveLength(0)
  await app.close()
  await mock.close()
})
