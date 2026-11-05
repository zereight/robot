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
