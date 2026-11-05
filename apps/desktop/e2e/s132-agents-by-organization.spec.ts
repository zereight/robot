import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Spec 001, "Agents by organization": the choice "My sections" and "By organization" in the menu of
// the Agents header. The view makes one read-only section for each deepest organization, in the
// order of the names, and "No organization" last. It follows the organizations at once, the
// device keeps the choice and the open state of each section, and the user sections stay as they
// were.

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
  memberIds: string[]
}
interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}

const localServerId = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await localServerId(page), archived: false })
const agentId = async (page: Page, name: string) =>
  (await agentsOf(page)).find((a) => a.name === name)?.id as string
const orgByName = async (page: Page, name: string) =>
  (await rpc<OrgInfo[]>(page, "organizations.list", { serverId: await localServerId(page) })).find(
    (o) => o.name === name,
  ) as OrgInfo
const makeOrg = async (page: Page, name: string, members: string[], parent?: string) =>
  rpc<OrgInfo>(page, "organizations.create", {
    serverId: await localServerId(page),
    name,
    memberIds: await Promise.all(members.map((m) => agentId(page, m))),
    leadId: null,
    ...(parent ? { parentId: (await orgByName(page, parent)).id } : {}),
  })
const updateOrg = async (page: Page, org: string, patch: Record<string, unknown>) =>
  rpc(page, "organizations.update", { id: (await orgByName(page, org)).id, patch })
const makeAgent = async (page: Page, name: string) => {
  const template = (await agentsOf(page))[0] as AgentInfo
  return rpc<AgentInfo>(page, "agents.create", {
    serverId: await localServerId(page),
    name,
    role: "",
    instructions: "",
    model: template.model,
  })
}

const agents = (page: Page) => page.getByTestId("section-agents")
const row = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`)
/** The organization sections, in the order shown, and what each one holds. */
const orgBlocks = (page: Page) =>
  agents(page)
    .getByTestId("org-section")
    .evaluateAll((all) =>
      all.map((el) => [
        el.querySelector("[data-testid=org-toggle]")?.textContent?.trim() ?? "",
        [...el.querySelectorAll<HTMLElement>("[data-place-row]")].map(
          (r) => r.dataset.placeName ?? "",
        ),
      ]),
    )
const noOrgNames = (page: Page) =>
  agents(page)
    .getByTestId("no-org-section")
    .locator("[data-place-row]")
    .evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.placeName ?? ""))
/** The blocks of Agents, in the order shown. */
const blocks = (page: Page) =>
  agents(page).evaluate((el) =>
    [
      ...el.querySelectorAll<HTMLElement>(
        "[data-testid=user-section], [data-testid=unassigned-section], [data-testid=org-section], [data-testid=no-org-section]",
      ),
    ].map((node) => node.dataset.testid ?? ""),
  )

/** The prefixes in the place list. The header of a chat can show one too. */
const prefixes = (page: Page) => page.getByTestId("place-list").getByTestId("org-prefix")

const pickView = async (page: Page, view: "sections" | "organization") => {
  await page.getByTestId("agents-menu").click()
  await page.getByTestId(`agents-menu-view-${view}`).click()
}

test("agents by organization: the view, the order, no prefix, read only, rename, search, restart and back", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await makeAgent(page, "Bo")
  await makeAgent(page, "Cy")

  // A user section that holds Cy, to prove that the view leaves the user sections as they are.
  const serverId = await localServerId(page)
  const mine = await rpc<{ id: string }>(page, "sections.create", {
    serverId,
    kind: "agent",
    name: "Research",
  })
  await rpc(page, "places.move", {
    kind: "agent",
    id: await agentId(page, "Cy"),
    sectionId: mine.id,
  })

  // Ada is in Docs. Bo is in Docs and in API, which is under Docs, so the deepest is API.
  await makeOrg(page, "Docs", ["Ada", "Bo"])
  await makeOrg(page, "API", ["Bo"], "Docs")
  await expect(prefixes(page)).toHaveCount(2)
  await expect(page.getByTestId("org-section")).toHaveCount(0)
  expect(await blocks(page)).toEqual(["user-section", "unassigned-section"])

  // The choice that is on has a mark, and "My sections" is on at first.
  await page.getByTestId("agents-menu").click()
  await expect(page.getByTestId("agents-menu-view-sections")).toHaveAttribute(
    "aria-checked",
    "true",
  )
  await expect(page.getByTestId("agents-menu-view-organization")).toHaveAttribute(
    "aria-checked",
    "false",
  )
  await page.keyboard.press("Escape")

  // "By organization": "API" with Bo, "Docs" with Ada, then "No organization" with Cy. The sections
  // are flat, and no row shows a prefix.
  await pickView(page, "organization")
  await expect
    .poll(() => orgBlocks(page))
    .toEqual([
      ["API", ["Bo"]],
      ["Docs", ["Ada"]],
    ])
  expect(await noOrgNames(page)).toEqual(["Cy"])
  expect(await blocks(page)).toEqual(["org-section", "org-section", "no-org-section"])
  await expect(prefixes(page)).toHaveCount(0)
  await expect(row(page, "Ada")).toHaveAttribute("draggable", "false")
  await shot(page, "s132-01-by-organization")

  // Read only: "New section" is off with its reason, and so is "Move to section" of an agent.
  await page.getByTestId("agents-menu").click()
  await expect(page.getByTestId("agents-menu-new-section")).toBeDisabled()
  await expect(page.getByTestId("agents-menu-new-section-reason")).toContainText(
    "Switch to My sections",
  )
  await page.keyboard.press("Escape")
  await row(page, "Ada").click({ button: "right" })
  await expect(page.getByTestId("move-to-section")).toBeDisabled()
  await expect(page.getByTestId("move-to-section-reason")).toContainText("Switch to My sections")
  await page.keyboard.press("Escape")

  // A section opens and closes, and the device keeps the state.
  await page.getByTestId("org-toggle").filter({ hasText: "Docs" }).click()
  await expect(row(page, "Ada")).toHaveCount(0)
  await expect(row(page, "Bo")).toBeVisible()

  // A restart keeps the view and the closed section.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 900)
  await expect
    .poll(() => orgBlocks(page))
    .toEqual([
      ["API", ["Bo"]],
      ["Docs", []],
    ])
  await page.getByTestId("org-toggle").filter({ hasText: "Docs" }).click()
  await expect(row(page, "Ada")).toBeVisible()

  // A rename shows at once, in its new place in the order. A member that leaves moves to "No
  // organization". An organization with no agent has no section.
  await updateOrg(page, "Docs", { name: "Manuals" })
  await expect
    .poll(() => orgBlocks(page))
    .toEqual([
      ["API", ["Bo"]],
      ["Manuals", ["Ada"]],
    ])
  await updateOrg(page, "Manuals", { memberIds: [await agentId(page, "Bo")] })
  await expect.poll(() => orgBlocks(page)).toEqual([["API", ["Bo"]]])
  // Cy sits in the user section "Research", so it comes before Ada, as in "My sections".
  await expect.poll(() => noOrgNames(page)).toEqual(["Cy", "Ada"])

  // The filter matches the organization name: only "API" shows, with Bo.
  await updateOrg(page, "Manuals", {
    memberIds: [await agentId(page, "Ada"), await agentId(page, "Bo")],
  })
  await expect
    .poll(() => orgBlocks(page))
    .toEqual([
      ["API", ["Bo"]],
      ["Manuals", ["Ada"]],
    ])
  await page.getByTestId("place-search").fill("api")
  await expect.poll(() => orgBlocks(page)).toEqual([["API", ["Bo"]]])
  await expect(page.getByTestId("no-org-section")).toHaveCount(0)
  await page.getByTestId("place-search").press("Escape")

  // "My sections" shows the user sections as before, and no organization section.
  await pickView(page, "sections")
  await expect(page.getByTestId("org-section")).toHaveCount(0)
  await expect(page.getByTestId("no-org-section")).toHaveCount(0)
  expect(await blocks(page)).toEqual(["user-section", "unassigned-section"])
  await expect(
    page.getByTestId("user-section").locator('[data-place-row][data-place-name="Cy"]'),
  ).toBeVisible()
  await expect(prefixes(page)).toHaveCount(2)
  await shot(page, "s132-02-my-sections")

  await app.close()
  await mock.close()
})
