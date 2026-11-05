import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shot,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import {
  closeSettings,
  envFor,
  openDevices,
  rpc,
  setName,
  synced,
  turnOnSync,
} from "./sync-helpers.ts"

// Spec 030, "Daily token limit" (S128b), with 005 ("Blocked"), 006 (the usage page), 012, 014, 019
// and 021 (Today): the daily token limit of an organization. The field in the form, the line at
// 80%, a task that the limit stops ends as Blocked with no turn, Retry after a raise, the limit of
// a higher organization, a direct chat that is never stopped but counts, the usage page, a linked
// computer, the sync of the limit and the export. It replaces the end-to-end spec of the limit of a
// channel (S112): a channel has no limit now. The stand-in model reports the tokens that the words
// USAGE in a message ask for (see `spendOf` in mock-provider.ts).

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
  dailyTokenLimit: number | null
}
interface TaskInfo {
  id: string
  state: string
  source: string
  error: { code: string; detail: string } | null
  prompt: string
}

const serverIdOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentIdOf = async (page: Page, name: string) =>
  (
    await rpc<{ id: string; name: string }[]>(page, "agents.list", {
      serverId: await serverIdOf(page),
      archived: false,
    })
  ).find((a) => a.name === name)?.id as string
const orgsOf = async (page: Page) =>
  rpc<OrgInfo[]>(page, "organizations.list", { serverId: await serverIdOf(page) })
const orgByName = async (page: Page, name: string) =>
  (await orgsOf(page)).find((o) => o.name === name) as OrgInfo
const makeOrg = async (
  page: Page,
  name: string,
  members: string[],
  extra: { parent?: string; limit?: number } = {},
) =>
  rpc<OrgInfo>(page, "organizations.create", {
    serverId: await serverIdOf(page),
    name,
    memberIds: await Promise.all(members.map((m) => agentIdOf(page, m))),
    leadId: null,
    ...(extra.parent ? { parentId: (await orgByName(page, extra.parent)).id } : {}),
    ...(extra.limit ? { dailyTokenLimit: extra.limit } : {}),
  })
const makeChannel = async (page: Page, name: string, members: string[], lead?: string) =>
  rpc<{ id: string; name: string }>(page, "channels.create", {
    serverId: await serverIdOf(page),
    name,
    topic: "",
    memberIds: await Promise.all(members.map((m) => agentIdOf(page, m))),
    leadId: lead ? await agentIdOf(page, lead) : null,
  })
const tasksOf = async (page: Page) =>
  rpc<TaskInfo[]>(page, "tasks.list", { serverId: await serverIdOf(page) })
const settled = (page: Page) =>
  expect
    .poll(
      async () =>
        (await tasksOf(page)).filter((t) => ["queued", "running", "waiting"].includes(t.state))
          .length,
      { timeout: 30_000 },
    )
    .toBe(0)
/** A job for the channel, said as a mention: the member answers and reports the tokens of the words USAGE. */
const mention = async (page: Page, channelId: string, text: string) => {
  await rpc(page, "channels.send", { channelId, text })
  await settled(page)
}
/** A message in the direct chat of an agent. */
const chat = async (page: Page, name: string, text: string) => {
  await rpc(page, "chat.send", { agentId: await agentIdOf(page, name), text, replyTo: null })
  await settled(page)
}
const notices = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []
const completions = (mock: Awaited<ReturnType<typeof startMockProvider>>) =>
  mock.requests.filter((r) => r.path === "/v1/chat/completions").length

const dialog = (page: Page) => page.getByTestId("org-dialog")
const limitLine = (page: Page) => page.getByTestId("org-limit-line")
const orgNode = (page: Page, name: string) =>
  page
    .getByTestId("org-unit")
    .filter({ has: page.getByTestId("org-unit-name").getByText(name, { exact: true }) })
/** Opens the org chart: the way in to the form of an organization. */
const openChart = async (page: Page) => {
  const close = page.getByTestId("settings-close")
  if (await close.isVisible().catch(() => false)) {
    await close.click()
    await expect(close).toHaveCount(0)
  }
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
}
const openOrg = async (page: Page, name: string) => {
  await openChart(page)
  await orgNode(page, name).click()
  await expect(dialog(page)).toBeVisible()
}
const closeDialog = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
}
/** Sets the limit of an organization in its form. `null` turns the field off. */
const setLimitInForm = async (page: Page, name: string, limit: string | null) => {
  await openOrg(page, name)
  const field = page.getByTestId("org-daily-limit")
  const on = (await field.getByTestId("org-limit-switch").getAttribute("aria-checked")) === "true"
  if (limit === null) {
    if (on) await field.getByTestId("org-limit-switch").click()
  } else {
    if (!on) await field.getByTestId("org-limit-switch").click()
    await page.getByTestId("org-limit").fill(limit)
  }
  await page.getByTestId("org-submit").click()
  await expect(dialog(page)).toHaveCount(0)
}

test("the daily token limit: the field, the line at 80%, Blocked at the limit, Retry after a raise, a direct chat that is never stopped, a higher organization, the usage page and Korean", async () => {
  test.setTimeout(300_000)
  const logs = freshUserData()
  const notified = join(logs, "notices.jsonl")
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: notified,
    ROBOT_TEST_UNFOCUSED: "1",
  })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
    // Product > Docs > Site. Ada and Bo are in Site. Cy is in no organization.
    await makeOrg(page, "Product", [])
    await makeOrg(page, "Docs", [], { parent: "Product" })
    await makeOrg(page, "Site", ["Ada", "Bo"], { parent: "Docs" })
    const work = await makeChannel(page, "Work", ["Ada", "Bo", "Cy"])
    expect((await orgByName(page, "Docs")).dailyTokenLimit).toBeNull()

    // The field is off by default. On, it takes a whole number from 10,000 to 100,000,000.
    await openOrg(page, "Docs")
    const field = page.getByTestId("org-daily-limit")
    await expect(field.getByTestId("org-limit-switch")).toHaveAttribute("aria-checked", "false")
    await expect(page.getByTestId("org-limit")).toHaveCount(0)
    await field.getByTestId("org-limit-switch").click()
    await page.getByTestId("org-limit").fill("9,999")
    await expect(page.getByTestId("org-limit-error")).toContainText(
      "Use a whole number from 10,000 to 100,000,000 for the daily token limit.",
    )
    await expect(page.getByTestId("org-submit")).toBeDisabled()
    await page.getByTestId("org-limit").fill("100,000,001")
    await expect(page.getByTestId("org-submit")).toBeDisabled()
    await page.getByTestId("org-limit").fill("12.5")
    await expect(page.getByTestId("org-submit")).toBeDisabled()
    await shot(page, "s128-limit-01-invalid")
    await page.getByTestId("org-limit").fill("50,000")
    await expect(page.getByTestId("org-limit-error")).toHaveCount(0)
    await page.getByTestId("org-submit").click()
    await expect(dialog(page)).toHaveCount(0)
    expect((await orgByName(page, "Docs")).dailyTokenLimit).toBe(50_000)
    // The saved limit shows again, and no line shows while nothing is used.
    await openOrg(page, "Docs")
    await expect(page.getByTestId("org-limit")).toHaveValue("50000")
    await expect(limitLine(page)).toHaveCount(0)
    await closeDialog(page)

    // 41,000 tokens in all (82%) from a chat of Ada and a part of Bo: the form of Docs shows the
    // muted line at 80%, and no notification comes from it. Tokens of Site count for Docs.
    await chat(page, "Ada", "hello USAGE 20000/1000")
    // The reply of the chat is a notice of its own. The count starts after it.
    const before = notices(notified).length
    await mention(page, work.id, "@Bo write the intro USAGE 19000/1000")
    await openOrg(page, "Docs")
    await expect(limitLine(page)).toHaveText("80% of the daily token limit is used.", {
      timeout: 15_000,
    })
    await shot(page, "s128-limit-02-line-80")
    await closeDialog(page)
    expect(notices(notified)).toHaveLength(before)
    expect((await tasksOf(page)).some((t) => t.state === "blocked")).toBe(false)

    // A part reports 51,000 tokens. The limit was not used when it started, so it goes to its end,
    // and its tokens count: 92,000 of 50,000.
    await mention(page, work.id, "@Bo write the next part USAGE 50000/1000")
    expect((await tasksOf(page)).filter((t) => t.state === "done")).toHaveLength(3)
    await openOrg(page, "Docs")
    await expect(limitLine(page)).toHaveText("The daily token limit of Docs is used.", {
      timeout: 15_000,
    })
    await shot(page, "s128-limit-03-used")
    await closeDialog(page)

    // The next part ends at once as Blocked, with the reason and no model call.
    const asked = completions(mock)
    await mention(page, work.id, "@Bo write the third part USAGE 500/10")
    const blocked = (await tasksOf(page)).filter((t) => t.state === "blocked")
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.error).toEqual({ code: "org_limit", detail: "Docs" })
    expect(completions(mock)).toBe(asked)
    // Cy is in no organization: no limit stops that agent, however much the others used.
    await mention(page, work.id, "@Cy write the fourth part USAGE 500/10")
    expect((await tasksOf(page)).filter((t) => t.state === "blocked")).toHaveLength(1)
    // The blocked task makes the one notice of a failed task, as other blocked work does (015).
    expect(
      notices(notified)
        .slice(before)
        .map((n) => (JSON.parse(n) as { title: string }).title),
    ).toEqual(["Bo"])

    // A direct chat is never stopped, and its tokens count.
    await chat(page, "Ada", "still here USAGE 300/10")
    expect((await tasksOf(page)).filter((t) => t.source === "chat").map((t) => t.state)).toEqual([
      "done",
      "done",
    ])

    // Today shows the blocked part as it shows other blocked work. The row opens the task.
    await page.getByTestId("page-today").click()
    const wrong = page
      .getByTestId("today-group-wrong")
      .locator("[data-testid=today-row][data-kind=task_blocked]")
    await expect(wrong).toHaveCount(1)
    await expect(wrong.getByTestId("today-line")).toContainText("write the third part")
    await shot(page, "s128-limit-04-today")
    await wrong.click()
    await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "blocked")
    await expect(page.getByTestId("task-error")).toContainText(
      "The daily token limit of Docs is used.",
    )
    await shot(page, "s128-limit-05-reason")
    await page.keyboard.press("Escape")

    // The usage page: one row for Docs with its limit and the tokens used today (the tokens of the
    // chat count too). Product and Site have no limit, so they have no row.
    await page.getByTestId("page-usage").click()
    await expect(page.getByTestId("usage-org-row")).toHaveCount(1)
    const row = page.locator("[data-testid=usage-org-row][data-org=Docs]")
    await expect(row.getByTestId("usage-org-limit")).toHaveText("50,000")
    await expect(row.getByTestId("usage-org-used")).toHaveText("92,310")
    await shot(page, "s128-limit-06-usage")

    // Retry while the limit is used: blocked again. Raise the limit to 100,000, press Retry: it runs.
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-state").selectOption("blocked")
    await expect(page.getByTestId("task-row")).toHaveCount(1)
    await page.getByTestId("task-open").first().click()
    await page.getByTestId("task-retry").click()
    await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "blocked")
    await page.keyboard.press("Escape")
    await setLimitInForm(page, "Docs", "100,000")
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-state").selectOption("blocked")
    await page.getByTestId("task-open").first().click()
    await page.getByTestId("task-retry").click()
    await page.keyboard.press("Escape")
    // The retry is a new task, and it ends as done. The old tasks keep their state.
    await expect
      .poll(async () => (await tasksOf(page)).filter((t) => t.state === "done").length, {
        timeout: 30_000,
      })
      .toBe(5)
    expect((await tasksOf(page)).filter((t) => t.state === "blocked")).toHaveLength(2)
    await page.getByTestId("page-today").click()
    await expect(page.getByTestId("today-group-wrong")).toHaveCount(0, { timeout: 15_000 })

    // The limit of Product counts the tokens of Docs and Site: when it is used, a new part of a
    // member of Site ends as Blocked, and the reason names Product.
    await rpc(page, "organizations.update", {
      id: (await orgByName(page, "Product")).id,
      patch: { dailyTokenLimit: 50_000 },
    })
    await mention(page, work.id, "@Bo write the fifth part USAGE 500/10")
    const byProduct = (await tasksOf(page)).find((t) => t.prompt.includes("fifth part"))
    expect(byProduct?.state).toBe("blocked")
    expect(byProduct?.error).toEqual({ code: "org_limit", detail: "Product" })
    await openOrg(page, "Site")
    await expect(page.getByTestId("org-daily-limit")).toBeVisible()
    await expect(page.getByTestId("org-limit-switch")).toHaveAttribute("aria-checked", "false")
    await closeDialog(page)
    await shot(page, "s128-limit-07-higher-organization")

    // The limit goes off again: the field is empty and the row leaves the usage page.
    await setLimitInForm(page, "Docs", null)
    await setLimitInForm(page, "Product", null)
    expect((await orgByName(page, "Docs")).dailyTokenLimit).toBeNull()
    await page.getByTestId("page-usage").click()
    await expect(page.getByTestId("usage-orgs")).toHaveCount(0)

    // Korean: the field, the line, the usage page and the reason of a blocked task are Korean.
    await rpc(page, "organizations.update", {
      id: (await orgByName(page, "Docs")).id,
      patch: { dailyTokenLimit: 50_000 },
    })
    await page.getByTestId("open-settings").click()
    await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
    await page.getByTestId("settings-close").click()
    await expect(page.getByTestId("settings-close")).toHaveCount(0)
    await expect(page.getByTestId("usage-page")).toContainText("조직의 하루 토큰 한도")
    await expect(page.getByTestId("usage-orgs")).toContainText("오늘 사용량")
    await openOrg(page, "Docs")
    await expect(page.getByTestId("org-daily-limit")).toContainText("하루 토큰 한도")
    await expect(limitLine(page)).toHaveText("Docs의 하루 토큰 한도를 모두 사용했어요.", {
      timeout: 15_000,
    })
    await shot(page, "s128-limit-08-form-ko")
    await closeDialog(page)
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-state").selectOption("blocked")
    await page
      .getByTestId("task-row")
      .filter({ hasText: "fifth part" })
      .getByTestId("task-open")
      .click()
    await expect(page.getByTestId("task-error")).toHaveText(
      "Product의 하루 토큰 한도를 모두 사용했어요.",
    )
    await page.keyboard.press("Escape")

    // The narrowest window: the form and the usage page keep the field readable.
    await resizeWindow(app, 480, 800)
    await openOrg(page, "Docs")
    await expect(page.getByTestId("org-limit")).toBeVisible()
    await shot(page, "s128-limit-09-narrow-form-ko")
    await closeDialog(page)
    await page.getByTestId("page-usage").click()
    await expect(page.getByTestId("usage-org-row")).toHaveCount(1)
    await page.getByTestId("usage-orgs").scrollIntoViewIfNeeded()
    await shot(page, "s128-limit-10-narrow-usage-ko")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("the limit stops a part of a lead job that would start, and the lead job: both end as Blocked, and Retry works after a raise", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    for (const name of ["Bo", "Cy"]) await createAgent(page, name)
    await makeOrg(page, "Docs", ["Bo", "Cy"], { limit: 50_000 })
    const docs = await makeChannel(page, "Docs", ["Bo", "Cy"], "Cy")

    // The lead gives Bo two parts. The first one reports 51,000 tokens: the turn that runs goes to
    // its end, and its tokens count. The second part would start behind it, so it ends as Blocked
    // at once, with no model call.
    await rpc(page, "channels.send", { channelId: docs.id, text: "split limit job" })
    await expect
      .poll(async () => (await tasksOf(page)).filter((t) => t.state === "blocked").length, {
        timeout: 30_000,
      })
      .toBe(2)
    await settled(page)
    // The part and the job of the lead end as Blocked, with the same reason: the lead cannot look
    // at the end of the work while the limit is used. The first part is done.
    const ended = await tasksOf(page)
    expect(ended.filter((t) => t.state === "blocked").map((t) => t.error)).toEqual([
      { code: "org_limit", detail: "Docs" },
      { code: "org_limit", detail: "Docs" },
    ])
    expect(ended.filter((t) => t.state === "done").map((t) => t.prompt)).toEqual([
      "Write the intro USAGE 51000/0",
    ])
    const asked = (text: string) =>
      mock.requests.some(
        (r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body).includes(text),
      )
    expect(asked("Check the facts USAGE")).toBe(false)
    await page.getByTestId(`place-channel-${docs.id}`).click()
    await expect(page.locator("[data-kind=summary]")).toHaveCount(0)
    await expect(page.locator("[data-testid=part-chip][data-state=blocked]")).toHaveCount(1)
    await shot(page, "s128-limit-11-part-blocked")
    // Today shows the blocked job of the lead as it shows other blocked work: one row.
    await page.getByTestId("page-today").click()
    const wrong = page
      .getByTestId("today-group-wrong")
      .locator("[data-testid=today-row][data-kind=task_blocked]")
    await expect(wrong).toHaveCount(1)
    await expect(wrong.getByTestId("today-line")).toContainText("split limit job")

    // Raise the limit, and press Retry on the part: it runs.
    await setLimitInForm(page, "Docs", "100,000")
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-state").selectOption("blocked")
    await page
      .getByTestId("task-row")
      .filter({ hasText: "Check the facts" })
      .getByTestId("task-open")
      .click()
    await page.getByTestId("task-retry").click()
    await page.keyboard.press("Escape")
    await expect.poll(() => asked("Check the facts USAGE 100/10"), { timeout: 30_000 }).toBe(true)
    await expect
      .poll(async () => (await tasksOf(page)).filter((t) => t.state === "done").length, {
        timeout: 30_000,
      })
      .toBe(2)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)

/** MacBook 2 shows a code; MacBook 1 connects one way. `canChange` is the switch of the dialog. */
const pairOneWay = async (one: Launched, two: Launched, canChange: boolean) => {
  await openDevices(two.page)
  await setName(two.page, "MacBook 2")
  await two.page.getByTestId("pair-open").click()
  await two.page.getByTestId("pair-turn-on").click()
  await expect(two.page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
  const code = (await two.page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
  const address =
    (await two.page
      .getByTestId("pair-addresses")
      .locator("li")
      .first()
      .getAttribute("data-address")) ?? ""
  await one.page.getByTestId("server-add").click()
  await one.page.getByTestId("connect-address").fill(address)
  await one.page.getByTestId("connect-code").fill(code)
  await one.page.getByTestId("connect-next").click()
  await one.page.getByTestId("connect-two-way").click()
  await one.page.getByTestId("connect-finish").click()
  if (!canChange) await two.page.getByTestId("join-can-change").click()
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await closeSettings(two.page)
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

test("a linked computer with the switch changes the limit; with the switch off it reads the field and changes nothing (spec 012, 030)", async () => {
  test.setTimeout(300_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const two: Launched = await launch(freshUserData(), envFor(PORT_2))
  const one: Launched = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(one.app, 1300, 900)
    await resizeWindow(two.app, 1300, 900)
    // MacBook 2 holds the agent and the organization.
    await rpc(two.page, "agents.create", {
      serverId: await serverIdOf(two.page),
      name: "Ada",
      role: "",
      instructions: "",
    })
    await makeOrg(two.page, "Docs", ["Ada"], { limit: 50_000 })
    await pairOneWay(one, two, true)

    // MacBook 1 opens the organization of MacBook 2. The field works, with the switch on.
    await tile(one.page, "MacBook 2").click()
    await openOrg(one.page, "Docs")
    await expect(one.page.getByTestId("org-limit")).toHaveValue("50000")
    await expect(one.page.getByTestId("org-limit-switch")).toBeEnabled()
    await one.page.getByTestId("org-limit").fill("20,000")
    await one.page.getByTestId("org-submit").click()
    await expect(dialog(one.page)).toHaveCount(0)
    await expect
      .poll(async () => (await orgByName(two.page, "Docs")).dailyTokenLimit, { timeout: 30_000 })
      .toBe(20_000)

    // The user turns the switch off on MacBook 2: the form is read only on MacBook 1.
    await openDevices(two.page)
    await two.page.locator("[data-testid=client-can-change]").first().click()
    await expect(two.page.locator("[data-testid=client-can-change]").first()).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await closeSettings(two.page)
    await openOrg(one.page, "Docs")
    await expect(one.page.getByTestId("org-readonly")).toBeVisible()
    await expect(one.page.getByTestId("org-limit")).toHaveValue("20000")
    await expect(one.page.getByTestId("org-limit")).toHaveJSProperty("readOnly", true)
    await expect(one.page.getByTestId("org-limit-switch")).toBeDisabled()
    await expect(one.page.getByTestId("org-submit")).toHaveCount(0)
    await shot(one.page, "s128-limit-12-linked-read-only")
    await closeDialog(one.page)
    // The limit that MacBook 1 set is still on MacBook 2.
    expect((await orgByName(two.page, "Docs")).dailyTokenLimit).toBe(20_000)
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
  }
})
test("sync: the limit goes to the other computer and counts there; an export and a restore bring back the limit (spec 019, 014)", async () => {
  test.setTimeout(300_000)
  const work = freshUserData()
  const archive = join(work, "export.zip")
  const s = await synced(await freePortPair(), [{ ROBOT_TEST_SAVE_PATH: archive }, {}])
  const { one, two } = s
  try {
    // Ada works on MacBook 1 before the sync: a chat that reports 41,000 tokens.
    await createAgent(one.page, "Ada")
    await makeOrg(one.page, "Product", [], { limit: 50_000 })
    await makeOrg(one.page, "Docs", ["Ada"], { parent: "Product" })
    await chat(one.page, "Ada", "hello USAGE 40000/1000")
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)

    // The tree and the limits show on both computers.
    const shown = async (p: Page) =>
      (await orgsOf(p))
        .map((o) => `${o.name}:${o.dailyTokenLimit ?? "off"}:${o.parentId ? "sub" : "top"}`)
        .sort()
    await expect
      .poll(() => shown(two.page), { timeout: 30_000 })
      .toEqual(["Docs:off:sub", "Product:50000:top"])
    // A change of the limit on MacBook 2 goes to MacBook 1. Docs has its own limit now.
    await rpc(two.page, "organizations.update", {
      id: (await orgByName(two.page, "Docs")).id,
      patch: { dailyTokenLimit: 30_000 },
    })
    await expect
      .poll(() => shown(one.page), { timeout: 30_000 })
      .toEqual(["Docs:30000:sub", "Product:50000:top"])
    // The usage page of MacBook 2 lists the two limits. The task of MacBook 1 has synced, so its
    // 41,000 tokens count there: for Docs, and for Product above it (spec 030, "The day").
    await two.page.getByTestId("page-usage").click()
    await expect(two.page.getByTestId("usage-org-row")).toHaveCount(2)
    const docsRow = two.page.locator("[data-testid=usage-org-row][data-org=Docs]")
    await expect(docsRow.getByTestId("usage-org-limit")).toHaveText("30,000")
    await expect(docsRow.getByTestId("usage-org-used")).toHaveText("41,000", { timeout: 30_000 })
    await expect(
      two.page
        .locator("[data-testid=usage-org-row][data-org=Product]")
        .getByTestId("usage-org-used"),
    ).toHaveText("41,000")
    await shot(two.page, "s128-limit-13-synced-usage")

    // Export on MacBook 1 and restore into an empty app: the tree and the limits come back.
    await one.page.getByTestId("open-settings").click()
    await one.page.getByTestId("settings-nav-data").click()
    await one.page.getByTestId("data-export").click()
    await expect(one.page.getByTestId("data-note")).toContainText(archive)
    const third = await launch(freshUserData(), {
      ROBOT_SYSTEM_LOCALE: "en-US",
      ROBOT_TEST_OPEN_PATH: archive,
    })
    try {
      await resizeWindow(third.app, 1200, 860)
      await third.page.getByTestId("open-settings").click()
      await third.page.getByTestId("settings-nav-data").click()
      await third.page.getByTestId("data-restore").click()
      await expect(third.page.getByTestId("data-note")).toContainText("Restored")
      expect(await shown(third.page)).toEqual(["Docs:30000:sub", "Product:50000:top"])
    } finally {
      await third.app.close().catch(() => {})
    }
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})
