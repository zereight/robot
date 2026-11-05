import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, type RecordedRequest, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Spec 030, "Goal", and spec 029, "Organization node": the goal of an organization in the form, on
// its node and in the turn of its members, and the outcome line of the work of its members.

interface OrgInfo {
  id: string
  name: string
  goal: string
  memberIds: string[]
  leadId: string | null
}

const CHAT = "/v1/chat/completions"

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
const orgRow = (page: Page, name: string) =>
  page
    .getByTestId("org-unit")
    .filter({ has: page.getByTestId("org-unit-name").getByText(name, { exact: true }) })
const dialog = (page: Page) => page.getByTestId("org-dialog")
const orgGoal = (page: Page) => page.getByTestId("org-form").getByTestId("org-goal")

const openOrgChart = async (page: Page) => {
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
}

/** Sends a message in the direct chat of an agent and waits for the end of the turn. */
const ask = async (page: Page, agent: string, text: string) => {
  await page.getByTestId("page-chats").click()
  await page.locator(`[data-place-row][data-place-name="${agent}"]`).click()
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
  // The turn is over when no message streams any more (spec 003).
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
}

/** The system text of the last request to the model, as one string. */
const lastSystem = (requests: readonly RecordedRequest[]) =>
  JSON.stringify(requests.filter((r) => r.path === CHAT).at(-1)?.body)

test("the goal of an organization: the form, the node, the length limit and the turn", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await openOrgChart(page)

    // --- Make an organization with a goal, through the form --------------------------------
    await page.getByTestId("org-new").click()
    await expect(dialog(page)).toBeVisible()
    await page.getByTestId("org-form").getByTestId("org-name").fill("Docs")
    await page.getByTestId("org-member-Ada").check()
    await orgGoal(page).fill("Ship the Docs site.")
    await shot(page, "s139-01-goal-form")
    await page.getByTestId("org-submit").click()
    await expect(dialog(page)).toHaveCount(0)

    // The goal is stored, and the organization shows it on its node (spec 029).
    expect((await orgByName(page, "Docs"))?.goal).toBe("Ship the Docs site.")
    await expect(orgRow(page, "Docs").getByTestId("org-unit-goal")).toHaveText(
      "Ship the Docs site.",
    )
    // The whole goal is in the accessible name of the node.
    await expect(orgRow(page, "Docs")).toHaveAttribute("aria-label", /Ship the Docs site\./)
    await shot(page, "s139-02-goal-node")

    // --- An organization with no goal shows no line ----------------------------------------
    await page.getByTestId("org-new").click()
    await expect(dialog(page)).toBeVisible()
    await page.getByTestId("org-form").getByTestId("org-name").fill("Ops")
    await page.getByTestId("org-submit").click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(orgRow(page, "Ops")).toBeVisible()
    await expect(orgRow(page, "Ops").getByTestId("org-unit-goal")).toHaveCount(0)

    // --- A goal of 401 characters is refused -----------------------------------------------
    await orgRow(page, "Ops").click()
    await expect(dialog(page)).toBeVisible()
    await orgGoal(page).fill("x".repeat(401))
    // The form does not send a goal that is too long.
    await expect(page.getByTestId("org-submit")).toBeDisabled()
    await expect(page.getByTestId("org-goal-hint")).toContainText("-1")
    await shot(page, "s139-03-goal-too-long")
    await orgGoal(page).fill("Keep the site up.")
    await expect(page.getByTestId("org-submit")).toBeEnabled()
    await page.getByTestId("org-submit").click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(orgRow(page, "Ops").getByTestId("org-unit-goal")).toHaveText("Keep the site up.")

    // --- The goal reaches the turn of the member --------------------------------------------
    await ask(page, "Ada", "hello")
    const system = lastSystem(mock.requests)
    expect(system).toContain("Ship the Docs site.")
    // Ada is a member of "Docs" only, so the goal of "Ops" is not in her turn.
    expect(system).not.toContain("Keep the site up.")

    // --- A turn that ended as done shows in the outcome line of the node ---------------------
    // The turn above made a task in the state done (spec 005), so the node counts it.
    await openOrgChart(page)
    await expect(orgRow(page, "Docs").getByTestId("org-unit-outcome")).toContainText("1 done")
    // "Ops" has no member, so it has no outcome line.
    await expect(orgRow(page, "Ops").getByTestId("org-unit-outcome")).toHaveCount(0)
    await shot(page, "s139-04-outcome")
  } finally {
    await mock.close()
    await app.close()
  }
})

test("search and the list view: a search dims and never moves a node, the list is the phone list, and a hit in the place list opens it", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await createAgent(page, "Bo")
    await openOrgChart(page)
    // Two organizations with a goal, made through the link: the form is covered by the first test.
    const serverId = await serverIdOf(page)
    const adaId = await agentIdOf(page, "Ada")
    const boId = await agentIdOf(page, "Bo")
    const docs = await rpc<OrgInfo>(page, "organizations.create", {
      serverId,
      name: "Docs",
      goal: "Ship the Docs site.",
      memberIds: [adaId],
      leadId: null,
    })
    await rpc(page, "organizations.create", {
      serverId,
      name: "Ops",
      goal: "Keep the site up.",
      memberIds: [boId],
      leadId: null,
    })
    await expect(orgRow(page, "Docs")).toBeVisible()
    await expect(orgRow(page, "Ops")).toBeVisible()

    // --- The positions before the search ---------------------------------------------------
    const before = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-node]")].map((el) => [
        el.dataset.key ?? "",
        el.style.left,
        el.style.top,
      ]),
    )
    const zoom = () => page.getByTestId("org-surface").getAttribute("data-zoom")
    const zoomBefore = await zoom()

    // --- A search dims, and never moves a node ---------------------------------------------
    await page.getByTestId("org-search").fill("doc")
    await expect(orgRow(page, "Docs")).toHaveAttribute("data-dim", "false")
    await expect(orgRow(page, "Ops")).toHaveAttribute("data-dim", "true")
    // No node moved, and the zoom is the one before the search.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("[data-node]")].map((el) => [
          el.dataset.key ?? "",
          el.style.left,
          el.style.top,
        ]),
      ),
    ).toEqual(before)
    expect(await zoom()).toBe(zoomBefore)
    await shot(page, "s139-05-search")

    // --- A text that matches nothing shows the muted line -----------------------------------
    await page.getByTestId("org-search").fill("zzz")
    await expect(page.getByTestId("org-search-empty")).toBeVisible()
    await expect(orgRow(page, "Docs")).toHaveAttribute("data-dim", "true")
    // Escape clears the search, as it does in the place list.
    await page.getByTestId("org-search").press("Escape")
    await expect(page.getByTestId("org-search")).toHaveValue("")
    await expect(page.getByTestId("org-search-empty")).toHaveCount(0)
    await expect(orgRow(page, "Ops")).toHaveAttribute("data-dim", "false")

    // --- The list view is the list of the phone, with the goal and the outcome --------------
    await page.getByTestId("org-view-list").click()
    await expect(page.getByTestId("org-list")).toBeVisible()
    await expect(page.getByTestId("org-canvas")).toHaveCount(0)
    const docsBlock = page
      .getByTestId("org-list-block")
      .filter({ has: page.getByTestId("org-list-block-head").getByText("Docs", { exact: true }) })
    await expect(docsBlock.getByTestId("org-list-goal")).toHaveText("Ship the Docs site.")
    await shot(page, "s139-06-list")
    // A row of an organization opens its form, and the list stays behind it.
    await docsBlock.getByTestId("org-list-block-head").click()
    await expect(page.getByTestId("org-dialog")).toBeVisible()
    await expect(page.getByTestId("org-form").getByTestId("org-goal")).toHaveValue(
      "Ship the Docs site.",
    )
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("org-dialog")).toHaveCount(0)
    // A row of an agent opens its profile, as a click on its node of the canvas does.
    await docsBlock.getByTestId("org-list-agent").filter({ hasText: "Ada" }).click()
    await expect(page.getByTestId("agent-profile")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("agent-profile")).toHaveCount(0)

    // --- A hit in the place list opens the page with the organization in the search ---------
    await page.getByTestId("page-chats").click()
    await page.getByTestId("place-search").fill("Ops")
    const hit = page.getByTestId("search-org-hit").filter({ hasText: "Ops" })
    await expect(hit).toBeVisible()
    await hit.click()
    await expect(page.getByTestId("org-page")).toBeVisible()
    await expect(page.getByTestId("org-search")).toHaveValue("Ops")
    // The page opens in the view that the user left it in, and the search dims in both views.
    await expect(page.getByTestId("org-list")).toBeVisible()
    await expect(docsBlock).toHaveAttribute("data-dim", "true")
    await shot(page, "s139-07-hit")
    // The same hit in the canvas view dims the other organization and keeps the one that matched.
    await page.getByTestId("org-view-chart").click()
    await expect(page.getByTestId("org-canvas")).toBeVisible()
    await expect(orgRow(page, "Ops")).toHaveAttribute("data-dim", "false")
    await expect(orgRow(page, "Docs")).toHaveAttribute("data-dim", "true")
    // The hit is one organization of this computer, and the form opens on it.
    await orgRow(page, "Ops").click()
    await expect(page.getByTestId("org-dialog")).toBeVisible()
    await expect(page.getByTestId("org-form").getByTestId("org-goal")).toHaveValue(
      "Keep the site up.",
    )
    expect(docs.goal).toBe("Ship the Docs site.")
  } finally {
    await mock.close()
    await app.close()
  }
})

test("the retrospective of an organization asks the model and saves nothing by itself", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await openOrgChart(page)
    const serverId = await serverIdOf(page)
    await rpc(page, "organizations.create", {
      serverId,
      name: "Docs",
      memberIds: [await agentIdOf(page, "Ada")],
      leadId: null,
    })
    await expect(orgRow(page, "Docs")).toBeVisible()

    // The menu of an organization node holds "Look back…" (spec 030, "Retrospective").
    await orgRow(page, "Docs").click({ button: "right" })
    const menu = page.getByTestId("org-menu")
    await expect(menu.getByTestId("org-menu-retro")).toBeVisible()
    await shot(page, "s139-08-retro-menu")
    const before = mock.requests.length
    await menu.getByTestId("org-menu-retro").click()
    await expect(page.getByTestId("retro-dialog")).toBeVisible()
    // The look back is one request to the model, and it makes no task.
    await expect.poll(() => mock.requests.length, { timeout: 20_000 }).toBeGreaterThan(before)
    // The stand-in answers no proposal for a request that it does not know, so the form says so and
    // nothing is saved.
    await expect(page.getByTestId("retro-empty").or(page.getByTestId("retro-failed"))).toBeVisible({
      timeout: 30_000,
    })
    const tasks = await rpc<unknown[]>(page, "tasks.list", { serverId })
    expect(tasks).toHaveLength(0)
    await expect(page.getByTestId("retro-close")).toBeVisible()
    await page.getByTestId("retro-close").click()
    await expect(page.getByTestId("retro-dialog")).toHaveCount(0)
    // The instructions of Ada did not change.
    const agents = await rpc<{ id: string; name: string; instructions: string }[]>(
      page,
      "agents.list",
      { serverId, archived: false },
    )
    expect(agents.find((a) => a.name === "Ada")?.instructions).not.toContain("Check every link")
  } finally {
    await mock.close()
    await app.close()
  }
})

test("a routine can belong to an organization, and the field refuses an agent that is not a member", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await createAgent(page, "Bo")
    await openOrgChart(page)
    // "Docs" holds Ada only, so Bo is not a member.
    const serverId = await serverIdOf(page)
    const docs = await rpc<OrgInfo>(page, "organizations.create", {
      serverId,
      name: "Docs",
      memberIds: [await agentIdOf(page, "Ada")],
      leadId: null,
    })

    // --- The routine form names the organization, and keeps the rule -------------------------
    await page.getByTestId("page-routines").click()
    await page.getByTestId("routine-new").click()
    const dialog = page.getByTestId("routine-dialog")
    await expect(dialog).toBeVisible()
    await page.getByTestId("routine-name").fill("Check the links")
    await page.getByTestId("routine-prompt").fill("Check every link.")
    await page.getByTestId("routine-org").selectOption({ label: "Docs" })
    await shot(page, "s139-09-routine-org")
    await page.getByTestId("routine-save").click()
    await expect(dialog).toHaveCount(0)
    // The card shows the organization as a chip.
    const card = page.getByTestId("routine-card").filter({ hasText: "Check the links" })
    await expect(card.getByTestId("routine-org-chip")).toHaveText("Docs")
    await shot(page, "s139-10-routine-card")

    // --- The same form with an agent that is not a member: the form does not save ------------
    await page.getByTestId("routine-new").click()
    await expect(dialog).toBeVisible()
    await page.getByTestId("routine-name").fill("Check the facts")
    await page.getByTestId("routine-prompt").fill("Check a fact.")
    // The agent list shows the organization prefix, so the option reads "[Docs] Bo" (spec 036).
    // Bo is the second agent by name, and the list is in the order of the agents.
    await page.getByTestId("routine-agent").selectOption({ index: 1 })
    await page.getByTestId("routine-org").selectOption({ label: "Docs" })
    await expect(page.getByTestId("routine-org-rule")).toBeVisible()
    await expect(page.getByTestId("routine-save")).toBeDisabled()
    await shot(page, "s139-11-routine-rule")
    await page.getByTestId("routine-agent").selectOption({ index: 0 })
    await expect(page.getByTestId("routine-org-rule")).toHaveCount(0)
    await expect(page.getByTestId("routine-save")).toBeEnabled()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    // The routine holds the organization over a restart of the list.
    const listed = await rpc<{ name: string; orgId: string | null }[]>(page, "routines.list", {
      serverId,
    })
    expect(listed.find((r) => r.name === "Check the links")?.orgId).toBe(docs.id)
    expect(listed.some((r) => r.name === "Check the facts")).toBe(false)
  } finally {
    await mock.close()
    await app.close()
  }
})

test("the Today page can be filtered by organization, and the choice survives a restart", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const first = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  const { app, page } = first
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await createAgent(page, "Bo")
    const serverId = await serverIdOf(page)
    const docs = await rpc<OrgInfo>(page, "organizations.create", {
      serverId,
      name: "Docs",
      memberIds: [await agentIdOf(page, "Ada")],
      leadId: null,
    })
    // One routine per agent, due in the next 24 hours: "Next 24 hours" gets one row for each.
    const routine = (agent: string, name: string) =>
      rpc(page, "routines.create", {
        serverId,
        agentId: agent,
        name,
        prompt: "Check.",
        schedule: { kind: "once", at: Date.now() + 3 * 60 * 60 * 1000 },
        place: { kind: "agent" },
      })
    await routine(await agentIdOf(page, "Ada"), "Ada check")
    await routine(await agentIdOf(page, "Bo"), "Bo check")

    await page.getByTestId("page-today").click()
    await expect(page.getByTestId("today-page")).toBeVisible()
    const nextRows = page.getByTestId("today-group-next").getByTestId("today-row")
    await expect(nextRows).toHaveCount(2)

    // --- A filter keeps the rows of the members of the organization -------------------------
    await page.getByTestId("today-org").selectOption({ label: "Docs" })
    await expect(nextRows).toHaveCount(1)
    await expect(nextRows.first()).toContainText("Ada check")
    // The badge of the page button does not change with the filter (spec 021, "Rules").
    await shot(page, "s139-12-today-filter")

    // --- An organization with no member says so in one line ---------------------------------
    await rpc<OrgInfo>(page, "organizations.create", {
      serverId,
      name: "Ops",
      memberIds: [],
      leadId: null,
    })
    await page.getByTestId("today-org").selectOption({ label: "Ops" })
    await expect(page.getByTestId("today-filter-empty")).toBeVisible()
    await expect(page.getByTestId("today-filter-empty")).toContainText("Nothing in Ops.")

    // --- The choice belongs to the device and survives a restart -----------------------------
    await page.getByTestId("today-org").selectOption({ label: "Docs" })
    await expect(nextRows).toHaveCount(1)
    // The choice is written to the store of this device; wait for the write before the restart.
    await expect
      .poll(async () => (await rpc<{ todayOrg: string | null }>(page, "ui.get")).todayOrg)
      .toBe(docs.id)
    await app.close()
    const again = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
    try {
      await again.page.getByTestId("page-today").click()
      await expect(again.page.getByTestId("today-page")).toBeVisible()
      await expect(again.page.getByTestId("today-org")).toHaveValue(docs.id)
      await expect(again.page.getByTestId("today-group-next").getByTestId("today-row")).toHaveCount(
        1,
      )
    } finally {
      await again.app.close()
    }
  } finally {
    await mock.close()
    await app.close()
  }
})
