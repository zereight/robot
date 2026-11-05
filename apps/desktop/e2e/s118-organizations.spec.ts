import { expect, type Locator, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// Spec 030, "Flows" 1, 2, 4 and 5, "Organization tree" and the part "Tools" (the value "Off" and the
// line "Now" are in s120-tools.spec.ts), with 002 (the row "Organizations"), 017 and 018 (the pickers), and 012
// (a linked computer with and without the switch "Can create and change agents"). The form opens
// from the org chart (029): the button "New organization" and a click on an organization node.

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
  memberIds: string[]
  leadId: string | null
}

const serverIdOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const orgsOf = async (page: Page) =>
  rpc<OrgInfo[]>(page, "organizations.list", { serverId: await serverIdOf(page) })
const orgByName = async (page: Page, name: string) =>
  (await orgsOf(page)).find((o) => o.name === name)
const agentIdOf = async (page: Page, name: string) =>
  (
    await rpc<{ id: string; name: string }[]>(page, "agents.list", {
      serverId: await serverIdOf(page),
      archived: false,
    })
  ).find((a) => a.name === name)?.id as string
const makeOrg = async (
  page: Page,
  name: string,
  members: string[],
  parent?: string,
  lead?: string,
) =>
  rpc<OrgInfo>(page, "organizations.create", {
    serverId: await serverIdOf(page),
    name,
    memberIds: await Promise.all(members.map((m) => agentIdOf(page, m))),
    leadId: lead ? await agentIdOf(page, lead) : null,
    ...(parent ? { parentId: (await orgByName(page, parent))?.id } : {}),
  })

/** Closes the settings page when it is open: the page button of the chart is behind it. */
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
/** The organization node of the chart with this name. */
const orgRow = (page: Page, name: string) =>
  page
    .getByTestId("org-unit")
    .filter({ has: page.getByTestId("org-unit-name").getByText(name, { exact: true }) })
const dialog = (page: Page) => page.getByTestId("org-dialog")
/** The field "Name" of the form. The chart has agent names with a similar test id. */
const orgName = (page: Page) => page.getByTestId("org-form").getByTestId("org-name")
const closeDialog = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
}
/** The option of the field "Parent organization" that starts with the name. */
const parentOption = (page: Page, name: string) =>
  page.getByTestId("org-parent").locator("option").filter({ hasText: name })

/** Fills the form of a new organization through the window. */
const fillNew = async (
  page: Page,
  name: string,
  options: { members?: string[]; lead?: string; parent?: string } = {},
) => {
  await page.getByTestId("org-new").click()
  await expect(dialog(page)).toBeVisible()
  await orgName(page).fill(name)
  for (const member of options.members ?? []) await page.getByTestId(`org-member-${member}`).check()
  if (options.lead) await page.getByTestId("org-lead").selectOption({ label: options.lead })
  if (options.parent) await page.getByTestId("org-parent").selectOption({ label: options.parent })
}
const create = async (page: Page, name: string, options: Parameters<typeof fillNew>[2] = {}) => {
  await fillNew(page, name, options)
  await page.getByTestId("org-submit").click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(orgRow(page, name)).toBeVisible()
}

const startOne = async (locale = "en-US") => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: locale })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  return { mock, app, page }
}

test("organizations: make them with the form, the tree rules show their reasons, a name is unique, and delete asks first", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne()
  try {
    for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
    await openOrgPart(page)
    // No organization yet: the chart has the node "No organization" with the three agents.
    await expect(page.getByTestId("org-unit")).toHaveCount(1)

    // --- Make "Product", "Docs" under it, and "Site" under "Docs" --------------------------
    await create(page, "Product", { members: ["Ada"], lead: "Ada" })
    await create(page, "Docs", { members: ["Bo"], parent: "Product" })
    await create(page, "Site", { members: ["Cy"], parent: "Docs" })
    const product = (await orgByName(page, "Product")) as OrgInfo
    // The chart draws the tree: a sub-organization node sits under the node of its parent.
    await expect(orgRow(page, "Docs")).toHaveAttribute("data-parent", `o:${product.id}`)
    await expect(orgRow(page, "Site")).toHaveAttribute(
      "data-parent",
      `o:${(await orgByName(page, "Docs"))?.id}`,
    )
    await expect(orgRow(page, "Product")).toHaveAttribute("data-parent", "")
    expect(product.leadId).toBe(await agentIdOf(page, "Ada"))
    expect((await orgByName(page, "Site"))?.parentId).toBe((await orgByName(page, "Docs"))?.id)
    await shot(page, "s118-01-list")

    // --- The parent field of "Product" shows "Docs" and "Site" muted with the reason ------------
    await orgRow(page, "Product").click()
    await expect(orgName(page)).toHaveValue("Product")
    for (const name of ["Docs", "Site"]) {
      const option = parentOption(page, name)
      await expect(option).toHaveAttribute("disabled", "")
      await expect(option).toHaveAttribute("data-refusal", "loop")
      await expect(option).toContainText("This is a sub-organization of this organization.")
    }
    await expect(page.getByTestId("org-parent")).toHaveValue("")
    await shot(page, "s118-02-parent-reasons")
    await closeDialog(page)

    // --- A fourth level is refused with its reason ---------------------------------------
    await fillNew(page, "Four")
    await expect(parentOption(page, "Site")).toHaveAttribute("disabled", "")
    await expect(parentOption(page, "Site")).toHaveAttribute("data-refusal", "levels")
    await expect(parentOption(page, "Site")).toContainText(
      "The tree would have more than 3 levels.",
    )
    await expect(parentOption(page, "Docs")).not.toHaveAttribute("disabled", "")
    await closeDialog(page)
    // The service refuses it too, for a caller that skips the form.
    const refused = await rpc(page, "organizations.create", {
      serverId: await serverIdOf(page),
      name: "Four",
      memberIds: [],
      leadId: null,
      parentId: (await orgByName(page, "Site"))?.id,
    }).catch((e: Error) => e.message)
    expect(String(refused)).toContain("org_parent_levels")

    // --- A name is unique, and the check ignores case ----------------------------------------
    await fillNew(page, "product")
    await page.getByTestId("org-submit").click()
    await expect(page.getByTestId("org-error")).toHaveText(
      "Another organization on this server has this name.",
    )
    await expect(dialog(page)).toBeVisible()
    await expect((await orgsOf(page)).filter((o) => /^product$/i.test(o.name))).toHaveLength(1)
    await closeDialog(page)

    // --- An organization with no member shows "No members." ----------------------------------
    await create(page, "Ops")
    await expect(orgRow(page, "Ops").getByTestId("org-unit-empty")).toHaveText("No members.")

    // --- Delete asks first. "Back" and Escape go back. ---------------------------------------
    await orgRow(page, "Site").click()
    await page.getByTestId("org-delete").click()
    await expect(page.getByTestId("org-delete-confirm")).toBeVisible()
    await expect(page.getByTestId("org-delete-confirm")).toContainText("Delete Site?")
    // "Site" has no lower organization: the line is not there.
    await expect(page.getByTestId("org-delete-lower")).toHaveCount(0)
    await expect(page.getByTestId("org-delete-back")).toBeFocused()
    await page.getByTestId("org-delete-back").click()
    await expect(page.getByTestId("org-delete-confirm")).toHaveCount(0)
    await page.getByTestId("org-delete").click()
    // Escape goes back from the confirm, and the form stays open.
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("org-delete-confirm")).toHaveCount(0)
    await expect(dialog(page)).toBeVisible()
    await closeDialog(page)
    expect(await orgByName(page, "Site")).toBeDefined()

    // "Docs" is under "Product" and has one sub-organization ("Site"). The confirm says that it
    // moves up to "Product" (spec 030, flow 4 and its acceptance), and nothing else goes.
    await orgRow(page, "Docs").click()
    await page.getByTestId("org-delete").click()
    await expect(page.getByTestId("org-delete-lower")).toHaveText(
      "1 sub-organization moves up to Product.",
    )
    await expect(page.getByTestId("org-delete-confirm")).toContainText(
      "The access that this organization gives is gone.",
    )
    await shot(page, "s118-03-delete-confirm")
    await page.getByTestId("org-delete-go").click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(orgRow(page, "Docs")).toHaveCount(0)
    // "Site" is under "Product" now (it moved up), and the members are still agents.
    const productId = (await orgByName(page, "Product"))?.id
    await expect(orgRow(page, "Site")).toBeVisible()
    await expect(orgRow(page, "Site")).toHaveAttribute("data-parent", `o:${productId}`)
    expect((await orgByName(page, "Site"))?.parentId).toBe(productId ?? null)
    expect(await agentIdOf(page, "Bo")).toBeTruthy()
    expect((await orgsOf(page)).map((o) => o.name).sort()).toEqual(["Ops", "Product", "Site"])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("organizations: the profile lists the organizations of an agent and the tools from them, the part Tools and the pickers show the value, and a delete clears every list", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne()
  try {
    for (const name of ["Ada", "Bo", "Cy", "Di"]) await createAgent(page, name)
    // Product holds Docs, and Docs holds Site: "Product" is two levels above "Site".
    await makeOrg(page, "Product", ["Ada"])
    await makeOrg(page, "Docs", ["Bo"], "Product")
    await makeOrg(page, "Site", ["Cy"], "Docs")
    // A skill for the agent Di only, so that the members get it from an organization or not at all.
    const serverId = await serverIdOf(page)
    const diId = await agentIdOf(page, "Di")
    await rpc(page, "skills.create", {
      serverId,
      name: "Release notes",
      description: "Write the release notes.",
      instructions: "Write the release notes in three lines.",
      agentIds: [diId],
    })
    const cyId = await agentIdOf(page, "Cy")
    const linesOf = (name: string) =>
      page.locator(`[data-testid=org-tool-line] >> text=${name}`).count()

    // --- The part "Tools" of "Product": the skill, "Inherit" first, then "On" ---------------
    await openOrgPart(page)
    await orgRow(page, "Product").click()
    const row = page.locator("[data-testid=org-tool-row][data-name='Release notes']")
    await expect(row).toBeVisible()
    const value = (v: string) => row.locator(`[data-testid=org-tool-value] label[data-value=${v}]`)
    await expect(value("inherit").locator("input")).toBeChecked()
    await value("on").click()
    await expect(value("on").locator("input")).toBeChecked()
    await shot(page, "s118-04-tools-on")
    await closeDialog(page)
    // The member of "Site" (two levels below) has the skill from "Product" (spec 030, Acceptance).
    const forCy = await rpc<{ name: string; organizations: { name: string }[] }[]>(
      page,
      "orgTools.forAgent",
      { agentId: cyId },
    )
    expect(forCy.map((t) => [t.name, t.organizations.map((o) => o.name)])).toEqual([
      ["Release notes", ["Product"]],
    ])

    // --- The profile of the member of "Site": the row "Organizations" and "From Product" --------
    await closeSettingsIfOpen(page)
    await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Cy" }).click()
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("agent-profile")).toBeVisible()
    await expect(page.getByTestId("agent-org")).toHaveText(["Site"])
    await expect(page.getByTestId("org-tool-line")).toHaveCount(1)
    await expect(page.getByTestId("org-tool-line")).toContainText("Release notes")
    await expect(page.getByTestId("org-tool-from")).toHaveText("From Product")
    await page.getByTestId("org-tools-lines").scrollIntoViewIfNeeded()
    await shot(page, "s118-05-profile")
    await page.getByTestId("agent-orgs").screenshot({ path: `${shotsDir}/s118-05b-orgs-row.png` })
    await page
      .getByTestId("org-tools-lines")
      .screenshot({ path: `${shotsDir}/s118-05c-tool-lines.png` })
    // A click on the name opens the form. Escape closes the form and leaves the profile.
    await page.getByTestId("agent-org").click()
    await expect(dialog(page)).toBeVisible()
    await expect(orgName(page)).toHaveValue("Site")
    await closeDialog(page)
    await expect(page.getByTestId("agent-profile")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("agent-profile")).toHaveCount(0)

    // An agent in no organization shows "None" and has no line.
    await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Di" }).click()
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("agent-orgs-none")).toHaveText("None")
    expect(await linesOf("Release notes")).toBe(0)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("agent-profile")).toHaveCount(0)

    // --- The form of the skill shows the organizations with the mark and the value ---------------
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-skills").click()
    await page.getByTestId("skill-edit").click()
    await expect(page.getByTestId("skill-org")).toHaveCount(3)
    await expect(page.getByTestId("skill-org-mark")).toHaveText([
      "organization",
      "organization",
      "organization",
    ])
    const skillOrg = (name: string) => page.locator(`[data-testid=skill-org][data-org='${name}']`)
    // Each organization shows its value as one of three (spec 030, "Tools"): S120 widened the picker.
    const skillValue = (name: string, v: string) =>
      skillOrg(name).locator(`[data-testid=skill-org-value] label[data-value=${v}] input`)
    await expect(skillValue("Product", "on")).toBeChecked()
    await expect(skillValue("Docs", "inherit")).toBeChecked()
    // Save keeps the list as it is.
    await skillOrg("Docs").locator("[data-testid=skill-org-value] label[data-value=on]").click()
    await expect(skillValue("Docs", "on")).toBeChecked()
    await shot(page, "s118-06-skill-picker")
    await page.getByTestId("skill-save").click()
    await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
    await expect(page.getByTestId("skill-row-agents")).toContainText("Di")
    await expect(page.getByTestId("skill-row-agents")).toContainText("Docs")
    // The part "Tools" of "Docs" shows the value too: it is the same fact.
    const docs = (await orgByName(page, "Docs")) as OrgInfo
    const toolRows = await rpc<{ name: string; choice: string }[]>(page, "orgTools.list", {
      orgId: docs.id,
    })
    expect(toolRows.map((r) => [r.name, r.choice])).toEqual([["Release notes", "on"]])

    // --- The form of a connection shows them too -------------------------------------------------
    await page.getByTestId("settings-nav-connections").click()
    await page.getByTestId("connection-add").click()
    await page.getByTestId("connection-agents-mode").getByText("Some agents").click()
    await expect(page.getByTestId("connection-org")).toHaveCount(3)
    await expect(page.getByTestId("connection-org-mark").first()).toHaveText("organization")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("connection-form-dialog")).toHaveCount(0)

    // --- Delete "Product": it leaves the skill list, and the lines are gone -----------------------
    await openOrgPart(page)
    await orgRow(page, "Product").click()
    await page.getByTestId("org-delete").click()
    // <n> counts the sub-organizations of "Product", not the ones below them (spec 030, flow 4):
    // "Docs" only. "Product" has no parent, so "Docs" becomes a top organization.
    await expect(page.getByTestId("org-delete-lower")).toHaveText(
      "1 sub-organization becomes a top organization.",
    )
    await page.getByTestId("org-delete-go").click()
    await expect(dialog(page)).toHaveCount(0)
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-skills").click()
    await page.getByTestId("skill-edit").click()
    await expect(page.getByTestId("skill-org")).toHaveCount(2)
    await expect(skillOrg("Product")).toHaveCount(0)
    await expect(skillValue("Docs", "on")).toBeChecked()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
    // "Docs" still gives the skill to "Site" (a top organization now has its own entry "On").
    const stillForCy = await rpc<{ organizations: { name: string }[] }[]>(
      page,
      "orgTools.forAgent",
      { agentId: cyId },
    )
    expect(stillForCy.map((t) => t.organizations.map((o) => o.name))).toEqual([["Docs"]])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("organizations: the form works with the keyboard at the narrowest window and keeps the focus where it belongs", async () => {
  test.setTimeout(180_000)
  const { mock, app, page } = await startOne()
  try {
    for (const name of ["Ada", "Bo"]) await createAgent(page, name)
    await makeOrg(page, "Product", ["Ada"])
    await openOrgPart(page)
    await resizeWindow(app, 480, 600)

    // Open the form with the keyboard only.
    await page.getByTestId("org-new").focus()
    await page.keyboard.press("Enter")
    await expect(dialog(page)).toBeVisible()
    // The focus starts in the field "Name", which has its label.
    await expect(orgName(page)).toBeFocused()
    await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible()
    await expect(page.getByRole("dialog", { name: "New organization" })).toBeVisible()
    await expect(page.getByRole("checkbox", { name: /Ada/ })).toBeVisible()
    await expect(page.getByRole("combobox", { name: /Lead/ })).toBeVisible()
    await expect(page.getByRole("combobox", { name: /Parent organization/ })).toBeVisible()

    // The box fits the window: no sideways scroll in the box, and the buttons are inside the window.
    const fits = async (box: Locator) => {
      const width = await page.evaluate(() => window.innerWidth)
      const rect = (await box.boundingBox()) as { x: number; width: number }
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(width)
      // The box itself does not scroll sideways. (The page behind it is not the subject here.)
      const shell = page.locator("[role=dialog]").last()
      expect(await shell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    }
    await fits(dialog(page))
    await fits(page.getByTestId("org-submit"))
    await shot(page, "s118-07-narrow")

    // Tab goes on from the name to the search, then the members; Enter in the name saves.
    await page.keyboard.type("Keys")
    await page.keyboard.press("Tab")
    await expect(page.getByTestId("org-member-search")).toBeFocused()
    // Ada is in "Product", so the form of a new top organization shows Ada muted and not tickable
    // (spec 030, "One line"). Tab skips it and goes to Bo.
    await page.keyboard.press("Tab")
    await expect(page.getByTestId("org-member-Bo")).toBeFocused()
    await page.keyboard.press("Space")
    await expect(page.getByTestId("org-member-Bo")).toBeChecked()
    await orgName(page).focus()
    await page.keyboard.press("Enter")
    await expect(dialog(page)).toHaveCount(0)
    // The chart stays open, and the focus goes to the node of the new organization (spec 029).
    await expect(orgRow(page, "Keys")).toBeFocused()
    expect((await orgByName(page, "Keys"))?.memberIds).toEqual([await agentIdOf(page, "Bo")])

    // Escape closes the form without saving.
    await page.getByTestId("org-new").focus()
    await page.keyboard.press("Enter")
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.type("Never saved")
    await page.keyboard.press("Escape")
    await expect(dialog(page)).toHaveCount(0)
    expect(await orgByName(page, "Never saved")).toBeUndefined()

    // The confirm of a delete fits too, and the focus is on "Back".
    await orgRow(page, "Product").focus()
    await page.keyboard.press("Enter")
    await page.getByTestId("org-delete").focus()
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("org-delete-back")).toBeFocused()
    await fits(page.getByTestId("org-delete-go"))
    await shot(page, "s118-08-narrow-confirm")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("org-delete-confirm")).toHaveCount(0)
    await closeDialog(page)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

/** Latin words in a part of the screen. Names of agents and organizations are cut out first. */
const latinWords = async (page: Page, selector: string) => {
  const text = await page.locator(selector).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    for (const skip of clone.querySelectorAll("[data-user-data], pre, textarea, input, select"))
      skip.remove()
    return clone.textContent ?? ""
  })
  return text.replace(/Ada|Bo|Product|Docs|Release notes/g, "").match(/[A-Za-z]{2,}/g) ?? []
}

test("organizations: in Korean the form, the list, the profile row and the confirm have no English left", async () => {
  test.setTimeout(180_000)
  const { mock, app, page } = await startOne("ko-KR")
  try {
    for (const name of ["Ada", "Bo"]) await createAgent(page, name)
    await makeOrg(page, "Product", ["Ada"])
    await makeOrg(page, "Docs", ["Bo"], "Product")
    const serverId = await serverIdOf(page)
    await rpc(page, "skills.create", {
      serverId,
      name: "Release notes",
      description: "Write.",
      instructions: "Write.",
      agentIds: [await agentIdOf(page, "Bo")],
    })
    await openOrgPart(page)
    expect(await latinWords(page, "[data-testid=org-head]")).toEqual([])
    await page.getByTestId("org-new").click()
    expect(await latinWords(page, "[data-testid=org-dialog]")).toEqual([])
    await closeDialog(page)
    await orgRow(page, "Product").click()
    // The reason of a muted parent is Korean, too.
    await expect(parentOption(page, "Docs")).toContainText("이 조직의 하위 조직이에요.")
    expect(await latinWords(page, "[data-testid=org-dialog]")).toEqual([])
    await page.getByTestId("org-delete").click()
    await expect(page.getByTestId("org-delete-lower")).toHaveText(
      "하위 조직 1개가 최상위 조직이 돼요.",
    )
    expect(await latinWords(page, "[data-testid=org-dialog]")).toEqual([])
    await shot(page, "s118-09-korean-confirm")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("org-delete-confirm")).toHaveCount(0)
    await closeDialog(page)
    await closeSettingsIfOpen(page)
    await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("agent-org")).toHaveText(["Product"])
    expect(await latinWords(page, "[data-testid=agent-orgs]")).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// --- A linked computer (spec 012) --------------------------------------------------------------

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const linkedServerId = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const result = await (window as any).robot.invoke("servers.list")
    return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
  }) as Promise<string>
const ask = (page: Page, serverId: string, method: string, input?: unknown) =>
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
  await one.page.getByTestId("connect-two-way").click() // one way is enough here
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

test("organizations on a linked computer: with the switch it makes and edits them and reads the tools; without it the form is read only", async () => {
  test.setTimeout(300_000)
  const { mock, one, two } = await startPair()
  try {
    await createAgent(two.page, "Ada")
    await createAgent(two.page, "Bo")
    await makeOrg(two.page, "Product", ["Ada"])
    await rpc(two.page, "skills.create", {
      serverId: await serverIdOf(two.page),
      name: "Release notes",
      description: "Write.",
      instructions: "Write.",
      agentIds: [await agentIdOf(two.page, "Bo")],
    })
    // --- With the switch -----------------------------------------------------------------------
    await pairOneWay(one, two, true)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()
    await openOrgPart(one.page)
    // The list is the list of the server.
    await expect(orgRow(one.page, "Product")).toBeVisible()
    await expect(one.page.getByTestId("org-new")).toBeVisible()
    await create(one.page, "Docs", { members: ["Bo"], parent: "Product" })
    // It is on the server, with the parent and the member.
    const docs = (await orgByName(two.page, "Docs")) as OrgInfo
    expect(docs.parentId).toBe((await orgByName(two.page, "Product"))?.id)
    expect(docs.memberIds).toEqual([await agentIdOf(two.page, "Bo")])
    // An edit goes to the server, and the delete too. The form is not read only.
    await orgRow(one.page, "Docs").click()
    await expect(one.page.getByTestId("org-readonly")).toHaveCount(0)
    await orgName(one.page).fill("Docs 2")
    await one.page.getByTestId("org-submit").click()
    await expect(dialog(one.page)).toHaveCount(0)
    await expect
      .poll(async () => (await orgsOf(two.page)).map((o) => o.name).sort())
      .toEqual(["Docs 2", "Product"])
    // The tools are kept on the server: the client reads them and has no control.
    await orgRow(one.page, "Product").click()
    await expect(one.page.getByTestId("org-tools-linked")).toContainText("MacBook 2")
    const toolRow = one.page.locator("[data-testid=org-tool-row][data-name='Release notes']")
    await expect(toolRow).toBeVisible()
    await expect(toolRow.locator("input").first()).toBeDisabled()
    await expect(toolRow.locator("input").nth(1)).toBeDisabled()
    // The server refuses the change too, for a caller that skips the form.
    const serverId = await linkedServerId(one.page)
    expect(
      await ask(one.page, serverId, "orgTools.set", {
        orgId: (await orgByName(two.page, "Product"))?.id,
        kind: "skill",
        id: "x",
        choice: "on",
      }),
    ).toBe("not_allowed")
    await shot(one.page, "s118-10-linked-with-switch")
    await closeDialog(one.page)
    // The delete goes to the server.
    await orgRow(one.page, "Docs 2").click()
    await one.page.getByTestId("org-delete").click()
    await one.page.getByTestId("org-delete-go").click()
    await expect(dialog(one.page)).toHaveCount(0)
    await expect.poll(async () => (await orgsOf(two.page)).map((o) => o.name)).toEqual(["Product"])
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

test("organizations on a linked computer without the switch: the list and the form are read only and the server refuses a change", async () => {
  test.setTimeout(300_000)
  const { mock, one, two } = await startPair()
  try {
    await createAgent(two.page, "Ada")
    await makeOrg(two.page, "Product", ["Ada"])
    await pairOneWay(one, two, false)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()
    await openOrgPart(one.page)
    await expect(orgRow(one.page, "Product")).toBeVisible()
    // No button "New organization".
    await expect(one.page.getByTestId("org-new")).toHaveCount(0)
    await orgRow(one.page, "Product").click()
    await expect(one.page.getByTestId("org-readonly")).toContainText("MacBook 2")
    await expect(orgName(one.page)).toHaveValue("Product")
    await expect(orgName(one.page)).toHaveAttribute("readonly", "")
    await expect(one.page.getByTestId("org-lead")).toBeDisabled()
    await expect(one.page.getByTestId("org-parent")).toBeDisabled()
    await expect(one.page.getByTestId("org-member-Ada")).toBeDisabled()
    await expect(one.page.getByTestId("org-submit")).toHaveCount(0)
    await expect(one.page.getByTestId("org-delete")).toHaveCount(0)
    await shot(one.page, "s118-11-linked-read-only")
    await closeDialog(one.page)
    // A caller that skips the form gets "not allowed" with the name of the server.
    const serverId = await linkedServerId(one.page)
    const id = (await orgByName(two.page, "Product"))?.id
    expect(
      await ask(one.page, serverId, "organizations.update", { id, patch: { name: "X" } }),
    ).toBe("change_off")
    expect(await ask(one.page, serverId, "organizations.delete", { id })).toBe("change_off")
    expect((await orgsOf(two.page)).map((o) => o.name)).toEqual(["Product"])
    // A read still works: the row "Organizations" of the profile of an agent opens the form.
    await closeSettingsIfOpen(one.page)
    await one.page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-org")).toHaveText(["Product"])
    await one.page.getByTestId("agent-org").click()
    await expect(one.page.getByTestId("org-readonly")).toBeVisible()
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
