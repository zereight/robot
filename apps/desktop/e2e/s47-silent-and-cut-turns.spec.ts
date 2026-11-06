import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type ElectronApplication, expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Silent and cut turns (specs 003, 005, 006, 013): the silent limit, how far a turn went, the
// notice after a restart, and the programs that a crashed run leaves behind.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page, timeout = 15_000) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, { timeout })
const place = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`).click()

/** The app ends with no warning, as after a crash. */
const crash = async (app: ElectronApplication) => {
  const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()))
  app.process().kill("SIGKILL")
  await exited
}

test("a silent turn stops at the silent limit, and the failed row tells how far it went", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const log = join(userData, "notices.jsonl")
  const env = {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: log,
    ROBOT_TEST_UNFOCUSED: "1",
  }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const notices = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { title: string; body: string })
      : []

  // The silent limit is in General. It is 10 minutes at first; the choice is 1 minute here.
  await page.getByTestId("open-settings").click()
  const limit = page.getByTestId("setting-silent-limit")
  await expect(limit.locator("label")).toHaveText([
    "1 min",
    "5 min",
    "10 min",
    "30 min",
    "60 min",
    "Never",
  ])
  await expect(limit.locator("input:checked")).toHaveValue("10")
  await shot(page, "s47-01-setting")
  await limit.locator('label[data-value="1"]').click()
  await expect(limit.locator("input:checked")).toHaveValue("1")
  await page.getByTestId("settings-close").click()

  // The model opens the answer and sends nothing. The turn stops at about 60 seconds.
  await send(page, "go silent please")
  await expect(page.getByTestId("working-line")).toBeVisible()
  const began = Date.now()
  await expect(page.getByTestId("failed-row")).toBeVisible({ timeout: 90_000 })
  const waited = Date.now() - began
  expect(waited).toBeGreaterThan(55_000)
  expect(waited).toBeLessThan(85_000)
  await expect(page.getByTestId("failed-row")).toContainText("No answer for 1 minute.")
  // The request reached the model and nothing came back: the line for "sent", beside Retry.
  await expect(page.getByTestId("failed-row").getByTestId("progress-line")).toHaveText(
    "The model may have started. Check the workspace before you try again.",
  )
  await expect(page.getByTestId("retry")).toBeVisible()
  await shot(page, "s47-02-silent-failed")
  expect(mock.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(1)
  // One notification of the kind "task failed".
  await expect.poll(() => notices().filter((n) => n.body.includes("go silent")).length).toBe(1)

  // The task page shows the same reason and the same line.
  await page.getByTestId("page-tasks").click()
  await expect(page.locator("[data-testid=task-row][data-state=failed]")).toHaveCount(1)
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-error")).toHaveText("No answer for 1 minute.")
  await expect(page.getByTestId("task-progress-line")).toHaveAttribute("data-progress", "sent")
  await expect(page.getByTestId("task-progress-line")).toHaveText(
    "The model may have started. Check the workspace before you try again.",
  )
  await shot(page, "s47-03-task-detail")

  // Korean.
  await page.keyboard.press("Escape")
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await expect(page.getByTestId("setting-silent-limit").locator("label").last()).toHaveText("안 함")
  await page.getByTestId("settings-close").click()
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-error")).toHaveText("1분 동안 답이 없어요.")
  await expect(page.getByTestId("task-progress-line")).toHaveText(
    "모델이 작업을 시작했을 수 있어요. 다시 시도하기 전에 작업 공간을 확인해 주세요.",
  )
  await page.keyboard.press("Escape")
  await page.getByTestId("page-chats").click()
  await expect(page.getByTestId("failed-row")).toContainText("1분 동안 답이 없어요.")

  // Retry makes a new task, which runs. The first task keeps its line.
  await page.getByTestId("retry").click()
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await page.getByTestId("composer-stop").click()
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("task-row")).toHaveCount(2)
  await expect(page.locator("[data-testid=task-row][data-state=failed]")).toHaveCount(1)
  await page.locator("[data-testid=task-row][data-state=failed]").getByTestId("task-open").click()
  await expect(page.getByTestId("task-progress-line")).toHaveAttribute("data-progress", "sent")
  await page.keyboard.press("Escape")

  await app.close()
  await mock.close()
})

test("a restart cuts a request: Send again when it never reached the model, Continue when it did", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Ada works in a thread. A thread is another place, so the main chat of Ada is free.
  const serverId = (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id
  const agentId = (
    await rpc<{ id: string; name: string }[]>(page, "agents.list", { serverId, archived: false })
  ).find((a) => a.name === "Ada")?.id
  const thread = await rpc<{ id: string }>(page, "chat.thread.create", { agentId })
  await rpc(page, "chat.send", { agentId, threadId: thread.id, text: "run long", replyTo: null })
  // The request reaches the model and the reply starts to stream.
  await expect
    .poll(() =>
      mock.requests.some(
        (r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body).includes("run long"),
      ),
    )
    .toBe(true)
  await page.waitForTimeout(1_000)

  // The user writes to Ada in the chat. The task waits, since an agent runs one task at a time.
  await place(page, "Ada")
  await send(page, "hello there")
  await page.getByTestId("page-tasks").click()
  await expect(page.locator("[data-testid=task-row][data-state=queued]")).toHaveCount(1)
  await expect(page.locator("[data-testid=task-row][data-state=running]")).toHaveCount(1)

  // The app ends at once. After the restart the request had not reached the model.
  await crash(app)
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 860)
  await place(page, "Ada")
  const notice = page.getByTestId("restart-notice")
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute("data-progress", "not_sent")
  await expect(notice.getByTestId("progress-line")).toHaveText(
    "The request did not reach the model. It is safe to try again.",
  )
  await expect(page.getByTestId("restart-send-again")).toBeVisible()
  await expect(page.getByTestId("restart-continue")).toHaveCount(0)
  await shot(page, "s47-04-send-again")

  // The tasks page tells how far each one went: the work in the thread had started.
  await page.getByTestId("page-tasks").click()
  await expect(page.locator("[data-testid=task-row][data-state=failed]")).toHaveCount(2)
  const rowOf = (text: string) =>
    page.locator("[data-testid=task-row][data-state=failed]").filter({ hasText: text })
  await rowOf("run long").getByTestId("task-open").click()
  await expect(page.getByTestId("task-error")).toHaveText("The app stopped.")
  await expect(page.getByTestId("task-progress-line")).toHaveAttribute("data-progress", "started")
  await expect(page.getByTestId("task-progress-line")).toContainText(
    "The agent had started to work. Some steps may have run.",
  )
  await page.keyboard.press("Escape")
  await rowOf("hello there").getByTestId("task-open").click()
  await expect(page.getByTestId("task-progress-line")).toHaveAttribute("data-progress", "not_sent")
  await page.keyboard.press("Escape")

  // Send again: the same request goes out, once, and the agent answers it.
  await page.getByTestId("page-chats").click()
  await expect(page.getByTestId("restart-send-again")).toBeVisible()
  await page.getByTestId("restart-send-again").click()
  await expect(page.getByTestId("restart-notice")).toHaveCount(0)
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("You said: hello there")
  await expect(page.getByTestId("message")).toHaveCount(2)
  // The new task runs and links to the one that the restart ended; the old one keeps its line.
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("task-row")).toHaveCount(3)
  await expect(page.locator("[data-testid=task-row][data-state=done]")).toHaveCount(1)
  await page.getByTestId("page-chats").click()

  // A reply that began to stream is cut off by a second crash. Now the request reached the model.
  await send(page, "run long")
  await expect(page.getByTestId("message").last()).toContainText("w3", { timeout: 15_000 })
  await crash(app)
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 860)
  await place(page, "Ada")
  await expect(page.getByTestId("restart-notice")).toHaveAttribute("data-progress", "started")
  await expect(page.getByTestId("restart-send-again")).toHaveCount(0)
  await expect(page.getByTestId("restart-notice").getByTestId("progress-line")).toContainText(
    "The agent had started to work.",
  )
  await shot(page, "s47-05-continue")

  // Korean.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("restart-notice")).toContainText(
    "앱이 다시 시작되면서 마지막 요청이 멈췄어요.",
  )
  await expect(page.getByTestId("restart-continue")).toHaveText("이어서 하기")
  await shot(page, "s47-06-continue-korean")

  // Continue sends a short new message. The old request is not sent again.
  const before = mock.requests.filter((r) => r.path === "/v1/chat/completions").length
  await page.getByTestId("restart-continue").click()
  await expect(page.getByTestId("restart-notice")).toHaveCount(0)
  await settled(page)
  await expect(page.getByTestId("message").nth(-2)).toContainText("하던 일을 이어서 해 주세요.")
  const asked = mock.requests
    .filter((r) => r.path === "/v1/chat/completions")
    .slice(before)
    .map((r) => (r.body as { messages: { content: string }[] }).messages.at(-1)?.content)
  expect(asked).toEqual(["하던 일을 이어서 해 주세요."])

  await app.close()
  await mock.close()
})

const running = (pid: number) => {
  try {
    // A process that ended and was not collected yet is not running.
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
    return state.trim() !== "" && !state.trim().startsWith("Z")
  } catch {
    return false
  }
}

test("a program left by a crashed run is ended at the next start; the program of the user stays", async () => {
  test.skip(process.platform === "win32", "the stand-in programs need a shell")
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const fake = makeFakeRuntimes()
  // The stand-in program stays up when the app is gone, as a program can.
  fake.setClaude({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "tester@example.com",
    plan: "max",
    survive: true,
  })
  const userData = freshUserData()
  const env = {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: fake.claude,
    ROBOT_CODEX_BIN: "none",
  }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  // A Claude Code account and an agent on it.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("claude_code")
  await page.getByTestId("provider-name").fill("Claude")
  await expect(page.getByTestId("runtime-status")).toHaveText("Signed in as tester@example.com.")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status").last()).toHaveText("Connected")
  await page.getByTestId("settings-close").click()
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill("Cody")
  await page.getByTestId("model-account").selectOption({ label: "Claude" })
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: "Cody" }).waitFor()

  // A turn starts the program, which streams a part and then waits for a minute.
  await send(page, "SLOW work")
  await expect(page.getByTestId("message").last()).toContainText("Thinking slowly", {
    timeout: 20_000,
  })
  const turn = fake.claudeCalls().find((c) => String(c.prompt).includes("SLOW"))
  const pid = Number(turn?.pid)
  expect(pid).toBeGreaterThan(1)
  expect(running(pid)).toBe(true)

  // The app ends with no warning, and the program is left behind.
  await crash(app)
  expect(running(pid)).toBe(true)
  // The user started a program with the same name by hand. It reads its input, so it stays up.
  const theirs: ChildProcess = spawn("node", [join(fake.dir, "claude.mjs")], {
    stdio: ["pipe", "ignore", "ignore"],
  })
  try {
    const theirPid = theirs.pid as number
    expect(running(theirPid)).toBe(true)

    // From now on the program does not answer its check.
    fake.setClaude({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "tester@example.com",
      plan: "max",
      hang: true,
    })
    ;({ app, page } = await launch(userData, env))
    await resizeWindow(app, 1300, 860)

    // The program of the crashed run is ended; the program of the user is not.
    await expect.poll(() => running(pid), { timeout: 30_000 }).toBe(false)
    expect(running(theirPid)).toBe(true)

    // The check of the program never ends, and a chat with an API agent answers with no delay.
    await place(page, "Ada")
    const asked = Date.now()
    await send(page, "hello after the crash")
    await expect(page.getByTestId("message").last()).toContainText(
      "You said: hello after the crash",
      {
        timeout: 5000,
      },
    )
    expect(Date.now() - asked).toBeLessThan(5000)

    // The cut request of Cody shows its notice, with the line for a turn that had started.
    await place(page, "Cody")
    await expect(page.getByTestId("restart-notice")).toHaveAttribute("data-progress", "started")
    await expect(page.getByTestId("restart-continue")).toBeVisible()
    await shot(page, "s47-07-leftover")
    await app.close()
  } finally {
    theirs.kill("SIGKILL")
    await mock.close()
  }
})
