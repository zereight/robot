import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Ask up the line (spec 030, "Ask up the line"; specs 004, 005, 014, 015, 021, 024): when the
// switch in the settings part "Organization" is on, a question that the lead passes goes to the
// lead of each higher channel and then to the main agent, before it goes to the user.
//
// The channels: "Product" with the lead Pia, and its sub-channel "Docs" with the lead Dee and the
// member Bo. Max is the main agent. Bo asks, Dee is the lead of its part.
//
// The stand-in model reads a word in square brackets in the question (see mock-provider.ts):
// [upN] every agent before the place N passes with "Not sure" and the agent at place N answers
// (place 0 is the lead, 1 is Pia, 2 is Max); [lateN] the agents at the places 1 to N do not
// answer; [userN] the agent at place N says that only the user can choose.

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}

const start = async (env: Record<string, string> = {}, on = true) => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const noticeLog = join(userData, "notices.jsonl")
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: noticeLog,
    ROBOT_TEST_UNFOCUSED: "1",
    ROBOT_TEST_MAIN_AGENT: "Max",
    ...env,
  })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Dee", "Bo", "Pia", "Max"]) await createAgent(page, name)
  const server = (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find(
    (s) => s.kind === "local",
  )?.id as string
  const agents = await rpc<{ id: string; name: string }[]>(page, "agents.list", {
    serverId: server,
    archived: false,
  })
  const id = (name: string) => agents.find((a) => a.name === name)?.id as string
  const product = await rpc<{ id: string }>(page, "channels.create", {
    serverId: server,
    name: "Product",
    topic: "",
    memberIds: [id("Pia")],
    leadId: id("Pia"),
  })
  const docs = await rpc<{ id: string }>(page, "channels.create", {
    serverId: server,
    name: "Docs",
    topic: "",
    memberIds: [id("Dee"), id("Bo")],
    leadId: id("Dee"),
    parentId: product.id,
  })
  if (on) await rpc(page, "organization.setAskUpTheLine", { on: true })
  await page.getByTestId("page-chats").click()
  await page.getByTestId(`place-channel-${docs.id}`).click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Docs")

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
  /** The lines of the channel log that the looks write: the lead (lead_look), the line (line_look). */
  const looks = () => {
    try {
      return readFileSync(join(userData, "logs", "channels.log"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.event === "lead_look" || l.event === "line_look")
    } catch {
      return []
    }
  }
  return { app, page, mock, userData, server, questionNotices, looks }
}

const openToday = async (page: Page) => {
  await page.getByTestId("page-today").click()
  await expect(page.getByTestId("today-page")).toBeVisible()
}
const needsRows = (page: Page) => page.getByTestId("today-group-needs").getByTestId("today-row")
const taskRow = (page: Page) =>
  page.locator("[data-testid=task-row]").filter({ hasText: "Pick the sizes" })
const summaries = (page: Page) => page.locator("[data-testid=channel-message][data-kind=summary]")

test("the lead passes, Pia answers: the card shows the pass and who answered, Needs you stays empty", async () => {
  test.setTimeout(150_000)
  const { page, server, looks, questionNotices } = await start()
  await post(page, "split lead ASKS up1")

  await expect(page.getByTestId("lead-answer")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("lead-answered-by")).toHaveText("Answered by Pia")
  await expect(page.getByTestId("lead-reason")).toHaveText("Answered at 1.")
  // The pass of the lead stays on the card, with its reason.
  await expect(page.getByTestId("lead-pass")).toHaveCount(1)
  await expect(page.getByTestId("lead-pass")).toHaveText("Dee: Not sure at 0.")
  await expect(page.getByTestId("lead-pass")).toHaveAttribute("data-kind", "not_sure")
  await shot(page, "s111-01-answered-by-pia")
  await expect(summaries(page)).toHaveCount(1, { timeout: 60_000 })

  // Nothing waited for the user: no row in Needs you, no badge, no notification.
  await openToday(page)
  await expect(page.getByTestId("today-empty")).toBeVisible()
  await expect(page.getByTestId("page-today-badge")).toHaveCount(0)
  expect(questionNotices()).toEqual([])

  // Each look wrote one line: the lead as before, the agent of the line with its place.
  await expect.poll(() => looks().length).toBe(2)
  expect(looks()[0]).toMatchObject({ event: "lead_look", result: "passed", kind: "not_sure" })
  expect(looks()[1]).toMatchObject({ event: "line_look", place: 1, result: "answered" })

  // The look of Pia is a short task with the source "question"; the part itself is Done.
  const list = await rpc<{ source: string }[]>(page, "tasks.list", { serverId: server })
  expect(list.filter((t) => t.source === "question")).toHaveLength(1)
})

test("Pia passes, Max answers: both passes show; Max passes too, and the user gets all three lines", async () => {
  test.setTimeout(180_000)
  const first = await start()
  await post(first.page, "split lead ASKS up2")
  await expect(first.page.getByTestId("lead-answered-by")).toHaveText("Answered by Max", {
    timeout: 60_000,
  })
  await expect(first.page.getByTestId("lead-pass")).toHaveText([
    "Dee: Not sure at 0.",
    "Pia: Not sure at 1.",
  ])
  await expect(summaries(first.page)).toHaveCount(1, { timeout: 60_000 })
  await expect.poll(() => first.looks().length).toBe(3)
  expect(first.looks().map((l) => [l.event, l.place ?? 0, l.result])).toEqual([
    ["lead_look", 0, "passed"],
    ["line_look", 1, "passed"],
    ["line_look", 2, "answered"],
  ])
  expect(first.questionNotices()).toEqual([])
  await first.app.close()

  // Nobody on the line answers: the user gets the question with three pass lines and one
  // notification (the line is at the place 3, where nobody is).
  const second = await start()
  await post(second.page, "split lead ASKS up3")
  const card = second.page.getByTestId("ask-card")
  await expect(card.getByTestId("ask-choice")).toHaveCount(2, { timeout: 60_000 })
  await expect(card.getByTestId("lead-pass")).toHaveCount(3)
  await expect(card.getByTestId("lead-pass")).toHaveText([
    "Dee: Not sure at 0.",
    "Pia: Not sure at 1.",
    "Max: Not sure at 2.",
  ])
  await expect(card.getByTestId("lead-looks")).toHaveCount(0)
  await shot(second.page, "s111-02-all-passed")
  await openToday(second.page)
  await expect(needsRows(second.page)).toHaveCount(1)
  await expect(second.page.getByTestId("page-today-badge")).toHaveText("1")
  await expect.poll(() => second.questionNotices().length).toBe(1)
  await expect.poll(() => second.looks().length).toBe(3)
  // The question is a normal question now: the user answers it, and the part goes on.
  await second.page.getByTestId("page-chats").click()
  await second.page.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(summaries(second.page)).toHaveCount(1, { timeout: 60_000 })
  await openToday(second.page)
  await expect(second.page.getByTestId("today-empty")).toBeVisible()
  await second.app.close()
})

test("while Pia looks: the card says so, Needs you is empty, the part reads Running, and the user wins", async () => {
  test.setTimeout(150_000)
  const { page, looks, questionNotices } = await start()
  await post(page, "split lead ASKS up1slow")

  await expect(page.getByTestId("lead-looks")).toHaveText("Pia looks at it", { timeout: 60_000 })
  await expect(page.getByTestId("lead-pass")).toHaveText("Dee: Not sure at 0.")
  await expect(page.getByTestId("ask-card")).toBeVisible()
  await shot(page, "s111-03-pia-looks")
  await page.getByTestId("page-tasks").click()
  await expect(taskRow(page).getByTestId("task-state")).toHaveText("Running")
  await openToday(page)
  await expect(page.getByTestId("today-empty")).toBeVisible()
  await expect(page.getByTestId("page-today-badge")).toHaveCount(0)
  expect(questionNotices()).toEqual([])

  // The user answers while Pia looks. The answer of the user wins and the look stops.
  await page.getByTestId("page-chats").click()
  await page.getByTestId("ask-choice").filter({ hasText: "No" }).click()
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect(summaries(page)).toHaveCount(1, { timeout: 60_000 })
  await expect.poll(() => looks().length).toBe(2)
  expect(looks()[1]).toMatchObject({
    event: "line_look",
    place: 1,
    result: "stopped",
    why: "user_answer",
  })
  // Pia would have answered after 3 seconds. The late answer changes nothing.
  await page.waitForTimeout(3500)
  await expect(page.getByTestId("lead-answer")).toHaveCount(0)
  expect(questionNotices()).toEqual([])
  await page.getByTestId("page-tasks").click()
  await taskRow(page).getByTestId("task-open").click()
  await expect(page.getByTestId("task-question")).toHaveAttribute("data-by", "user")
  await expect(page.getByTestId("task-question-by")).toHaveText("Answered by you")
})

test("the lead says that only the user can choose: the question goes to the user at once, Pia does not look", async () => {
  test.setTimeout(150_000)
  const { page, mock, looks, questionNotices } = await start()
  await post(page, "split lead ASKS user0")

  const card = page.getByTestId("ask-card")
  await expect(card.getByTestId("ask-choice")).toHaveCount(2, { timeout: 60_000 })
  await expect(card.getByTestId("lead-pass")).toHaveText("Dee: Not sure at 0.")
  await expect(card.getByTestId("lead-pass")).toHaveAttribute("data-kind", "user_choice")
  await expect(card.getByTestId("lead-looks")).toHaveCount(0)
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect.poll(() => questionNotices().length).toBe(1)
  await expect.poll(() => looks().length).toBe(1)
  expect(looks()[0]).toMatchObject({ event: "lead_look", result: "passed", kind: "user_choice" })
  // Only the look of the lead went to the model.
  expect(
    mock.requests.filter(
      (r) =>
        r.path === "/v1/chat/completions" &&
        JSON.stringify(r.body).includes("higher in the line of a channel"),
    ),
  ).toHaveLength(0)
  await page.getByTestId("page-chats").click()
  await page.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(summaries(page)).toHaveCount(1, { timeout: 60_000 })
})

test("Pia does not answer in time: Max looks. Max does not answer either: the user gets the line 'No agent on the line answered in time.'", async () => {
  test.setTimeout(150_000)
  // Each look takes 2 seconds at most, and the whole line after the lead takes 3.5 seconds.
  const first = await start({ ROBOT_TEST_LEAD_LOOK_MS: "2000", ROBOT_TEST_LINE_MS: "3500" })
  await post(first.page, "split lead ASKS late1")
  await expect(first.page.getByTestId("lead-answered-by")).toHaveText("Answered by Max", {
    timeout: 60_000,
  })
  await expect(first.page.getByTestId("lead-pass")).toHaveText([
    "Dee: Not sure at 0.",
    "Pia did not answer in time.",
  ])
  await expect(first.page.getByTestId("lead-pass").last()).toHaveAttribute("data-kind", "late")
  await expect(summaries(first.page)).toHaveCount(1, { timeout: 60_000 })
  await expect.poll(() => first.looks().length).toBe(3)
  expect(
    first.looks().map((l) => [l.event, l.place ?? 0, l.result, l.kind ?? l.why ?? null]),
  ).toEqual([
    ["lead_look", 0, "passed", "not_sure"],
    ["line_look", 1, "passed", "late"],
    ["line_look", 2, "answered", null],
  ])
  expect(first.questionNotices()).toEqual([])
  await first.app.close()

  const second = await start({ ROBOT_TEST_LEAD_LOOK_MS: "2000", ROBOT_TEST_LINE_MS: "3500" })
  await post(second.page, "split lead ASKS late2")
  const card = second.page.getByTestId("ask-card")
  await expect(card.getByTestId("lead-line-late")).toHaveText(
    "No agent on the line answered in time.",
    { timeout: 60_000 },
  )
  await expect(card.getByTestId("ask-choice")).toHaveCount(2)
  await expect(card.getByTestId("lead-looks")).toHaveCount(0)
  await expect(card.getByTestId("lead-pass").first()).toHaveText("Dee: Not sure at 0.")
  await expect(card.getByTestId("lead-pass").nth(1)).toHaveText("Pia did not answer in time.")
  await shot(second.page, "s111-04-line-late")
  await openToday(second.page)
  await expect(needsRows(second.page)).toHaveCount(1)
  await expect.poll(() => second.questionNotices().length).toBe(1)
  await second.app.close()
})

test("the switch is off: a pass of the lead goes to the user, as before; turned on in the settings it takes effect", async () => {
  test.setTimeout(180_000)
  const { page, mock, questionNotices } = await start({}, false)
  const lineRequests = () =>
    mock.requests.filter(
      (r) =>
        r.path === "/v1/chat/completions" &&
        JSON.stringify(r.body).includes("higher in the line of a channel"),
    ).length

  // Off at first: the lead passes, and the question comes to the user with the one pass line.
  await post(page, "split lead ASKS up1")
  const card = page.getByTestId("ask-card")
  await expect(card.getByTestId("ask-choice")).toHaveCount(2, { timeout: 60_000 })
  await expect(card.getByTestId("lead-pass")).toHaveText("Dee: Not sure at 0.")
  await expect(card.getByTestId("lead-looks")).toHaveCount(0)
  expect(lineRequests()).toBe(0)
  await expect.poll(() => questionNotices().length).toBe(1)
  await card.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(summaries(page)).toHaveCount(1, { timeout: 60_000 })

  // The switch in the settings part "Organization", with its line.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-organization").click()
  const ask = page.getByTestId("organization-ask-up")
  await expect(ask).toHaveAttribute("aria-checked", "false")
  await expect(page.getByTestId("organization-ask-up-now")).toHaveText(
    "A question that the lead passes comes to you.",
  )
  await ask.click()
  await expect(ask).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("organization-ask-up-now")).toContainText(
    "can go to higher agents first",
  )
  await shot(page, "s111-05-setting-on")
  await page.getByTestId("settings-close").click()

  // On: the same question now goes up the line, and Pia answers it.
  await post(page, "split lead ASKS up1")
  await expect(page.getByTestId("lead-answered-by")).toHaveText("Answered by Pia", {
    timeout: 60_000,
  })
  expect(lineRequests()).toBe(1)
  await expect(summaries(page)).toHaveCount(2, { timeout: 60_000 })
  expect(questionNotices()).toHaveLength(1)
})

test("turning the switch off while Pia looks sends the question to the user at once", async () => {
  test.setTimeout(150_000)
  const { page, looks, questionNotices } = await start()
  await post(page, "split lead ASKS up1slow")
  await expect(page.getByTestId("lead-looks")).toHaveText("Pia looks at it", { timeout: 60_000 })

  await rpc(page, "organization.setAskUpTheLine", { on: false })
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  const card = page.getByTestId("ask-card")
  await expect(card.getByTestId("ask-choice")).toHaveCount(2)
  await expect(card.getByTestId("lead-pass")).toHaveText("Dee: Not sure at 0.")
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect.poll(() => questionNotices().length).toBe(1)
  await expect.poll(() => looks().length).toBe(2)
  expect(looks()[1]).toMatchObject({ event: "line_look", place: 1, result: "stopped" })
  // Pia would have answered after 3 seconds. Her late answer changes nothing.
  await page.waitForTimeout(3500)
  await page.getByTestId("page-chats").click()
  await expect(page.getByTestId("lead-answer")).toHaveCount(0)
  await page.getByTestId("ask-choice").filter({ hasText: "Yes" }).click()
  await expect(summaries(page)).toHaveCount(1, { timeout: 60_000 })
})

test("an approval never goes up the line", async () => {
  test.setTimeout(120_000)
  const { page, mock, questionNotices } = await start()
  await post(page, "split lead approval")

  await expect(page.getByTestId("ask-deny")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("lead-looks")).toHaveCount(0)
  await openToday(page)
  await expect(needsRows(page)).toHaveCount(1)
  await expect(needsRows(page)).toHaveAttribute("data-kind", "approval")
  expect(
    mock.requests.filter(
      (r) =>
        r.path === "/v1/chat/completions" &&
        JSON.stringify(r.body).includes("A member asks a question"),
    ),
  ).toHaveLength(0)
  expect(questionNotices()).toEqual([])
  await page.getByTestId("page-chats").click()
  await page.getByTestId("ask-deny").click()
  await expect(summaries(page)).toHaveCount(1, { timeout: 60_000 })
})

test("the words are Korean in the Korean interface: the setting", async () => {
  test.setTimeout(150_000)
  const { page } = await start({}, false)
  await rpc(page, "settings.update", { language: "ko" })
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-organization").click()
  await expect(page.getByTestId("organization-ask-up-row")).toBeVisible()
  await expect(page.getByTestId("organization-ask-up-row")).not.toContainText("Ask up the line")
  await shot(page, "s111-06-korean-setting")
  await page.getByTestId("organization-ask-up").click()
  await expect(page.getByTestId("organization-ask-up")).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("settings-close").click()

  await post(page, "split lead ASKS user1")
  const card = page.getByTestId("ask-card")
  await expect(card.getByTestId("ask-choice")).toHaveCount(2, { timeout: 60_000 })
  await expect(card.getByTestId("lead-pass")).toHaveCount(2)
  await expect(card.getByTestId("lead-pass").last()).toHaveAttribute("data-kind", "user_choice")
  await shot(page, "s111-07-korean-card")
})
