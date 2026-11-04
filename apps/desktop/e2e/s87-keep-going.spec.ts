import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"

// Slice S87: "Keep going on open steps" (specs 005, 003, 006, 013). A stand-in Claude Code program
// reports a list of steps (the tool TodoWrite) and ends its turn. The app asks it to go on while a
// step is open, up to 8 times, and shows one muted line for each time. The message that asks has
// no row. The tests look at the setting, the lines, the stop rules, the Tasks page, and the same
// screens in Korean.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
const lines = (page: Page) => page.getByTestId("kept-going-line")
const userRows = (page: Page) => page.locator("[data-testid=message][data-author=user]")
const taskRows = (page: Page) => page.getByTestId("task-row")

test("keep going: the setting, the lines, the stop rules, the Tasks page, and Korean", async () => {
  test.setTimeout(300_000)
  const fake = makeFakeRuntimes()
  fake.setClaude({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "tester@example.com",
    plan: "max",
  })
  const userData = freshUserData()
  const noticeLog = join(userData, "notices.jsonl")
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: fake.claude,
    ROBOT_CODEX_BIN: "none",
    // No window has the focus, so a result would show a system notice.
    ROBOT_TEST_UNFOCUSED: "1",
    ROBOT_TEST_NOTIFY_LOG: noticeLog,
  })
  try {
    // The chat column is about 460 px wide with the activity panel open: the tightest case.
    await resizeWindow(app, 1100, 860)
    const turns = () => fake.claudeCalls().filter((c) => "prompt" in c)
    const notices = () =>
      existsSync(noticeLog)
        ? readFileSync(noticeLog, "utf8").trim().split("\n").filter(Boolean).length
        : 0

    // Connect the program and make an agent that runs on it.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-providers").click()
    await page.getByTestId("provider-add").click()
    await expect(page.getByTestId("provider-kind")).toHaveValue("claude_code")
    await page.getByTestId("provider-submit").click()
    await expect(page.getByTestId("provider-status")).toHaveText("Connected")

    // 1. The setting is in General and is on at first. Its text says what it does.
    await page.getByTestId("settings-nav-general").click()
    const setting = page.getByTestId("setting-keep-going")
    await expect(setting).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("settings")).toContainText("Keep going on open steps")
    await expect(page.getByTestId("settings")).toContainText("up to 8 times for one request")
    await setting.scrollIntoViewIfNeeded()
    await shot(page, "s87-01-setting-on")
    await page.getByTestId("settings-close").click()
    await createAgent(page, "Ada")

    // 2. The program leaves two steps open. The app asks it to go on once. It closes both steps.
    // The chat shows one muted line and the one message of the user, and no row for the request.
    const base = turns().length
    await send(page, "PLAN:close fix the bug")
    await settled(page)
    await expect(lines(page)).toHaveCount(1)
    await expect(lines(page)).toHaveText("Kept going (1 of 8)")
    await expect(page.getByTestId("message").last()).toContainText("I fixed part of it.")
    await expect(page.getByTestId("message").last()).toContainText("Both steps are done.")
    await expect(userRows(page)).toHaveCount(1)
    const sent = turns().slice(base)
    expect(sent).toHaveLength(2)
    expect(String(sent[1]?.prompt)).toContain("list of steps still has steps that are not done")
    expect(String(sent[1]?.prompt)).toContain("- Fix the bug")
    expect(String(sent[1]?.prompt)).toContain("- Run the suite")
    expect(String(sent[0]?.prompt)).not.toContain("list of steps still has steps")
    // One task, ended Done once: the first end of a turn that a continuation follows made no notice.
    await expect.poll(notices).toBe(1)
    await shot(page, "s87-02-kept-going-once")

    // The Tasks page lists one task for the whole request, and it is Done.
    await page.getByTestId("page-tasks").click()
    await expect(taskRows(page)).toHaveCount(1)
    await expect(taskRows(page).first()).toHaveAttribute("data-state", "done")
    await shot(page, "s87-03-one-task")
    await page.getByTestId("page-chats").click()

    // 3. The program never changes its list: the app asks once, sees the same list, and stops. The
    // chat shows no line for the stop, and the task is Done.
    const sameBase = turns().length
    await send(page, "PLAN:same try")
    await settled(page)
    await expect(lines(page)).toHaveCount(2)
    expect(turns().length - sameBase).toBe(2)
    await expect(page.getByTestId("message").last()).toContainText("Turn 2 ended.")
    await expect(page.getByTestId("message").last()).not.toContainText("Turn 3 ended.")

    // 4. The program opens a new step at each end: the app asks 8 times and the task ends.
    const growBase = turns().length
    await send(page, "PLAN:grow try")
    await settled(page)
    expect(turns().length - growBase).toBe(9)
    const grown = page.getByTestId("message").last().getByTestId("kept-going-line")
    await expect(grown).toHaveCount(8)
    await expect(grown.first()).toHaveText("Kept going (1 of 8)")
    await expect(grown.last()).toHaveText("Kept going (8 of 8)")
    await expect(page.getByTestId("message").last()).toContainText("Turn 9 ended.")
    await page.getByTestId("message").last().scrollIntoViewIfNeeded()
    await shot(page, "s87-04-eight-times")

    // 5. A reply asks a question and the list has no open step: nothing is sent.
    const doneBase = turns().length
    await send(page, "PLAN:doneask now")
    await settled(page)
    expect(turns().length - doneBase).toBe(1)
    await expect(page.getByTestId("message").last()).toContainText("Shall I continue?")
    await expect(page.getByTestId("message").last().getByTestId("kept-going-line")).toHaveCount(0)

    // 6. The same question with one open step: the go-on message is sent and tells the agent to ask
    // with a question card. The app sends no "yes", and the chat shows no row of the user for it.
    const askBase = turns().length
    const usersBefore = await userRows(page).count()
    await send(page, "PLAN:ask now")
    await settled(page)
    const asked = turns().slice(askBase)
    expect(asked).toHaveLength(2)
    expect(String(asked[1]?.prompt)).toContain("ask with a question card")
    expect(String(asked[1]?.prompt)).toContain("Do not ask in plain text")
    expect(String(asked[1]?.prompt)).not.toMatch(/\byes\b/i)
    await expect(userRows(page)).toHaveCount(usersBefore + 1)
    await expect(page.getByTestId("message").last().getByTestId("kept-going-line")).toHaveCount(1)

    // 7. Open steps and a last line "Blocked: ...": the task ends as Blocked, and nothing is sent.
    const blockedBase = turns().length
    await send(page, "PLAN:blocked now")
    await settled(page)
    expect(turns().length - blockedBase).toBe(1)
    await expect(page.getByTestId("message").last().getByTestId("kept-going-line")).toHaveCount(0)
    await page.getByTestId("page-tasks").click()
    await expect(taskRows(page).filter({ hasText: "PLAN:blocked now" })).toHaveAttribute(
      "data-state",
      "blocked",
    )
    await page.getByTestId("page-chats").click()

    // 8. An agent that reports no list: nothing is sent.
    const plainBase = turns().length
    await send(page, "just say hello")
    await settled(page)
    expect(turns().length - plainBase).toBe(1)
    await expect(page.getByTestId("message").last().getByTestId("kept-going-line")).toHaveCount(0)

    // 9. The setting off: the first end of the turn ends the task. On again: the turn goes on.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-general").click()
    await page.getByTestId("setting-keep-going").click()
    await expect(page.getByTestId("setting-keep-going")).toHaveAttribute("aria-checked", "false")
    await page.getByTestId("setting-keep-going").scrollIntoViewIfNeeded()
    await shot(page, "s87-05-setting-off")
    await page.getByTestId("settings-close").click()
    const offBase = turns().length
    await send(page, "PLAN:close with the setting off")
    await settled(page)
    expect(turns().length - offBase).toBe(1)
    await expect(page.getByTestId("message").last().getByTestId("kept-going-line")).toHaveCount(0)
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-general").click()
    await page.getByTestId("setting-keep-going").click()
    await expect(page.getByTestId("setting-keep-going")).toHaveAttribute("aria-checked", "true")
    await page.getByTestId("settings-close").click()
    const onBase = turns().length
    await send(page, "PLAN:close with the setting on")
    await settled(page)
    expect(turns().length - onBase).toBe(2)
    await expect(page.getByTestId("message").last().getByTestId("kept-going-line")).toHaveCount(1)

    // 10. A narrow window: the line stays on one row and the name of the agent stays whole.
    await resizeWindow(app, 720, 800)
    await page.getByTestId("message").last().scrollIntoViewIfNeeded()
    await expect(page.getByTestId("chat-header-agent")).toContainText("Ada")
    await shot(page, "s87-06-narrow")
    await resizeWindow(app, 1100, 860)

    // 11. The same in Korean: the line keeps its numbers, and the setting has Korean text.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-general").click()
    await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
    await expect(page.getByTestId("settings")).toContainText("열린 단계가 있으면 이어서 진행")
    await page.getByTestId("setting-keep-going").scrollIntoViewIfNeeded()
    await shot(page, "s87-07-setting-ko")
    await page.getByTestId("settings-close").click()
    await expect(lines(page).last()).toHaveText("이어서 진행했어요 (1/8)")
    await page.getByTestId("message").last().scrollIntoViewIfNeeded()
    await shot(page, "s87-08-line-ko")
  } finally {
    await app.close()
  }
})
