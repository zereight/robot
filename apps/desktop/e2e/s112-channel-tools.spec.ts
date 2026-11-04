import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
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

// Spec 030, "Channel tools" and "Daily token limit" (S112), with 017, 018, 005, 006, 002, 012, 014
// and 019: the part "Tools of this channel", the mark "channel" in the forms of skills and
// connections, "From <channel>" in the profile, the daily token limit (the field, the line at 80%,
// Blocked at the limit, Retry after a raise, the limit of a parent channel, the row of the usage
// page), a linked computer, the sync of the limit and the export. The stand-in model reports the
// tokens that the words USAGE in a message ask for (see `spendOf` in mock-provider.ts).

interface ChannelInfo {
  id: string
  name: string
  parentId: string | null
  dailyTokenLimit?: number | null
}
interface AgentInfo {
  id: string
  name: string
}

const localServerId = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const channelsOf = async (page: Page) =>
  rpc<ChannelInfo[]>(page, "channels.list", { serverId: await localServerId(page) })
const agentId = async (page: Page, name: string) =>
  (
    await rpc<AgentInfo[]>(page, "agents.list", {
      serverId: await localServerId(page),
      archived: false,
    })
  ).find((a) => a.name === name)?.id as string
const makeChannel = async (
  page: Page,
  name: string,
  memberIds: string[],
  extra: { parentId?: string; dailyTokenLimit?: number; leadId?: string } = {},
) =>
  rpc<ChannelInfo>(page, "channels.create", {
    serverId: await localServerId(page),
    name,
    topic: "",
    memberIds,
    leadId: extra.leadId ?? null,
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
    ...(extra.dailyTokenLimit ? { dailyTokenLimit: extra.dailyTokenLimit } : {}),
  })

const openChannel = (page: Page, channel: ChannelInfo) =>
  page.getByTestId(`place-channel-${channel.id}`).click()
/** Says a text in the open channel. */
const say = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const idle = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
const limitLine = (page: Page) => page.getByTestId("channel-limit-line")
const tasksOf = async (page: Page) =>
  rpc<
    { id: string; state: string; error: { code: string; detail: string } | null; prompt: string }[]
  >(page, "tasks.list", { serverId: await localServerId(page) })
const notices = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []

const SERVER = resolve(import.meta.dirname, "fakes/mcp-server.mjs")
const CHAT = "/v1/chat/completions"
const openAgent = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]").filter({ hasText: name }).click()
const skillOption = (page: Page, name: string) =>
  page.locator(`[data-testid=skill-option][data-skill='${name}']`)
/** The names of the tools in the newest chat request to the stand-in model. */
const toolsOfLastRequest = (mock: Awaited<ReturnType<typeof startMockProvider>>) => {
  const chats = mock.requests.filter((r) => r.path === CHAT)
  const body = chats.at(-1)?.body as { tools?: { function?: { name?: string } }[] } | undefined
  return (body?.tools ?? []).map((t) => t.function?.name ?? "")
}
/** What the profile of the open agent says about the tools that it has from channels. */
const profileLines = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  // Each line holds the name of the tool and the line "From <channel>", in two spans.
  const lines = await page
    .getByTestId("channel-tool-line")
    .evaluateAll((els) =>
      els.map((el) => [...el.children].map((c) => c.textContent?.trim() ?? "").join(" ")),
    )
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  return lines
}
const toolRow = (page: Page, name: string) =>
  page.locator(`[data-testid=channel-tool-row][data-name='${name}']`)

/** Opens the settings of the open channel. */
const openSettings = async (page: Page) => {
  await page.getByTestId("channel-settings").click()
  await expect(page.getByTestId("channel-dialog")).toBeVisible()
}

test("tools of a channel: a skill and a connection reach the members of lower channels, the forms show the mark, the profile shows From <channel>, and leaving a channel takes them away", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_HOME: freshUserData(),
  })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    for (const name of ["Ada", "Bo", "Cy", "Di"]) await createAgent(page, name)
    const ids = {
      Ada: await agentId(page, "Ada"),
      Bo: await agentId(page, "Bo"),
      Cy: await agentId(page, "Cy"),
    }
    // Product holds Docs, and Docs holds Site: "Product" is two levels above "Site".
    const product = await makeChannel(page, "Product", [ids.Ada])
    const docs = await makeChannel(page, "Docs", [ids.Bo], { parentId: product.id })
    const site = await makeChannel(page, "Site", [ids.Cy], { parentId: docs.id })

    // --- A skill for the agent Di only, and one for all agents --------------------------------
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-skills").click()
    await page.getByTestId("skills-new").click()
    await page.getByTestId("skill-name").fill("Weekly summary")
    await page.getByTestId("skill-instructions").fill("Write a weekly summary.")
    await page.getByTestId("skill-save").click()
    await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
    await page.getByTestId("skills-new").click()
    await page.getByTestId("skill-name").fill("Release notes")
    await page.getByTestId("skill-instructions").fill("Write the release notes in three lines.")
    await page.getByTestId("skill-agents-mode").getByText("Chosen agents").click()
    // The picker lists the agents, then the channels, each channel with the mark "channel".
    const channelRows = page.getByTestId("skill-channel")
    await expect(channelRows).toHaveCount(3)
    await expect(page.getByTestId("skill-channel-mark")).toHaveText([
      "channel",
      "channel",
      "channel",
    ])
    await expect(page.getByTestId("skill-agent")).toHaveCount(4)
    await shot(page, "s112-11-skill-form-channels")
    await page.locator("[data-testid=skill-agent][data-agent=Di]").check()
    await page.getByTestId("skill-save").click()
    await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
    const row = page.locator("[data-testid=skill-row][data-skill='Release notes']")
    await expect(row.getByTestId("skill-row-agents")).toHaveText("Di")
    await page.getByTestId("settings-close").click()

    // Nobody in Product, Docs or Site has the skill yet. Cy sees only the skill for all agents.
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Weekly summary")).toHaveCount(1)
    await expect(skillOption(page, "Release notes")).toHaveCount(0)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual([])

    // --- The part "Tools of this channel" in the settings of Product ---------------------------
    await openChannel(page, product)
    await openSettings(page)
    const part = page.getByTestId("channel-tools")
    await expect(part).toContainText("Tools of this channel")
    // The skill for all agents shows on and cannot change. The skill of Di shows off.
    await expect(toolRow(page, "Weekly summary").getByTestId("channel-tool-all")).toBeVisible()
    await expect(toolRow(page, "Weekly summary").getByTestId("channel-tool-switch")).toBeDisabled()
    await expect(toolRow(page, "Release notes").getByTestId("channel-tool-switch")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await toolRow(page, "Release notes").getByTestId("channel-tool-switch").click()
    await expect(toolRow(page, "Release notes").getByTestId("channel-tool-switch")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await part.scrollIntoViewIfNeeded()
    await shot(page, "s112-12-tools-of-channel")
    await page.getByTestId("channel-dialog").getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)

    // The switch is the list of the skill: the skill form shows "Product", with the mark, ticked.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-skills").click()
    await expect(row.getByTestId("skill-row-agents")).toHaveText("Di, Product")
    await row.getByTestId("skill-edit").click()
    await expect(page.locator("[data-testid=skill-channel][data-channel=Product]")).toBeChecked()
    await expect(page.locator("[data-testid=skill-channel][data-channel=Docs]")).not.toBeChecked()
    await expect(page.locator("[data-testid=skill-agent][data-agent=Di]")).toBeChecked()
    await shot(page, "s112-13-skill-form-ticked")
    await page.getByTestId("skill-cancel").click()
    await page.getByTestId("settings-close").click()

    // --- A member of Site (two levels below) has the skill in its direct chat, with the line ----
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("agent-profile")).toBeVisible()
    const lines = page.getByTestId("channel-tool-line")
    await expect(lines).toHaveCount(1)
    await expect(lines.first()).toContainText("Release notes")
    await expect(lines.first().getByTestId("channel-tool-from")).toHaveText("From Product")
    await page
      .getByTestId("agent-profile")
      .getByTestId("channel-tools-lines")
      .scrollIntoViewIfNeeded()
    await shot(page, "s112-14-profile-from-channel")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("agent-profile")).toHaveCount(0)
    // It uses the skill as its own: the chip, and the instructions reach the model.
    await page.getByTestId("composer-input").fill("/release")
    await page.getByTestId("composer-input").press("Enter")
    await expect(page.getByTestId("composer-skill")).toContainText("Release notes")
    await page.getByTestId("composer-input").fill("for version two")
    await page.getByTestId("composer-input").press("Enter")
    await idle(page)
    const sent = mock.requests
      .filter((r) => r.path === CHAT)
      .map((r) => (r.body as { messages: { content: string }[] }).messages.at(-1)?.content ?? "")
      .find((c) => c.includes("for version two"))
    expect(sent).toContain("Write the release notes in three lines.")
    // Ada (a member of Product itself) and Bo (a member of Docs) have it too. Di has it from its
    // own list, not from a channel, so the profile of Di has no line.
    await openAgent(page, "Ada")
    expect(await profileLines(page)).toEqual(["Release notes From Product"])
    await openAgent(page, "Bo")
    expect(await profileLines(page)).toEqual(["Release notes From Product"])
    await openAgent(page, "Di")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual([])

    // --- Remove the member from Site: the next turn has no such skill --------------------------
    await rpc(page, "channels.update", { id: site.id, patch: { memberIds: [] } })
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Weekly summary")).toHaveCount(1)
    await expect(skillOption(page, "Release notes")).toHaveCount(0)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual([])
    // The member comes back: the skill comes back with it.
    await rpc(page, "channels.update", { id: site.id, patch: { memberIds: [ids.Cy] } })
    await openAgent(page, "Bo")
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")

    // --- A connection that Product gives: the form shows the mark, the tools reach Cy, the same
    // approval card asks before a call, and the switch off takes the tools away -------------------
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-connections").click()
    await page.getByTestId("connection-add").click()
    await page.getByTestId("connection-name").fill("Notes")
    await page.getByTestId("connection-command").fill(process.execPath)
    await page.getByTestId("connection-args").fill(SERVER)
    await page.getByTestId("connection-agents-mode").getByText("Some agents").click()
    await expect(page.getByTestId("connection-channel")).toHaveCount(3)
    await expect(page.getByTestId("connection-channel-mark")).toHaveText([
      "channel",
      "channel",
      "channel",
    ])
    await page.locator("[data-testid=connection-channel][data-channel=Docs]").check()
    await page.getByTestId("connection-test").click()
    await expect(page.getByTestId("connection-test-result")).toContainText("Connected. Tools: 8.")
    await page.getByTestId("connection-confirm").check()
    await page.getByTestId("connection-save").click()
    await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
    const notes = page.locator("[data-testid=connection-row][data-connection=Notes]")
    await expect(notes.getByTestId("connection-row-agents")).toHaveText("Docs")
    await page.getByTestId("settings-close").click()
    // Docs is one level above Site: Cy has the connection from Docs, Bo (a member of Docs) too.
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("hello Cy")
    await page.getByTestId("composer-input").press("Enter")
    await idle(page)
    expect(toolsOfLastRequest(mock)).toContain("mcp__notes__echo")
    expect(await profileLines(page)).toEqual(["Release notes From Product", "Notes From Docs"])
    // Ada is in Product, a higher channel of Docs: a tool of a lower channel does not go up.
    await openAgent(page, "Ada")
    await page.getByTestId("composer-input").fill("hello Ada")
    await page.getByTestId("composer-input").press("Enter")
    await idle(page)
    expect(toolsOfLastRequest(mock)).not.toContain("mcp__notes__echo")
    // The call of Cy asks the same approval as before.
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill('TOOL mcp__notes__echo {"text":"hi"}')
    await page.getByTestId("composer-input").press("Enter")
    const ask = page.getByTestId("ask-card")
    await expect(ask).toBeVisible({ timeout: 15_000 })
    await expect(ask).toContainText("Notes · echo")
    await shot(page, "s112-15-approval-card")
    await page.getByTestId("ask-deny").click()
    await idle(page)
    // The switch off in the settings of Docs takes the connection away from the next turn.
    await openChannel(page, docs)
    await openSettings(page)
    await expect(toolRow(page, "Notes").getByTestId("channel-tool-switch")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await toolRow(page, "Notes").getByTestId("channel-tool-switch").click()
    await expect(toolRow(page, "Notes").getByTestId("channel-tool-switch")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await page.getByTestId("channel-dialog").getByRole("button", { name: "Cancel" }).click()
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("hello again")
    await page.getByTestId("composer-input").press("Enter")
    await idle(page)
    expect(toolsOfLastRequest(mock)).not.toContain("mcp__notes__echo")
    expect(await profileLines(page)).toEqual(["Release notes From Product"])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("the daily token limit: the field, the line at 80%, Blocked at the limit, Retry after a raise, the usage page and Korean", async () => {
  test.setTimeout(240_000)
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
    await createAgent(page, "Bo")
    const docs = await makeChannel(page, "Docs", [await agentId(page, "Bo")])
    expect(docs.dailyTokenLimit ?? null).toBeNull()
    await openChannel(page, docs)
    await expect(limitLine(page)).toHaveCount(0)

    // The field is off by default. On, it takes a whole number from 10,000 to 100,000,000.
    await openSettings(page)
    const field = page.getByTestId("channel-daily-limit")
    await expect(field.getByTestId("channel-limit-switch")).toHaveAttribute("aria-checked", "false")
    await expect(page.getByTestId("channel-limit")).toHaveCount(0)
    await field.getByTestId("channel-limit-switch").click()
    await page.getByTestId("channel-limit").fill("9,999")
    await expect(page.getByTestId("channel-limit-error")).toContainText(
      "Use a whole number from 10,000 to 100,000,000 for the daily token limit.",
    )
    await expect(page.getByTestId("channel-submit")).toBeDisabled()
    await page.getByTestId("channel-limit").fill("100,000,001")
    await expect(page.getByTestId("channel-submit")).toBeDisabled()
    await page.getByTestId("channel-limit").fill("12.5")
    await expect(page.getByTestId("channel-submit")).toBeDisabled()
    await shot(page, "s112-01-limit-invalid")
    await page.getByTestId("channel-limit").fill("50,000")
    await expect(page.getByTestId("channel-limit-error")).toHaveCount(0)
    await page.getByTestId("channel-submit").click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
    expect((await channelsOf(page)).find((c) => c.name === "Docs")?.dailyTokenLimit).toBe(50_000)
    // The saved limit shows again when the settings open.
    await openSettings(page)
    await expect(page.getByTestId("channel-limit")).toHaveValue("50000")
    await page.getByTestId("channel-dialog").getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)

    // Nothing is used yet: no line. A reply of Bo that reports 41,000 tokens (82%): the muted line
    // shows, and no notification comes from it.
    await expect(limitLine(page)).toHaveCount(0)
    await say(page, "@Bo write the intro USAGE 40000/1000")
    await expect(limitLine(page)).toHaveText("80% of the daily token limit is used.", {
      timeout: 30_000,
    })
    await idle(page)
    await shot(page, "s112-02-line-80")
    // The line at 80% makes no notification: the log of notices is empty.
    expect(notices(notified)).toEqual([])

    // The next reply reports 11,000 more. The limit was not used when it started, so it goes to
    // its end, and its tokens count: 52,000 of 50,000.
    await say(page, "@Bo write the next part USAGE 10000/1000")
    await expect(limitLine(page)).toHaveText("The daily token limit of Docs is used.", {
      timeout: 30_000,
    })
    await idle(page)
    const replies = page.locator("[data-testid=message][data-author=agent]")
    await expect(replies).toHaveCount(2)
    await expect(replies.last()).toContainText("You said")
    await shot(page, "s112-03-limit-used")

    // The next task of the channel ends at once as Blocked, with the reason and no model call.
    const asked = mock.requests.filter((r) => r.path === "/v1/chat/completions").length
    await say(page, "@Bo write the third part USAGE 500/10")
    await expect
      .poll(async () => (await tasksOf(page)).filter((t) => t.state === "blocked").length, {
        timeout: 30_000,
      })
      .toBe(1)
    const blocked = (await tasksOf(page)).find((t) => t.state === "blocked")
    expect(blocked?.error).toEqual({ code: "channel_limit", detail: "Docs" })
    expect(mock.requests.filter((r) => r.path === "/v1/chat/completions").length).toBe(asked)
    // The blocked task makes the one notice of a failed task, as other blocked work does (spec
    // 015). Nothing else made a notice: not the line at 80%, and not the reply that used the limit.
    expect(notices(notified).map((n) => (JSON.parse(n) as { title: string }).title)).toEqual(["Bo"])

    // Today shows the blocked part as it shows other blocked work: one row in "Went wrong". The row
    // opens the task, which names the reason.
    await page.getByTestId("page-today").click()
    const wrong = page
      .getByTestId("today-group-wrong")
      .locator("[data-testid=today-row][data-kind=task_blocked]")
    await expect(wrong).toHaveCount(1)
    await expect(wrong.getByTestId("today-line")).toContainText("write the third part")
    await shot(page, "s112-04-today-blocked")
    await wrong.click()
    await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "blocked")
    await expect(page.getByTestId("task-error")).toContainText(
      "The daily token limit of Docs is used.",
    )
    await shot(page, "s112-04-task-reason")
    await page.keyboard.press("Escape")

    // The usage page: one row for the channel with its limit, the tokens used today.
    await page.getByTestId("page-usage").click()
    const usage = page.locator("[data-testid=usage-channel-row][data-channel=Docs]")
    await expect(usage).toHaveCount(1)
    await expect(usage.getByTestId("usage-channel-limit")).toHaveText("50,000")
    await expect(usage.getByTestId("usage-channel-used")).toHaveText("52,000")
    await shot(page, "s112-05-usage-row")

    // Retry while the limit is used: blocked again. Raise the limit to 100,000, press Retry: it runs.
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-state").selectOption("blocked")
    await expect(page.getByTestId("task-row")).toHaveCount(1)
    await page.getByTestId("task-open").first().click()
    await page.getByTestId("task-retry").click()
    await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "blocked")
    await expect(page.getByTestId("task-error")).toContainText(
      "The daily token limit of Docs is used.",
    )
    await page.keyboard.press("Escape")
    await openChannel(page, docs)
    await openSettings(page)
    await page.getByTestId("channel-limit").fill("100,000")
    await page.getByTestId("channel-submit").click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
    await expect(limitLine(page)).toHaveCount(0)
    await page.getByTestId("page-tasks").click()
    await page.getByTestId("tasks-filter-state").selectOption("blocked")
    await page.getByTestId("task-open").first().click()
    await page.getByTestId("task-retry").click()
    await page.keyboard.press("Escape")
    // The retry runs: it is a new task, and it ends as done. The old tasks keep their state.
    await expect
      .poll(async () => (await tasksOf(page)).filter((t) => t.state === "done").length, {
        timeout: 30_000,
      })
      .toBe(3)
    expect((await tasksOf(page)).filter((t) => t.state === "blocked")).toHaveLength(2)
    await page.getByTestId("page-today").click()
    await expect(page.getByTestId("today-group-wrong")).toHaveCount(0, { timeout: 15_000 })
    await shot(page, "s112-06-retry-after-raise")

    // The limit goes off again: the field is empty and the usage row leaves.
    await openChannel(page, docs)
    await openSettings(page)
    await page.getByTestId("channel-daily-limit").getByTestId("channel-limit-switch").click()
    await page.getByTestId("channel-submit").click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
    expect((await channelsOf(page)).find((c) => c.name === "Docs")?.dailyTokenLimit).toBeNull()
    await page.getByTestId("page-usage").click()
    await expect(page.getByTestId("usage-channels")).toHaveCount(0)
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
    const docs = await makeChannel(
      page,
      "Docs",
      [await agentId(page, "Bo"), await agentId(page, "Cy")],
      { leadId: await agentId(page, "Cy"), dailyTokenLimit: 50_000 },
    )
    await openChannel(page, docs)

    // The lead gives Bo two parts. The first one reports 51,000 tokens: the turn that runs goes to
    // its end, and its tokens count. The second part would start behind it, so it ends as Blocked
    // at once, with no model call.
    await say(page, "split limit job")
    const chip = page.locator("[data-testid=part-chip][data-state=blocked]")
    await expect(chip).toHaveCount(1, { timeout: 30_000 })
    await expect(chip).toContainText("Check the facts")
    await expect(limitLine(page)).toHaveText("The daily token limit of Docs is used.")
    await shot(page, "s112-07-part-blocked")
    // The part and the job of the lead end as Blocked, with the same reason: the lead cannot look
    // at the end of the work while the limit is used. The first part is done.
    const ended = await tasksOf(page)
    expect(ended.filter((t) => t.state === "blocked").map((t) => t.error)).toEqual([
      { code: "channel_limit", detail: "Docs" },
      { code: "channel_limit", detail: "Docs" },
    ])
    expect(ended.filter((t) => t.state === "done").map((t) => t.prompt)).toEqual([
      "Write the intro USAGE 51000/0",
    ])
    const asked = (text: string) =>
      mock.requests.some(
        (r) => r.path === "/v1/chat/completions" && JSON.stringify(r.body).includes(text),
      )
    expect(asked("Check the facts USAGE")).toBe(false)
    await expect(page.locator("[data-kind=summary]")).toHaveCount(0)
    // Today shows the blocked job of the lead as it shows other blocked work: one row.
    await page.getByTestId("page-today").click()
    const wrong = page
      .getByTestId("today-group-wrong")
      .locator("[data-testid=today-row][data-kind=task_blocked]")
    await expect(wrong).toHaveCount(1)
    await expect(wrong.getByTestId("today-line")).toContainText("split limit job")

    // Raise the limit, and press Retry on the part: it runs.
    await openChannel(page, docs)
    await openSettings(page)
    await page.getByTestId("channel-limit").fill("100,000")
    await page.getByTestId("channel-submit").click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
    await expect(limitLine(page)).toHaveCount(0)
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
    await openChannel(page, docs)
    await expect(limitLine(page)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("the limit of a parent channel stops its lower channels and names the parent; the usage page and Korean", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
    const product = await makeChannel(page, "Product", [await agentId(page, "Ada")], {
      dailyTokenLimit: 50_000,
    })
    const docs = await makeChannel(page, "Docs", [await agentId(page, "Bo")], {
      parentId: product.id,
    })
    const site = await makeChannel(page, "Site", [await agentId(page, "Cy")], {
      parentId: docs.id,
    })

    // The tasks of the lower channels count for Product: 30,000 in Docs and 25,000 in Site.
    await openChannel(page, docs)
    await say(page, "@Bo draft the page USAGE 30000/0")
    await expect(page.locator("[data-testid=message][data-author=agent]")).toHaveCount(1, {
      timeout: 30_000,
    })
    await idle(page)
    await expect(limitLine(page)).toHaveCount(0)
    await openChannel(page, site)
    await say(page, "@Cy draft the site USAGE 25000/0")
    await expect(limitLine(page)).toHaveText("The daily token limit of Product is used.", {
      timeout: 30_000,
    })
    await idle(page)

    // A new task of Site ends as Blocked, and the reason names Product. Docs and Product too.
    await say(page, "@Cy draft more USAGE 100/10")
    await expect
      .poll(async () => (await tasksOf(page)).filter((t) => t.state === "blocked").length, {
        timeout: 30_000,
      })
      .toBe(1)
    expect((await tasksOf(page)).find((t) => t.state === "blocked")?.error).toEqual({
      code: "channel_limit",
      detail: "Product",
    })
    await shot(page, "s112-08-parent-limit-site")
    await openChannel(page, docs)
    await expect(limitLine(page)).toHaveText("The daily token limit of Product is used.")
    await openChannel(page, product)
    await expect(limitLine(page)).toHaveText("The daily token limit of Product is used.")

    // The usage page lists Product only: Docs and Site have no limit of their own. It shows the
    // tokens of the lower channels in the total of Product.
    await page.getByTestId("page-usage").click()
    await expect(page.getByTestId("usage-channel-row")).toHaveCount(1)
    const row = page.locator("[data-testid=usage-channel-row][data-channel=Product]")
    await expect(row.getByTestId("usage-channel-used")).toHaveText("55,000")
    await expect(row.getByTestId("usage-channel-limit")).toHaveText("50,000")

    // Korean: the line, the field, the part and the usage page are Korean.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
    await page.getByTestId("settings-close").click()
    await expect(page.getByTestId("usage-page")).toContainText("채널의 하루 토큰 한도")
    await expect(page.getByTestId("usage-channels")).toContainText("오늘 사용량")
    await expect(row.getByTestId("usage-channel-limit")).toHaveText("50,000")
    await page.getByTestId("page-chats").click()
    await openChannel(page, site)
    await expect(limitLine(page)).toHaveText("Product의 하루 토큰 한도를 모두 사용했어요.")
    await shot(page, "s112-09-parent-limit-ko")
    await openSettings(page)
    await expect(page.getByTestId("channel-daily-limit")).toContainText("하루 토큰 한도")
    await expect(page.getByTestId("channel-tools")).toContainText("이 채널의 도구")
    await shot(page, "s112-10-settings-ko")
    await page.getByTestId("channel-dialog").getByRole("button", { name: "취소" }).click()
    await page.getByTestId("page-today").click()
    await page.getByTestId("today-group-wrong").getByTestId("today-row").click()
    await expect(page.getByTestId("task-error")).toHaveText(
      "Product의 하루 토큰 한도를 모두 사용했어요.",
    )
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

test("a linked computer with the switch changes the limit and reads the tools; with the switch off it reads the lines From <channel> only", async () => {
  test.setTimeout(300_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const two: Launched = await launch(freshUserData(), envFor(PORT_2))
  const one: Launched = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(one.app, 1300, 900)
    await resizeWindow(two.app, 1300, 900)
    // MacBook 2 holds the agent, the channel, the skill and the switch of the channel.
    const serverId = await localServerId(two.page)
    const ada = await rpc<{ id: string }>(two.page, "agents.create", {
      serverId,
      name: "Ada",
      role: "",
      instructions: "",
    })
    const docs = await makeChannel(two.page, "Docs", [ada.id])
    const skill = await rpc<{ id: string }>(two.page, "skills.create", {
      serverId,
      name: "Release notes",
      description: "",
      instructions: "Write the release notes.",
      agentIds: [ada.id],
      channelIds: [],
    })
    await rpc(two.page, "channelTools.set", {
      channelId: docs.id,
      kind: "skill",
      id: skill.id,
      on: true,
    })
    await pairOneWay(one, two, true)

    // MacBook 1 opens the channel of MacBook 2. The limit field works, with the switch on.
    await tile(one.page, "MacBook 2").click()
    await openChannel(one.page, docs)
    await openSettings(one.page)
    await one.page.getByTestId("channel-daily-limit").getByTestId("channel-limit-switch").click()
    await one.page.getByTestId("channel-limit").fill("20,000")
    // The part "Tools of this channel" is there to read: the switch of the skill cannot change.
    await expect(one.page.getByTestId("channel-tools-linked")).toContainText(
      "These tools are kept on MacBook 2. You can read them here and change them there.",
    )
    const row = toolRow(one.page, "Release notes")
    await expect(row.getByTestId("channel-tool-switch")).toBeDisabled()
    await expect(row.getByTestId("channel-tool-switch")).toHaveAttribute("aria-checked", "true")
    await one.page.getByTestId("channel-tools").scrollIntoViewIfNeeded()
    await shot(one.page, "s112-16-linked-tools-read-only")
    await one.page.getByTestId("channel-submit").click()
    await expect(one.page.getByTestId("channel-dialog")).toHaveCount(0)
    await expect
      .poll(
        async () => (await channelsOf(two.page)).find((c) => c.name === "Docs")?.dailyTokenLimit,
      )
      .toBe(20_000)
    // The link has no way to change the tools of a channel.
    await expect(
      rpc(one.page, "channelTools.set", {
        channelId: docs.id,
        kind: "skill",
        id: skill.id,
        on: false,
      }),
    ).rejects.toThrow()
    expect(
      (await rpc<{ on: boolean }[]>(two.page, "channelTools.list", { channelId: docs.id })).map(
        (r) => r.on,
      ),
    ).toEqual([true])

    // The profile of the agent on MacBook 1 shows the line, read-only.
    await openAgent(one.page, "Ada")
    expect(await profileLines(one.page)).toEqual(["Release notes From Docs"])

    // The user turns the switch off on MacBook 2: the settings of the channel are gone on MacBook
    // 1, so it changes nothing of this spec. It still reads the line in the profile.
    await openDevices(two.page)
    await two.page.locator("[data-testid=client-can-change]").first().click()
    await expect(two.page.locator("[data-testid=client-can-change]").first()).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await closeSettings(two.page)
    await expect(one.page.getByTestId("new-channel")).toHaveCount(0)
    await openChannel(one.page, docs)
    await expect(one.page.getByTestId("channel-settings")).toHaveCount(0)
    await openAgent(one.page, "Ada")
    expect(await profileLines(one.page)).toEqual(["Release notes From Docs"])
    // The limit that MacBook 1 set is still on MacBook 2, and the line of the channel is read there.
    await expect(limitLine(one.page)).toHaveCount(0)
    expect((await channelsOf(two.page)).find((c) => c.name === "Docs")?.dailyTokenLimit).toBe(
      20_000,
    )
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
  }
})

test("sync: the limit and the tree go to the other computer, the tools of a channel stay with the skills of each computer; an export and a restore bring back the limit and the lists of skills", async () => {
  test.setTimeout(300_000)
  const work = freshUserData()
  const archive = join(work, "export.zip")
  const s = await synced(await freePortPair(), [{ ROBOT_TEST_SAVE_PATH: archive }, {}])
  const { one, two } = s
  try {
    const serverId = await localServerId(one.page)
    const product = await makeChannel(one.page, "Product", [], { dailyTokenLimit: 50_000 })
    const docs = await makeChannel(one.page, "Docs", [], { parentId: product.id })
    // A skill of MacBook 1 that Product gives. Skills do not sync (spec 019).
    await rpc(one.page, "skills.create", {
      serverId,
      name: "Release notes",
      description: "",
      instructions: "Write the release notes.",
      agentIds: [],
      channelIds: [product.id],
    })
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)

    // The parent channel and the limit show on both computers.
    const shown = async (page: Page) =>
      (await channelsOf(page))
        .map((c) => `${c.name}:${c.dailyTokenLimit ?? "off"}:${c.parentId ? "sub" : "top"}`)
        .sort()
    await expect
      .poll(() => shown(two.page), { timeout: 30_000 })
      .toEqual(["Docs:off:sub", "Product:50000:top"])
    // A change of the limit on MacBook 2 goes to MacBook 1. Docs has its own limit now.
    await rpc(two.page, "channels.update", { id: docs.id, patch: { dailyTokenLimit: 30_000 } })
    await expect
      .poll(() => shown(one.page), { timeout: 30_000 })
      .toEqual(["Docs:30000:sub", "Product:50000:top"])
    // The usage page of MacBook 2 lists the two limits from its own count of today.
    await two.page.getByTestId("page-usage").click()
    await expect(two.page.getByTestId("usage-channel-row")).toHaveCount(2)
    await expect(
      two.page
        .locator("[data-testid=usage-channel-row][data-channel=Docs]")
        .getByTestId("usage-channel-limit"),
    ).toHaveText("30,000")

    // The part "Tools of this channel" shows each computer's own skills: MacBook 2 has none of the
    // skill of MacBook 1, and the other way round.
    const rows = (page: Page) =>
      rpc<{ name: string; on: boolean }[]>(page, "channelTools.list", {
        channelId: product.id,
      }).then((r) => r.map((x) => `${x.name}:${x.on}`))
    expect(await rows(one.page)).toEqual(["Release notes:true"])
    expect(await rows(two.page)).toEqual([])
    const own = await rpc<{ id: string }>(two.page, "skills.create", {
      serverId: await localServerId(two.page),
      name: "Local only",
      description: "",
      instructions: "Only here.",
      agentIds: null,
      channelIds: [],
    })
    expect(own.id).toBeTruthy()
    expect(await rows(one.page)).toEqual(["Release notes:true"])

    // Export on MacBook 1 and restore into an empty app: the tree, the limits and the channel in
    // the list of the skill come back.
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
      const back = await rpc<{ name: string; channelIds: string[] }[]>(third.page, "skills.list", {
        serverId: await localServerId(third.page),
      })
      expect(back.map((x) => [x.name, x.channelIds.length])).toEqual([["Release notes", 1]])
      expect(back[0]?.channelIds).toEqual([product.id])
      // The skill form on the restored computer shows the channel ticked, with its mark.
      await third.page.getByTestId("settings-nav-skills").click()
      await third.page
        .locator("[data-testid=skill-row][data-skill='Release notes']")
        .getByTestId("skill-edit")
        .click()
      await expect(
        third.page.locator("[data-testid=skill-channel][data-channel=Product]"),
      ).toBeChecked()
      await expect(third.page.getByTestId("skill-channel-mark").first()).toHaveText("channel")
      await shot(third.page, "s112-17-restored-skill-channel")
    } finally {
      await third.app.close().catch(() => {})
    }
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})
