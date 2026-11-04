import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The lead answers questions of members (specs 004, 005, 007, 014, 015, 021, 024): a question of a
// member in a part goes to the lead first. The lead answers it, or passes it to the user with a
// reason. While the lead looks, the question is not in "Needs you" and makes no notification, and
// the part reads as Running. The answer of the user wins. The lead answers at most 3 questions for
// a part. An approval never goes to the lead. The setting is in the channel settings.
//
// The stand-in model reads a word in square brackets in the question: [answer], [pass], [slow]
// (answers after 3 seconds), [hang] (does not answer). "ASKS answer pass" in the job makes the
// member ask one question for each word (see mock-provider.ts).

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}

/** The app, a mock provider, three agents and a channel "Shop" with the lead Lia. */
const start = async (env: Record<string, string> = {}) => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const noticeLog = join(userData, "notices.jsonl")
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: noticeLog,
    ROBOT_TEST_UNFOCUSED: "1",
    ...env,
  })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy"]) await createAgent(page, name)
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Shop")
  for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Shop")
  await expect(page.getByTestId("channel-form")).toHaveCount(0)

  /** The notifications of the kind "question": the title is the agent, the body the question. */
  const questionNotices = () =>
    existsSync(noticeLog)
      ? readFileSync(noticeLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { title: string; body: string })
          .filter((n) => n.body.includes("Question"))
      : []
  /** The lines of the channel log that one look writes. */
  const looks = () => {
    try {
      return readFileSync(join(userData, "logs", "channels.log"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.event === "lead_look")
    } catch {
      return []
    }
  }
  /** The requests of the stand-in model that were looks of the lead at a question. */
  const lookRequests = () =>
    mock.requests.filter(
      (r) =>
        r.path === "/v1/chat/completions" &&
        JSON.stringify(r.body).includes("A member asks a question"),
    ).length
  return { app, page, mock, userData, questionNotices, looks, lookRequests }
}

const openToday = async (page: Page) => {
  await page.getByTestId("page-today").click()
  await expect(page.getByTestId("today-page")).toBeVisible()
}
const needsRows = (page: Page) => page.getByTestId("today-group-needs").getByTestId("today-row")
const taskRow = (page: Page) =>
  page.locator("[data-testid=task-row]").filter({ hasText: "Pick the sizes" })

test("the lead answers: Needs you stays empty, no notification, the card and the task view say who answered", async () => {
  test.setTimeout(120_000)
  const { page, userData, looks, lookRequests, questionNotices } = await start()
  await post(page, "split lead ASKS answer")

  // The card shows the answer of the lead with its reason, and offers "Correct".
  await expect(page.getByTestId("lead-answer")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("lead-answer-text")).toHaveText("Yes")
  await expect(page.getByTestId("lead-answered-by")).toHaveText("Answered by Lia")
  await expect(page.getByTestId("lead-reason")).toHaveText("The shop ships to the EU only.")
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await shot(page, "s74-01-answered-by-the-lead")
  // The job ends: one summary.
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })

  // Nothing waited for the user: no row in Needs you, no badge, no notification of a question.
  await openToday(page)
  await expect(page.getByTestId("today-empty")).toHaveText("Nothing waits for you.")
  await expect(page.getByTestId("page-today-badge")).toHaveCount(0)
  expect(questionNotices()).toEqual([])
  expect(lookRequests()).toBe(1)

  // The look wrote one line to the log: the result and the time, and no text.
  await expect.poll(() => looks().length).toBe(1)
  expect(looks()[0]).toMatchObject({ event: "lead_look", result: "answered" })
  expect(typeof looks()[0]?.ms).toBe("number")
  const raw = readFileSync(join(userData, "logs", "channels.log"), "utf8")
  for (const text of ["EU sizes", "Question 1", "The shop ships", "Pick the sizes"])
    expect(raw).not.toContain(text)

  // The task view lists the question and who answered it.
  await page.getByTestId("page-tasks").click()
  await taskRow(page).getByTestId("task-open").click()
  await expect(page.getByTestId("task-question")).toHaveCount(1)
  await expect(page.getByTestId("task-question")).toHaveAttribute("data-by", "lead")
  await expect(page.getByTestId("task-question-by")).toHaveText("Answered by Lia")
  await expect(page.getByTestId("task-question-reason")).toHaveText(
    "The shop ships to the EU only.",
  )
  await shot(page, "s74-02-task-view-questions")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)

  // "Correct" starts a reply to the answer in the message box, with a mention of the member.
  await page.getByTestId("page-chats").click()
  await page.getByTestId("lead-correct").click()
  await expect(page.getByTestId("channel-input")).toHaveValue(/^@Bo\s/)
  await expect(page.getByTestId("channel-input")).toBeFocused()
})

test("the lead looks: the part reads Running, Needs you stays empty, and the answer of the user wins", async () => {
  test.setTimeout(120_000)
  const { page, looks, questionNotices } = await start()
  await post(page, "split lead ASKS slow")

  // The card shows at once with the line of the lead. The user can answer it.
  await expect(page.getByTestId("lead-looks")).toHaveText("Lia looks at it", { timeout: 30_000 })
  await expect(page.getByTestId("ask-card")).toBeVisible()
  await shot(page, "s74-03-lead-looks")
  // The part reads Running, not "Waiting for you" (spec 024); Needs you is empty; no notification.
  await page.getByTestId("page-tasks").click()
  await expect(taskRow(page).getByTestId("task-state")).toHaveText("Running")
  await openToday(page)
  await expect(page.getByTestId("today-empty")).toBeVisible()
  await expect(page.getByTestId("page-today-badge")).toHaveCount(0)
  expect(questionNotices()).toEqual([])

  // The user answers while the lead looks. The answer of the user wins and the look stops.
  await page.getByTestId("page-chats").click()
  await page.getByTestId("ask-choice").filter({ hasText: "No" }).click()
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })
  await expect.poll(() => looks().length).toBe(1)
  expect(looks()[0]).toMatchObject({ event: "lead_look", result: "stopped", why: "user_answer" })
  // The lead would have answered after 3 seconds. Its late answer changes nothing.
  await page.waitForTimeout(3500)
  await expect(page.getByTestId("lead-answer")).toHaveCount(0)
  expect(questionNotices()).toEqual([])
  await page.getByTestId("page-tasks").click()
  await taskRow(page).getByTestId("task-open").click()
  await expect(page.getByTestId("task-question")).toHaveAttribute("data-by", "user")
  await expect(page.getByTestId("task-question-by")).toHaveText("Answered by you")
})

test("the lead passes: the reason on the card, one row in Needs you, one notification", async () => {
  test.setTimeout(120_000)
  const { page, looks, questionNotices } = await start()
  await post(page, "split lead ASKS pass")

  await expect(page.getByTestId("lead-pass")).toHaveText("Lia: A matter of taste.", {
    timeout: 30_000,
  })
  await expect(page.getByTestId("lead-pass")).toHaveAttribute("data-kind", "user_choice")
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await expect(page.getByTestId("lead-answer")).toHaveCount(0)
  await shot(page, "s74-04-passed")
  // The question is in Needs you, with one notification of the kind "question".
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect(page.getByTestId("page-today-badge")).toHaveText("1")
  await expect.poll(() => questionNotices().length).toBe(1)
  expect(questionNotices()[0]).toMatchObject({ title: "Bo" })
  // From the pass on, the part waits for the user, and the task view says who passed it.
  await page.getByTestId("page-tasks").click()
  await expect(taskRow(page).getByTestId("task-state")).toHaveText("Waiting for you")
  await taskRow(page).getByTestId("task-open").click()
  await expect(page.getByTestId("task-question")).toHaveAttribute("data-by", "passed")
  await expect(page.getByTestId("task-question-by")).toHaveText("Passed to you by Lia")
  await expect(page.getByTestId("task-question-reason")).toHaveText("A matter of taste.")
  // Korean: the line has its own text.
  await page.keyboard.press("Escape")
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-general").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await taskRow(page).getByTestId("task-open").click()
  await expect(page.getByTestId("task-question-by")).toHaveText("Lia가 사용자에게 넘겼어요")
  await shot(page, "s74-05-korean")
  await page.keyboard.press("Escape")
  await page.getByTestId("page-chats").click()

  // The user answers it as a normal question. The row and the badge go.
  await page.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })
  await openToday(page)
  await expect(page.getByTestId("today-empty")).toBeVisible()
  expect(questionNotices()).toHaveLength(1)
  await expect.poll(() => looks().length).toBe(1)
  expect(looks()[0]).toMatchObject({ event: "lead_look", result: "passed", kind: "user_choice" })
})

test("after 3 answers in a part the lead looks no more: the fourth question goes to the user", async () => {
  test.setTimeout(120_000)
  const { page, lookRequests, questionNotices } = await start()
  await post(page, "split lead ASKS answer answer answer answer")

  await expect(page.getByTestId("lead-answer")).toHaveCount(3, { timeout: 60_000 })
  // The fourth is a normal question: no line of the lead, no look, a row and a notification.
  const fourth = page.getByTestId("ask-card").filter({ hasText: "Question 4" })
  await expect(fourth).toBeVisible({ timeout: 30_000 })
  await expect(fourth.getByTestId("ask-choice")).toHaveCount(2)
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await expect(page.getByTestId("lead-pass")).toHaveCount(0)
  expect(lookRequests()).toBe(3)
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect.poll(() => questionNotices().length).toBe(1)
  expect(questionNotices()[0]?.body).toContain("Question 4")
  await page.getByTestId("page-chats").click()
  await shot(page, "s74-06-fourth-question")
  await fourth.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })
  expect(lookRequests()).toBe(3)
})

test("an approval never goes to the lead", async () => {
  test.setTimeout(120_000)
  const { page, lookRequests, questionNotices } = await start()
  await post(page, "split lead approval")

  await expect(page.getByTestId("ask-deny")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect(needsRows(page)).toHaveAttribute("data-kind", "approval")
  expect(lookRequests()).toBe(0)
  expect(questionNotices()).toEqual([])
  await page.getByTestId("page-chats").click()
  await page.getByTestId("ask-deny").click()
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })
  expect(lookRequests()).toBe(0)
})

test("a lead that does not answer in 2 minutes passes the question (the time is shortened for the test)", async () => {
  test.setTimeout(120_000)
  const { page, looks, questionNotices } = await start({ ROBOT_TEST_LEAD_LOOK_MS: "2000" })
  await post(page, "split lead ASKS hang")

  await expect(page.getByTestId("lead-looks")).toHaveText("Lia looks at it", { timeout: 30_000 })
  expect(questionNotices()).toEqual([])
  await expect(page.getByTestId("lead-pass")).toHaveText("Lia did not answer in time.", {
    timeout: 30_000,
  })
  await expect(page.getByTestId("lead-pass")).toHaveAttribute("data-kind", "late")
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect.poll(() => questionNotices().length).toBe(1)
  await page.getByTestId("page-chats").click()
  await page.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })
  await expect.poll(() => looks().length).toBe(1)
  expect(looks()[0]).toMatchObject({ event: "lead_look", result: "passed", kind: "late" })
})

test("the setting: off sends the question that is with the lead and every later one to the user; no lead locks it", async () => {
  test.setTimeout(120_000)
  const { page, looks, lookRequests, questionNotices } = await start()

  // On at first, and enabled with a lead.
  await page.getByTestId("channel-settings").click()
  const setting = page.getByTestId("channel-lead-answers")
  await expect(setting).toHaveAttribute("aria-checked", "true")
  await expect(setting).toBeEnabled()
  await expect(page.getByTestId("channel-lead-answers-no-lead")).toHaveCount(0)
  // With no lead the switch is off and locked, with a muted line. It comes back with the lead.
  await page
    .getByTestId("channel-lead")
    .selectOption({ label: "No lead: ask me who takes each job" })
  await expect(setting).toHaveAttribute("aria-checked", "false")
  await expect(setting).toBeDisabled()
  await expect(page.getByTestId("channel-lead-answers-no-lead")).toHaveText(
    "The channel has no lead.",
  )
  await shot(page, "s74-07-setting-no-lead")
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await expect(setting).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-form")).toHaveCount(0)

  // A question is with the lead. The user turns the setting off: the question passes at once.
  await post(page, "split lead ASKS slow")
  await expect(page.getByTestId("lead-looks")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-lead-answers").click()
  await expect(page.getByTestId("channel-lead-answers")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-form")).toHaveCount(0)
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await expect(page.getByTestId("ask-card").getByTestId("ask-choice")).toHaveCount(2)
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect.poll(() => questionNotices().length).toBe(1)
  await page.getByTestId("page-chats").click()
  await expect.poll(() => looks().length).toBe(1)
  expect(looks()[0]).toMatchObject({ event: "lead_look", result: "stopped", why: "setting_off" })
  await page.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })

  // Every later question goes to the user at once: no look at all.
  const before = lookRequests()
  await post(page, "split lead ASKS answer")
  await expect(page.getByTestId("ask-card").filter({ hasText: "Question 1" })).toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect.poll(() => questionNotices().length).toBe(2)
  expect(lookRequests()).toBe(before)
  await page.getByTestId("page-chats").click()
  await page.getByTestId("ask-choice").last().click()
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(2, {
    timeout: 60_000,
  })

  // Turned on again, the next question goes to the lead.
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-lead-answers").click()
  await expect(page.getByTestId("channel-lead-answers")).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("channel-submit").click()
  await post(page, "split lead ASKS answer")
  await expect(page.getByTestId("lead-answer")).toHaveCount(1, { timeout: 30_000 })
  expect(lookRequests()).toBe(before + 1)
})

test("a part that Request changes starts is a part like any other: its question goes to the lead", async () => {
  test.setTimeout(120_000)
  const { page, looks, lookRequests, questionNotices } = await start()

  // "Review parts" is on, so a part that ends waits for the user.
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-review-parts").click()
  await expect(page.getByTestId("channel-review-parts")).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-form")).toHaveCount(0)

  // The lead answers the question of the first part. The part waits in review. The channel now
  // holds the plan of the lead and the reply of Bo: messages of other agents.
  await post(page, "split lead ASKS answer")
  await expect(page.getByTestId("lead-answer")).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId("part-review-bar")).toHaveCount(1, { timeout: 30_000 })
  expect(lookRequests()).toBe(1)

  // "Request changes" starts a new part. It asks one question of its own, and the lead answers it:
  // the messages in the channel do not make the part hold outside content (spec 004, 007).
  await page.getByTestId("part-changes").click()
  await page.getByTestId("changes-text").fill("Check the colours too. ASKS answer")
  await page.getByTestId("changes-send").click()
  await expect(page.getByTestId("changes-dialog")).toHaveCount(0)
  await expect(page.getByTestId("lead-answer")).toHaveCount(2, { timeout: 30_000 })
  await expect(page.getByTestId("lead-answered-by")).toHaveText([
    "Answered by Lia",
    "Answered by Lia",
  ])
  await expect(page.getByTestId("part-review-bar")).toHaveCount(1, { timeout: 30_000 })
  await shot(page, "s74-08-request-changes-answered-by-the-lead")
  expect(lookRequests()).toBe(2)
  expect(questionNotices()).toEqual([])
  await expect.poll(() => looks().length).toBe(2)
  expect(looks().map((l) => l.result)).toEqual(["answered", "answered"])

  // The user accepts the new part: the request ends with one summary.
  await page.getByTestId("part-accept").click()
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })
})
