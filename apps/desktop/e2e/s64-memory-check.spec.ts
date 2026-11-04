import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// S64: the memory check (spec 008, 005, 012, 019). The model is a stand-in that records each request.
// The check suggests one fact for every "REMEMBER: <fact>" that the user wrote. The window is 1100 px
// wide with the activity panel open, which is the tightest layout. Every scenario runs once in English
// and once in Korean.

interface Words {
  readonly locale: "en-US" | "ko-KR"
  readonly shots: "en" | "ko"
  readonly label: string
  readonly tabItems: string
  readonly tabProposals: string
  /** The line of "Done turns since the last check", for a count. */
  readonly count: (n: number) => string
  readonly noTurn: string
  readonly fromCheck: string
  readonly source: string
  readonly claudeLine: string
}
const EN: Words = {
  locale: "en-US",
  shots: "en",
  label: "Memory check",
  tabItems: "Items",
  tabProposals: "Proposals",
  count: (n) => `Done turns since the last check: ${n} of 10`,
  noTurn: "No turn has ended since the last check.",
  fromCheck: "From a memory check",
  source: "Memory check",
  claudeLine: "Claude Code cannot use the memory check.",
}
const KO: Words = {
  locale: "ko-KR",
  shots: "ko",
  label: "메모리 점검",
  tabItems: "항목",
  tabProposals: "제안",
  count: (n) => `지난 점검 이후 완료된 턴: 10번 중 ${n}번`,
  noTurn: "지난 점검 이후 끝난 턴이 없어요.",
  fromCheck: "출처: 메모리 점검",
  source: "메모리 점검",
  claudeLine: "Claude Code는 메모리 점검을 쓸 수 없어요.",
}

const AGENT_MESSAGES = "[data-testid=message][data-author=agent]"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
/** Sends a message and waits until the agent has answered it. */
const say = async (page: Page, text: string) => {
  const before = await page.locator(AGENT_MESSAGES).count()
  await send(page, text)
  await expect(page.locator(AGENT_MESSAGES)).toHaveCount(before + 1, { timeout: 15_000 })
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
}

const openProfile = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("memory-panel")).toBeVisible()
}
const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}
const tab = (page: Page, name: string) => page.getByTestId("memory-tabs").getByText(name)
/** The windows of the memory page that the screenshot shows: the choice is near the top. */
const lookAtCheck = (page: Page) =>
  page.getByTestId("memory-check").evaluate((el) => el.scrollIntoView({ block: "center" }))

/** What the stand-in model got from the memory check, request by request. */
const checkRequests = (mock: Awaited<ReturnType<typeof startMockProvider>>) =>
  mock.requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map(
      (r) =>
        r.body as {
          messages: { role: string; content: string }[]
          tools?: { function?: { name?: string } }[]
        },
    )
    .filter((b) => String(b.messages[0]?.content ?? "").startsWith("You look back at recent turns"))

const scenario = (words: Words) => async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: words.locale })
  try {
    await resizeWindow(app, 1100, 800)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await expect(page.getByTestId("activity-panel")).toBeVisible()

    // ---- the choice: off at the start, with its text; no count and no "Check now" yet ----
    await openProfile(page)
    await expect(page.getByTestId("memory-check")).toContainText(words.label)
    await expect(page.getByTestId("memory-check-switch")).toHaveAttribute("aria-checked", "false")
    await expect(page.getByTestId("memory-check-hint")).toBeVisible()
    await expect(page.getByTestId("memory-check-count")).toHaveCount(0)
    await expect(page.getByTestId("memory-check-now")).toHaveCount(0)
    await lookAtCheck(page)
    await shot(page, `s64-01-choice-off-${words.shots}`)

    // ---- on: the count is 0 and "Check now" is off, with the reason ----
    await page.getByTestId("memory-check-switch").click()
    await expect(page.getByTestId("memory-check-switch")).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("memory-check-count")).toHaveText(words.count(0))
    await expect(page.getByTestId("memory-check-now")).toBeDisabled()
    await expect(page.getByTestId("memory-check-now-reason")).toHaveText(words.noTurn)
    await lookAtCheck(page)
    await shot(page, `s64-02-choice-on-${words.shots}`)
    await closeProfile(page)

    // ---- three done turns, one with a fact in it: the count is 3 and "Check now" is on ----
    await say(page, "Message 1 about editors. REMEMBER: Prefers tabs over spaces")
    await say(page, "Message 2 about lunch")
    await say(page, "Message 3 about trains")
    await openProfile(page)
    await expect(page.getByTestId("memory-check-count")).toHaveText(words.count(3))
    await expect(page.getByTestId("memory-check-now")).toBeEnabled()
    await expect(page.getByTestId("memory-check-now-reason")).toHaveCount(0)
    await lookAtCheck(page)
    await shot(page, `s64-03-count-${words.shots}`)

    // ---- Check now: a check runs at once; the count goes to 0; the fact is a proposal ----
    await page.getByTestId("memory-check-now").click()
    await expect(page.getByTestId("memory-tabs")).toContainText("(1)")
    await expect(page.getByTestId("memory-check-count")).toHaveText(words.count(0))
    await expect(page.getByTestId("memory-check-now")).toBeDisabled()
    await expect(page.getByTestId("memory-check-now-reason")).toHaveText(words.noTurn)
    // The check posted no message: the chat holds three replies.
    await expect(page.locator(AGENT_MESSAGES)).toHaveCount(3)
    await tab(page, words.tabProposals).click()
    await expect(page.getByTestId("memory-proposal")).toHaveCount(1)
    await expect(page.getByTestId("memory-proposal")).toContainText("Prefers tabs over spaces")
    await expect(page.getByTestId("memory-proposal-meta")).toContainText(words.fromCheck)
    await shot(page, `s64-04-proposal-from-check-${words.shots}`)
    // No item and no history row: a proposal is not memory.
    await tab(page, words.tabItems).click()
    await expect(page.getByTestId("memory-item")).toHaveCount(0)

    // ---- the request that the check made: one tool, the words of the user, no tool output ----
    {
      const requests = checkRequests(mock)
      expect(requests.length).toBeGreaterThan(0)
      const first = requests[0]
      expect((first?.tools ?? []).map((t) => t.function?.name)).toEqual(["suggest_memory"])
      const asked = String(first?.messages.at(-1)?.content ?? "")
      expect(asked).toContain("User: Message 1 about editors. REMEMBER: Prefers tabs over spaces")
      expect(asked).toContain("Assistant: Hello! You said:")
      // The newest turn comes first.
      expect(asked.indexOf("Message 3 about trains")).toBeLessThan(
        asked.indexOf("Message 1 about editors"),
      )
    }

    // ---- Tasks page: a task with the source "memory check" ----
    await closeProfile(page)
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-source").selectOption("memory_check")
    const rows = page.getByTestId("task-row")
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(words.source)
    await expect(rows.first().getByTestId("task-open")).toHaveText(words.label)
    await expect(rows.first().getByTestId("task-state")).toHaveAttribute("data-state", "done")
    await shot(page, `s64-05-tasks-${words.shots}`)
    await rows.first().getByTestId("task-open").click()
    await expect(page.getByTestId("task-detail")).toContainText(words.source)
    await expect(page.getByTestId("task-usage-input")).toHaveText("200")
    await shot(page, `s64-06-task-detail-${words.shots}`)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("task-detail")).toHaveCount(0)

    // ---- Save the proposal: it is an item now, and the next check reads it ----
    await page.locator('[data-place-row][data-place-name="Ada"]').click()
    await openProfile(page)
    await tab(page, words.tabProposals).click()
    await page.getByTestId("proposal-save").click()
    await expect(page.getByTestId("memory-proposal")).toHaveCount(0)
    await tab(page, words.tabItems).click()
    await expect(page.getByTestId("memory-item")).toHaveCount(1)
    await closeProfile(page)

    // ---- the automatic check: after 10 done turns, with the choice on and "Save at once" ----
    await say(page, "Message 4 about gardens. REMEMBER: Lives in Busan")
    await say(page, "Message 5 about music")
    await say(page, "Message 6 about books. REMEMBER: Works at Acme")
    for (let n = 7; n <= 12; n++) await say(page, `Message ${n} about travel`)
    await openProfile(page)
    await expect(page.getByTestId("memory-check-count")).toHaveText(words.count(9))
    await closeProfile(page)
    const requestsBefore = checkRequests(mock).length
    await say(page, "Message 13 about weather")
    // The tenth turn adds a check: a second task with the source, and two proposals.
    await openProfile(page)
    await expect(page.getByTestId("memory-tabs")).toContainText("(2)")
    await expect(page.getByTestId("memory-check-count")).toHaveText(words.count(0))
    await tab(page, words.tabProposals).click()
    await expect(page.getByTestId("memory-proposal")).toHaveCount(2)
    // The request lists the newest turn first, so the model suggests the newest fact first.
    await expect(page.getByTestId("memory-proposal").nth(0)).toContainText("Works at Acme")
    await expect(page.getByTestId("memory-proposal").nth(1)).toContainText("Lives in Busan")
    await expect(page.getByTestId("memory-proposal-meta").nth(0)).toContainText(words.fromCheck)
    await expect(page.getByTestId("memory-proposal-meta").nth(1)).toContainText(words.fromCheck)
    await shot(page, `s64-07-two-proposals-${words.shots}`)
    // No item was made: the one item is the one that the user saved.
    await tab(page, words.tabItems).click()
    await expect(page.getByTestId("memory-item")).toHaveCount(1)
    {
      const requests = checkRequests(mock).slice(requestsBefore)
      expect(requests.length).toBeGreaterThan(0)
      const asked = String(requests[0]?.messages.at(-1)?.content ?? "")
      // It reads the items of the agent, and the turns since the last check only.
      expect(asked).toContain("Saved memory items:\n- Prefers tabs over spaces")
      expect(asked).not.toContain("Message 3 about trains")
      expect(asked).toContain("Message 13 about weather")
      expect(asked.indexOf("Message 13 about weather")).toBeLessThan(
        asked.indexOf("Message 4 about gardens"),
      )
    }
    // The count of the next 10 starts at 0. The chat holds 13 replies and no line of the check.
    await closeProfile(page)
    await expect(page.locator(AGENT_MESSAGES)).toHaveCount(13)

    // ---- Tasks page: two checks now ----
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-source").selectOption("memory_check")
    await expect(page.getByTestId("task-row")).toHaveCount(2)
    await expect(page.locator("[data-testid=task-state][data-state=done]")).toHaveCount(2)
    await shot(page, `s64-08-tasks-two-${words.shots}`)

    // ---- Usage page: the tokens of the checks count, and a check is no reply ----
    await page.getByTestId("page-usage").click()
    // 13 replies of 20 and 10 tokens, and two checks of two requests, 100 and 10 tokens each.
    await expect(page.getByTestId("usage-total-replies")).toHaveText("13")
    await expect(page.getByTestId("usage-total-input")).toHaveText("660")
    await expect(page.getByTestId("usage-total-output")).toHaveText("170")
    await shot(page, `s64-09-usage-${words.shots}`)
  } finally {
    await app.close()
    await mock.close()
  }
}

test(
  "memory check, in English: the choice, the count, Check now, the automatic check, tasks and usage",
  scenario(EN),
)
test(
  "memory check, in Korean: the choice, the count, Check now, the automatic check, tasks and usage",
  scenario(KO),
)

// ---- An agent on a vendor runtime: the choice is off, with the muted line (spec 006, 008) ----

const runtimeScenario = (words: Words) => async () => {
  test.skip(process.platform === "win32", "the stand-in programs need a shell")
  test.setTimeout(180_000)
  const fake = makeFakeRuntimes()
  fake.setClaude({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "tester@example.com",
    plan: "max",
  })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: words.locale,
    ROBOT_CLAUDE_BIN: fake.claude,
    ROBOT_CODEX_BIN: "none",
  })
  try {
    await resizeWindow(app, 1100, 800)
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-providers").click()
    await page.getByTestId("provider-add").click()
    await expect(page.getByTestId("provider-kind")).toHaveValue("claude_code")
    await page.getByTestId("provider-submit").click()
    await page.getByTestId("provider-status").last().waitFor()
    await page.getByTestId("settings-close").click()
    await createAgent(page, "Rex")
    await openProfile(page)
    await expect(page.getByTestId("memory-check")).toContainText(words.label)
    await expect(page.getByTestId("memory-check-runtime")).toHaveText(words.claudeLine)
    await expect(page.getByTestId("memory-check-switch")).toHaveAttribute("aria-checked", "false")
    await expect(page.getByTestId("memory-check-switch")).toBeDisabled()
    await expect(page.getByTestId("memory-check-count")).toHaveCount(0)
    await expect(page.getByTestId("memory-check-now")).toHaveCount(0)
    await lookAtCheck(page)
    await shot(page, `s64-10-runtime-${words.shots}`)
  } finally {
    await app.close()
  }
}

test("memory check, in English: an agent on a vendor runtime cannot use it", runtimeScenario(EN))
test("memory check, in Korean: an agent on a vendor runtime cannot use it", runtimeScenario(KO))
