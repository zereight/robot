import { join, resolve } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
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

// Spec 030, "Access" and "Tools" (S128), with 017, 018, 002 (flow 12), 007 and 012: the tools of an
// organization with the values "Inherit", "On" and "Off", the muted line "Now: <value> from
// <organization>", the pickers of the skill form and the connection form, "From <organization>" in
// the profile, and the rule that "Off" takes away only what the organization would get from above.
// It replaces the end-to-end spec of the tools of a channel (S112): the channels have no tools now.

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
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
const makeOrg = async (page: Page, name: string, members: string[], parent?: string) =>
  rpc<OrgInfo>(page, "organizations.create", {
    serverId: await serverIdOf(page),
    name,
    memberIds: await Promise.all(members.map((m) => agentIdOf(page, m))),
    leadId: null,
    ...(parent ? { parentId: (await orgByName(page, parent)).id } : {}),
  })

const skillIdOf = async (page: Page, name: string) =>
  (
    await rpc<{ id: string; name: string }[]>(page, "skills.list", {
      serverId: await serverIdOf(page),
    })
  ).find((s) => s.name === name)?.id as string

const SERVER = resolve(import.meta.dirname, "fakes/mcp-server.mjs")
const CHAT = "/v1/chat/completions"
const openAgent = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]").filter({ hasText: name }).click()
const skillOption = (page: Page, name: string) =>
  page.locator(`[data-testid=skill-option][data-skill='${name}']`)
const idle = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
/** The names of the tools in the newest chat request to the stand-in model. */
const toolsOfLastRequest = (mock: Awaited<ReturnType<typeof startMockProvider>>) => {
  const chats = mock.requests.filter((r) => r.path === CHAT)
  const body = chats.at(-1)?.body as { tools?: { function?: { name?: string } }[] } | undefined
  return (body?.tools ?? []).map((t) => t.function?.name ?? "")
}
/** What the profile of the open agent says about the tools that it has from organizations. */
const profileLines = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  // Each line holds the name of the tool and the line "From <organization>", in two spans.
  const lines = await page
    .getByTestId("org-tool-line")
    .evaluateAll((els) =>
      els.map((el) => [...el.children].map((c) => c.textContent?.trim() ?? "").join(" ")),
    )
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  return lines
}

const closeSettingsIfOpen = async (page: Page) => {
  const close = page.getByTestId("settings-close")
  if (await close.isVisible().catch(() => false)) await close.click()
}
/** Opens the org chart: the way in to the form of an organization. */
const openOrgPart = async (page: Page) => {
  await closeSettingsIfOpen(page)
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
}
const orgNode = (page: Page, name: string) =>
  page
    .getByTestId("org-unit")
    .filter({ has: page.getByTestId("org-unit-name").getByText(name, { exact: true }) })
const dialog = (page: Page) => page.getByTestId("org-dialog")
const closeDialog = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
}
/** Opens the form of an organization from the chart. */
const openOrg = async (page: Page, name: string) => {
  await openOrgPart(page)
  await orgNode(page, name).click()
  await expect(dialog(page)).toBeVisible()
}
/** The row of a skill or a connection in the part "Tools" of the open form. */
const toolRow = (page: Page, name: string) =>
  page.locator(`[data-testid=org-tool-row][data-name='${name}']`)
const rowValue = (row: Locator, value: string) =>
  row.locator(`[data-testid=org-tool-value] label[data-value=${value}]`)
/** Sets the value of a row and checks that the row shows it. */
const setValue = async (page: Page, name: string, value: "inherit" | "on" | "off") => {
  const row = toolRow(page, name)
  await rowValue(row, value).click()
  await expect(rowValue(row, value).locator("input")).toBeChecked()
}

const startOne = async (locale = "en-US") => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: locale,
    ROBOT_TEST_HOME: freshUserData(),
  })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  return { mock, app, page }
}

test("tools by organizations: Inherit, On and Off with the line Now, the pickers, From <organization> in the profile, and the next turn", async () => {
  test.setTimeout(420_000)
  const { mock, app, page } = await startOne()
  try {
    for (const name of ["Ada", "Bo", "Cy", "Dee", "Di"]) await createAgent(page, name)
    // Product holds Docs, and Docs holds Site. Bo is a member of Product and of Docs (one line).
    await makeOrg(page, "Product", ["Ada", "Bo"])
    await makeOrg(page, "Docs", ["Bo", "Dee"], "Product")
    await makeOrg(page, "Site", ["Cy"], "Docs")

    // --- A skill for all agents, and a skill for the agent Di with the three values in the picker --
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
    // The picker lists the agents, then the organizations, each with the mark "organization" and
    // the three values (spec 030, "Tools"). A new row shows "Inherit".
    await expect(page.getByTestId("skill-agent")).toHaveCount(5)
    await expect(page.getByTestId("skill-org")).toHaveCount(3)
    await expect(page.getByTestId("skill-org-mark")).toHaveText([
      "organization",
      "organization",
      "organization",
    ])
    const pickerRow = (name: string) => page.locator(`[data-testid=skill-org][data-org='${name}']`)
    const pickerValue = (name: string, value: string) =>
      pickerRow(name).locator(`[data-testid=skill-org-value] label[data-value=${value}]`)
    for (const name of ["Product", "Docs", "Site"]) {
      await expect(pickerRow(name).locator("[data-testid=skill-org-value] label")).toHaveText([
        "Inherit",
        "On",
        "Off",
      ])
      await expect(pickerValue(name, "inherit").locator("input")).toBeChecked()
    }
    await page.locator("[data-testid=skill-agent][data-agent=Di]").check()
    await pickerRow("Docs").scrollIntoViewIfNeeded()
    await shot(page, "s128-01-skill-picker")
    await page.getByTestId("skill-save").click()
    await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
    const skillRow = page.locator("[data-testid=skill-row][data-skill='Release notes']")
    await expect(skillRow.getByTestId("skill-row-agents")).toHaveText("Di")
    await page.getByTestId("settings-close").click()

    // Nobody in Product, Docs or Site has the skill yet. Cy sees only the skill for all agents.
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Weekly summary")).toHaveCount(1)
    await expect(skillOption(page, "Release notes")).toHaveCount(0)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual([])

    // --- The part "Tools" of Product: "Inherit", the line "Now: none", then "On" -----------------
    await openOrg(page, "Product")
    await expect(page.getByTestId("org-tools")).toContainText("Tools")
    // The skill for all agents shows "On" and cannot change; it has no line "Now".
    const weekly = toolRow(page, "Weekly summary")
    await expect(weekly.getByTestId("org-tool-all")).toBeVisible()
    await expect(rowValue(weekly, "on").locator("input")).toBeChecked()
    await expect(rowValue(weekly, "inherit").locator("input")).toBeDisabled()
    await expect(rowValue(weekly, "off").locator("input")).toBeDisabled()
    await expect(weekly.getByTestId("org-tool-now")).toHaveCount(0)
    const release = toolRow(page, "Release notes")
    await expect(rowValue(release, "inherit").locator("input")).toBeChecked()
    // A top organization with "Inherit" has no tool: "Now: none".
    await expect(release.getByTestId("org-tool-now")).toHaveText("Now: none")
    await setValue(page, "Release notes", "on")
    // The line "Now" shows only under "Inherit".
    await expect(release.getByTestId("org-tool-now")).toHaveCount(0)
    await closeDialog(page)

    // The forms of the lower organizations show where the value comes from.
    await openOrg(page, "Site")
    await expect(toolRow(page, "Release notes").getByTestId("org-tool-now")).toHaveText(
      "Now: On from Product",
    )
    await shot(page, "s128-02-site-now-on-from-product")
    await closeDialog(page)
    await openOrg(page, "Docs")
    await expect(toolRow(page, "Release notes").getByTestId("org-tool-now")).toHaveText(
      "Now: On from Product",
    )
    await closeDialog(page)

    // The skill form shows "Product" with the mark and the value "On"; the list says who may use it.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-skills").click()
    await expect(skillRow.getByTestId("skill-row-agents")).toHaveText("Di, Product")
    await skillRow.getByTestId("skill-edit").click()
    await expect(pickerValue("Product", "on").locator("input")).toBeChecked()
    await expect(pickerValue("Docs", "inherit").locator("input")).toBeChecked()
    await page.getByTestId("skill-cancel").click()
    await page.getByTestId("settings-close").click()

    // --- A member of Site (two levels below) has the skill in its direct chat, with the line -----
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("agent-profile")).toBeVisible()
    const lines = page.getByTestId("org-tool-line")
    await expect(lines).toHaveCount(1)
    await expect(lines.first()).toContainText("Release notes")
    await expect(lines.first().getByTestId("org-tool-from")).toHaveText("From Product")
    await page.getByTestId("agent-profile").getByTestId("org-tools-lines").scrollIntoViewIfNeeded()
    await shot(page, "s128-03-profile-from-product")
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
    // Ada and Bo (members of Product) and Dee (a member of Docs) have it too. Di has it from its
    // own list, not from an organization, so the profile of Di has no line.
    for (const name of ["Ada", "Bo", "Dee"]) {
      await openAgent(page, name)
      expect(await profileLines(page)).toEqual(["Release notes From Product"])
    }
    await openAgent(page, "Di")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual([])

    // --- "Off" in Docs: Docs and Site lose the skill, Product keeps it ---------------------------
    await openOrg(page, "Docs")
    await setValue(page, "Release notes", "off")
    await expect(toolRow(page, "Release notes").getByTestId("org-tool-now")).toHaveCount(0)
    await shot(page, "s128-04-docs-off")
    await closeDialog(page)
    await openOrg(page, "Site")
    await expect(toolRow(page, "Release notes").getByTestId("org-tool-now")).toHaveText(
      "Now: Off from Docs",
    )
    await closeDialog(page)
    // Cy (Site) and Dee (Docs only) lose it from the next turn.
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Weekly summary")).toHaveCount(1)
    await expect(skillOption(page, "Release notes")).toHaveCount(0)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual([])
    await openAgent(page, "Dee")
    expect(await profileLines(page)).toEqual([])
    // Ada (Product) keeps it. Bo is a member of Docs and of Product: Product still gives it.
    await openAgent(page, "Ada")
    expect(await profileLines(page)).toEqual(["Release notes From Product"])
    await openAgent(page, "Bo")
    expect(await profileLines(page)).toEqual(["Release notes From Product"])
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")

    // --- "On" in Site gives it back to the members of Site only ---------------------------------
    await openOrg(page, "Site")
    await setValue(page, "Release notes", "on")
    await closeDialog(page)
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual(["Release notes From Site"])
    await openAgent(page, "Dee")
    expect(await profileLines(page)).toEqual([])

    // --- "All agents" is on: "Off" in Docs takes nothing away -------------------------------------
    const docs = await orgByName(page, "Docs")
    const rows = await rpc<{ name: string; choice: string; all: boolean }[]>(page, "orgTools.set", {
      orgId: docs.id,
      kind: "skill",
      id: await skillIdOf(page, "Weekly summary"),
      choice: "off",
    })
    expect(rows.find((r) => r.name === "Weekly summary")).toMatchObject({
      choice: "on",
      all: true,
    })
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Weekly summary")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")

    // --- Remove the member from Site: the next turn has no such skill ----------------------------
    const cyId = await agentIdOf(page, "Cy")
    const site = await orgByName(page, "Site")
    await rpc(page, "organizations.update", { id: site.id, patch: { memberIds: [] } })
    await openAgent(page, "Ada")
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Weekly summary")).toHaveCount(1)
    await expect(skillOption(page, "Release notes")).toHaveCount(0)
    await page.getByTestId("composer-input").fill("")
    expect(await profileLines(page)).toEqual([])
    // The member comes back: the skill comes back with it.
    await rpc(page, "organizations.update", { id: site.id, patch: { memberIds: [cyId] } })
    await openAgent(page, "Ada")
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("/")
    await expect(skillOption(page, "Release notes")).toHaveCount(1)
    await page.getByTestId("composer-input").fill("")

    // --- A connection that Docs gives: the picker, the same approval card, and "Off" ---------------
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-connections").click()
    await page.getByTestId("connection-add").click()
    await page.getByTestId("connection-name").fill("Notes")
    await page.getByTestId("connection-command").fill(process.execPath)
    await page.getByTestId("connection-args").fill(SERVER)
    await page.getByTestId("connection-agents-mode").getByText("Some agents").click()
    await expect(page.getByTestId("connection-org")).toHaveCount(3)
    await expect(page.getByTestId("connection-org-mark")).toHaveText([
      "organization",
      "organization",
      "organization",
    ])
    const connValue = (name: string, value: string) =>
      page.locator(
        `[data-testid=connection-org][data-org='${name}'] [data-testid=connection-org-value] label[data-value=${value}]`,
      )
    await expect(connValue("Docs", "inherit").locator("input")).toBeChecked()
    await connValue("Docs", "on").click()
    await expect(connValue("Docs", "on").locator("input")).toBeChecked()
    await shot(page, "s128-05-connection-picker")
    await page.getByTestId("connection-test").click()
    await expect(page.getByTestId("connection-test-result")).toContainText("Connected. Tools: 8.")
    await page.getByTestId("connection-confirm").check()
    await page.getByTestId("connection-save").click()
    await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
    const notes = page.locator("[data-testid=connection-row][data-connection=Notes]")
    await expect(notes.getByTestId("connection-row-agents")).toHaveText("Docs")
    await page.getByTestId("settings-close").click()
    // Docs is one level above Site: Cy has the connection from Docs. The skill comes from Site.
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("hello Cy")
    await page.getByTestId("composer-input").press("Enter")
    await idle(page)
    expect(toolsOfLastRequest(mock)).toContain("mcp__notes__echo")
    expect(await profileLines(page)).toEqual(["Release notes From Site", "Notes From Docs"])
    // Ada is in Product, a higher organization of Docs: a tool of a lower organization does not go up.
    await openAgent(page, "Ada")
    await page.getByTestId("composer-input").fill("hello Ada")
    await page.getByTestId("composer-input").press("Enter")
    await idle(page)
    expect(toolsOfLastRequest(mock)).not.toContain("mcp__notes__echo")
    // The call of Cy asks the same approval as before (spec 007, 018).
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill('TOOL mcp__notes__echo {"text":"hi"}')
    await page.getByTestId("composer-input").press("Enter")
    const ask = page.getByTestId("ask-card")
    await expect(ask).toBeVisible({ timeout: 15_000 })
    await expect(ask).toContainText("Notes · echo")
    await shot(page, "s128-06-approval-card")
    await page.getByTestId("ask-deny").click()
    await idle(page)
    // "Off" for the connection in Docs takes it away from the next turn.
    await openOrg(page, "Docs")
    await expect(rowValue(toolRow(page, "Notes"), "on").locator("input")).toBeChecked()
    await setValue(page, "Notes", "off")
    await closeDialog(page)
    await openAgent(page, "Cy")
    await page.getByTestId("composer-input").fill("hello again")
    await page.getByTestId("composer-input").press("Enter")
    await idle(page)
    expect(toolsOfLastRequest(mock)).not.toContain("mcp__notes__echo")
    expect(await profileLines(page)).toEqual(["Release notes From Site"])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("tools in Korean and in the narrowest window: the values, the line Now and the pickers fit and have no English left", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne("ko-KR")
  try {
    for (const name of ["Ada", "Bo"]) await createAgent(page, name)
    await makeOrg(page, "Product", ["Ada"])
    await makeOrg(page, "Docs", ["Bo"], "Product")
    const product = await orgByName(page, "Product")
    const serverId = await serverIdOf(page)
    const adaId = await agentIdOf(page, "Ada")
    // One skill that Product turns on, and one that nobody gives.
    await rpc(page, "skills.create", {
      serverId,
      name: "Release notes",
      description: "Write.",
      instructions: "Write.",
      agentIds: [adaId],
      organizations: [{ id: product.id, value: "on" }],
    })
    await rpc(page, "skills.create", {
      serverId,
      name: "Weekly summary",
      description: "Write.",
      instructions: "Write.",
      agentIds: [adaId],
    })

    await openOrg(page, "Docs")
    await resizeWindow(app, 480, 600)
    const release = toolRow(page, "Release notes")
    await expect(release.locator("[data-testid=org-tool-value] label")).toHaveText([
      "상속",
      "켬",
      "끔",
    ])
    await expect(release.getByTestId("org-tool-now")).toHaveText("지금: 켬, Product에서 받음")
    await expect(toolRow(page, "Weekly summary").getByTestId("org-tool-now")).toHaveText(
      "지금: 없음",
    )
    await setValue(page, "Release notes", "off")
    await expect(release.getByTestId("org-tool-now")).toHaveCount(0)
    await release.scrollIntoViewIfNeeded()
    await shot(page, "s128-07-korean-narrow-tools")
    // The box fits the window: nothing sticks out on the right.
    const width = await page.evaluate(() => window.innerWidth)
    for (const row of await page.getByTestId("org-tool-row").all()) {
      const rect = (await row.boundingBox()) as { x: number; width: number }
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(width)
    }
    // "Off" read back: Docs shows the value, and the line "Now" comes back after "Inherit".
    await setValue(page, "Release notes", "inherit")
    await expect(release.getByTestId("org-tool-now")).toHaveText("지금: 켬, Product에서 받음")
    await closeDialog(page)

    // The picker of the skill form: the values and the mark in Korean.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-skills").click()
    await page
      .locator("[data-testid=skill-row][data-skill='Release notes']")
      .getByTestId("skill-edit")
      .click()
    await expect(page.getByTestId("skill-org-mark").first()).toHaveText("조직")
    await expect(
      page
        .locator("[data-testid=skill-org][data-org=Docs]")
        .locator("[data-testid=skill-org-value] label"),
    ).toHaveText(["상속", "켬", "끔"])
    await page.getByTestId("skill-org").first().scrollIntoViewIfNeeded()
    await shot(page, "s128-08-korean-narrow-picker")
    const rect = (await page.getByTestId("skill-org").first().boundingBox()) as {
      x: number
      width: number
    }
    expect(rect.x + rect.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// --- A linked computer (spec 012): the tools are read only, with or without the switch ----------

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const linkedServerId = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const result = await (window as any).robot.invoke("servers.list")
    return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
  }) as Promise<string>
const askServer = (page: Page, serverId: string, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i, s]) => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const r = await (window as any).robot.invoke(m, i, s)
      return r.ok ? "ok" : (r.error.code as string)
    },
    [method, input, serverId] as [string, unknown, string],
  )

/** MacBook 2 shows a code; MacBook 1 connects one way. `canChange` is the switch of the dialog. */
const pairOneWay = async (one: Launched, two: Launched, canChange: boolean) => {
  await openDevices(two.page)
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
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  if (!canChange) await two.page.getByTestId("join-can-change").click()
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

const startPair = async () => {
  const ports = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(ports[1]))
  const one = await launch(freshUserData(), envFor(ports[0]))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 1200, 860)
  await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
  await openDevices(two.page)
  await setName(two.page, "MacBook 2")
  await closeSettings(two.page)
  await openDevices(one.page)
  await setName(one.page, "MacBook 1")
  await closeSettings(one.page)
  return { mock, one, two }
}

for (const canChange of [true, false]) {
  test(`a linked computer ${canChange ? "with" : "without"} the switch reads the tools of an organization with their values and the line Now, and changes none of them`, async () => {
    test.setTimeout(300_000)
    const { mock, one, two } = await startPair()
    try {
      await createAgent(two.page, "Ada")
      await createAgent(two.page, "Bo")
      await makeOrg(two.page, "Product", ["Ada"])
      await makeOrg(two.page, "Docs", ["Bo"], "Product")
      const product = await orgByName(two.page, "Product")
      const docs = await orgByName(two.page, "Docs")
      await rpc(two.page, "skills.create", {
        serverId: await serverIdOf(two.page),
        name: "Release notes",
        description: "Write.",
        instructions: "Write.",
        agentIds: [await agentIdOf(two.page, "Bo")],
        organizations: [
          { id: product.id, value: "on" },
          { id: docs.id, value: "off" },
        ],
      })
      await pairOneWay(one, two, canChange)
      await closeSettings(two.page)
      await tile(one.page, "MacBook 2").click()

      // Product shows "On", Docs shows "Off": the values of the server, read only (spec 030, 012).
      await openOrg(one.page, "Product")
      await expect(one.page.getByTestId("org-tools-linked")).toContainText("MacBook 2")
      const productRow = toolRow(one.page, "Release notes")
      await expect(rowValue(productRow, "on").locator("input")).toBeChecked()
      for (const value of ["inherit", "on", "off"])
        await expect(rowValue(productRow, value).locator("input")).toBeDisabled()
      await closeDialog(one.page)
      await openOrg(one.page, "Docs")
      const docsRow = toolRow(one.page, "Release notes")
      await expect(rowValue(docsRow, "off").locator("input")).toBeChecked()
      await expect(docsRow.getByTestId("org-tool-now")).toHaveCount(0)
      await shot(one.page, `s128-09-linked-${canChange ? "with" : "without"}-switch`)
      await closeDialog(one.page)

      // The server refuses a change of a tool from a link, also with the switch.
      const serverId = await linkedServerId(one.page)
      expect(
        await askServer(one.page, serverId, "orgTools.set", {
          orgId: docs.id,
          kind: "skill",
          id: await skillIdOf(two.page, "Release notes"),
          choice: "on",
        }),
      ).toBe("not_allowed")
      const stored = await rpc<{ name: string; choice: string }[]>(two.page, "orgTools.list", {
        orgId: docs.id,
      })
      expect(stored.map((r) => [r.name, r.choice])).toEqual([["Release notes", "off"]])
    } finally {
      await one.app.close().catch(() => {})
      await two.app.close().catch(() => {})
      await mock.close()
    }
  })
}

// --- Two computers and the archive (spec 019, 014) ------------------------------------------------

test("sync and export: the tree goes to the other computer, the tools of an organization stay with the skills of each computer, and a restore brings back On and Off", async () => {
  test.setTimeout(300_000)
  const work = freshUserData()
  const archive = join(work, "export.zip")
  const s = await synced(await freePortPair(), [{ ROBOT_TEST_SAVE_PATH: archive }, {}])
  const { one, two } = s
  try {
    const serverId = await serverIdOf(one.page)
    const ada = await rpc<{ id: string }>(one.page, "agents.create", {
      serverId,
      name: "Ada",
      role: "",
      instructions: "",
    })
    const product = await makeOrg(one.page, "Product", ["Ada"])
    const docs = await makeOrg(one.page, "Docs", [], "Product")
    // A skill of MacBook 1 that Product turns on and Docs turns off. Skills do not sync (019).
    await rpc(one.page, "skills.create", {
      serverId,
      name: "Release notes",
      description: "",
      instructions: "Write the release notes.",
      agentIds: [ada.id],
      organizations: [
        { id: product.id, value: "on" },
        { id: docs.id, value: "off" },
      ],
    })
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)

    // The tree goes to MacBook 2. Its part "Tools" shows its own skills: none of MacBook 1.
    await expect
      .poll(async () => (await orgsOf(two.page)).map((o) => [o.name, o.parentId ? "sub" : "top"]), {
        timeout: 30_000,
      })
      .toEqual([
        ["Docs", "sub"],
        ["Product", "top"],
      ])
    const rows = (page: Page, orgId: string) =>
      rpc<{ name: string; choice: string }[]>(page, "orgTools.list", { orgId }).then((r) =>
        r.map((x) => `${x.name}:${x.choice}`),
      )
    expect(await rows(one.page, product.id)).toEqual(["Release notes:on"])
    expect(await rows(one.page, docs.id)).toEqual(["Release notes:off"])
    expect(await rows(two.page, product.id)).toEqual([])
    // A skill that only MacBook 2 has does not reach MacBook 1.
    await rpc(two.page, "skills.create", {
      serverId: await serverIdOf(two.page),
      name: "Local only",
      description: "",
      instructions: "Only here.",
      agentIds: null,
    })
    expect(await rows(two.page, product.id)).toEqual(["Local only:on"])
    expect(await rows(one.page, product.id)).toEqual(["Release notes:on"])

    // Export on MacBook 1 and restore into an empty app: the values "On" and "Off" come back.
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
      const back = await rpc<{ name: string; organizations: { id: string; value: string }[] }[]>(
        third.page,
        "skills.list",
        { serverId: await serverIdOf(third.page) },
      )
      expect(back.map((x) => [x.name, x.organizations])).toEqual([
        [
          "Release notes",
          [
            { id: product.id, value: "on" },
            { id: docs.id, value: "off" },
          ],
        ],
      ])
      // The skill form on the restored computer shows the two values.
      await third.page.getByTestId("settings-nav-skills").click()
      await third.page
        .locator("[data-testid=skill-row][data-skill='Release notes']")
        .getByTestId("skill-edit")
        .click()
      const value = (name: string, v: string) =>
        third.page.locator(
          `[data-testid=skill-org][data-org='${name}'] [data-testid=skill-org-value] label[data-value=${v}] input`,
        )
      await expect(value("Product", "on")).toBeChecked()
      await expect(value("Docs", "off")).toBeChecked()
      await shot(third.page, "s128-10-restored-picker")
    } finally {
      await third.app.close().catch(() => {})
    }
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})
