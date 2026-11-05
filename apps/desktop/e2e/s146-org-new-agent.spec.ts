import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The form of an organization makes an agent on the spot (spec 030, flow 6), and the form and the
// profile list the workflows that they own (spec 010, "Owner and participants"). A delete of an
// organization or of an agent says how many workflows then have no owner.

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}
interface OrgInfo {
  id: string
  name: string
  leadId: string | null
  memberIds: string[]
}
interface WorkflowInfo {
  id: string
  name: string
  owner: { kind: string; id: string } | null
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await serverOf(page), archived: false })
const orgsOf = async (page: Page) =>
  rpc<OrgInfo[]>(page, "organizations.list", { serverId: await serverOf(page) })
const workflowsOf = async (page: Page) =>
  rpc<WorkflowInfo[]>(page, "workflows.list", { serverId: await serverOf(page) })

const start = async (locale: string) => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: locale })
  await resizeWindow(app, 1300, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await page.getByTestId("page-chats").click()
  await createAgent(page, "Ada")
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
  return { app, page }
}

/** Makes an agent in the open form of an organization, with the button next to the members. */
const makeAgent = async (page: Page, name: string) => {
  await page.getByTestId("org-member-new-agent").click()
  await expect(page.getByTestId("new-agent-dialog")).toBeVisible()
  await page.getByTestId("agent-name").fill(name)
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
}

test("organization form: an agent is made on the spot, joins the members, and stays when the form is cancelled", async () => {
  test.setTimeout(180_000)
  const { app, page } = await start("en-US")

  await page.getByTestId("org-new").click()
  await page.getByTestId("org-form").getByTestId("org-name").fill("Docs")
  await makeAgent(page, "Bo")
  // The form is still open, the new agent is a member, and no chat or profile opened.
  await expect(page.getByTestId("org-form")).toBeVisible()
  await expect(page.getByTestId("org-member-Bo")).toBeChecked()
  await expect(page.getByTestId("org-page")).toBeVisible()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await page.getByTestId("org-lead").selectOption({ label: "Bo" })
  await shot(page, "s146-01-new-agent-in-form")
  await page.getByTestId("org-submit").click()
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
  const docs = (await orgsOf(page)).find((o) => o.name === "Docs")
  const bo = (await agentsOf(page)).find((a) => a.name === "Bo")
  expect(docs).toMatchObject({ leadId: bo?.id, memberIds: [bo?.id] })

  // A form that is cancelled leaves the agent, and the organization is not made.
  await page.getByTestId("org-new").click()
  await page.getByTestId("org-form").getByTestId("org-name").fill("Ops")
  await makeAgent(page, "Cy")
  await expect(page.getByTestId("org-member-Cy")).toBeChecked()
  await page.getByTestId("org-cancel").click()
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
  expect((await orgsOf(page)).map((o) => o.name)).toEqual(["Docs"])
  const cy = (await agentsOf(page)).find((a) => a.name === "Cy")
  expect(cy).toBeDefined()
  expect((await orgsOf(page)).some((o) => o.memberIds.includes(cy?.id ?? ""))).toBe(false)
  await app.close()
})

test("organization form and agent profile: the row Workflows, and the delete says how many lose their owner", async () => {
  test.setTimeout(180_000)
  const { app, page } = await start("en-US")
  const server = await serverOf(page)
  const ada = (await agentsOf(page))[0] as AgentInfo
  const docs = await rpc<OrgInfo>(page, "organizations.create", {
    serverId: server,
    name: "Docs",
    memberIds: [ada.id],
    leadId: ada.id,
  })
  const flow = (name: string, owner: { kind: string; id: string } | null) =>
    rpc<WorkflowInfo>(page, "workflows.create", {
      serverId: server,
      name,
      trigger: { kind: "manual" },
      steps: [{ id: "n", kind: "notify", name: "Tell", x: 40, y: 60, title: "Hi" }],
      edges: [],
      owner,
    })
  await flow("Weekly", { kind: "organization", id: docs.id })
  await flow("Digest", { kind: "organization", id: docs.id })
  await flow("Shared", null)

  // The row lists the two workflows of "Docs". A click shows the workflow on its page.
  await page.getByTestId("org-unit").filter({ hasText: "Docs" }).click()
  await expect(page.getByTestId("org-workflow")).toHaveText(["Digest", "Weekly"])
  await shot(page, "s146-02-org-workflows-row")
  await page.getByTestId("org-workflow").filter({ hasText: "Weekly" }).click()
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
  await expect(page.getByTestId("workflows-page")).toBeVisible()
  await expect(page.getByTestId("wf-card").filter({ hasText: "Weekly" })).toBeVisible()

  // The confirm of the delete counts the workflows that lose their owner.
  await page.getByTestId("page-orgchart").click()
  await page.getByTestId("org-unit").filter({ hasText: "Docs" }).click()
  await page.getByTestId("org-delete").click()
  await expect(page.getByTestId("org-delete-workflows")).toHaveText(
    "2 workflows have no owner then. Any agent can work in them.",
  )
  await shot(page, "s146-03-org-delete-workflows")
  await page.getByTestId("org-delete-go").click()
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
  expect((await workflowsOf(page)).map((w) => [w.name, w.owner])).toEqual([
    ["Weekly", null],
    ["Digest", null],
    ["Shared", null],
  ])

  // A form of an organization with no workflow has no row and no line.
  const ops = await rpc<OrgInfo>(page, "organizations.create", {
    serverId: server,
    name: "Ops",
    memberIds: [],
    leadId: null,
  })
  await page.getByTestId("org-unit").filter({ hasText: "Ops" }).click()
  await expect(page.getByTestId("org-workflows")).toHaveCount(0)
  await page.getByTestId("org-delete").click()
  await expect(page.getByTestId("org-delete-workflows")).toHaveCount(0)
  await page.getByTestId("org-delete-back").click()
  await page.keyboard.press("Escape")
  expect(ops.id).toBeTruthy()

  // The profile of an agent has the same row, and the delete of an archived agent has the line.
  await flow("Solo", { kind: "agent", id: ada.id })
  await page.getByTestId("page-chats").click()
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-workflow")).toHaveText(["Solo"])
  await shot(page, "s146-04-agent-workflows-row")
  await page.keyboard.press("Escape")
  await rpc(page, "agents.archive", { id: ada.id })
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await page.getByTestId("archive-delete").click()
  await expect(page.getByTestId("delete-workflows-line")).toHaveText(
    "1 workflow that Ada owns has no owner then. Any agent can work in it.",
  )
  await shot(page, "s146-05-agent-delete-workflows")
  await page.getByTestId("delete-confirm-button").click()
  await expect
    .poll(async () => (await workflowsOf(page)).find((w) => w.name === "Solo")?.owner)
    .toBeNull()
  await app.close()
})

test("organization form: the new words are Korean", async () => {
  test.setTimeout(180_000)
  const { app, page } = await start("ko-KR")
  const server = await serverOf(page)
  const ada = (await agentsOf(page))[0] as AgentInfo
  const docs = await rpc<OrgInfo>(page, "organizations.create", {
    serverId: server,
    name: "Docs",
    memberIds: [ada.id],
    leadId: ada.id,
  })
  await rpc(page, "workflows.create", {
    serverId: server,
    name: "주간",
    trigger: { kind: "manual" },
    steps: [{ id: "n", kind: "notify", name: "알림", x: 40, y: 60, title: "안녕" }],
    edges: [],
    owner: { kind: "organization", id: docs.id },
  })
  await page.getByTestId("org-unit").filter({ hasText: "Docs" }).click()
  await expect(page.getByTestId("org-member-new-agent")).toHaveText("새 에이전트")
  await expect(page.getByTestId("org-workflows")).toContainText("워크플로우")
  await shot(page, "s146-06-org-form-ko")
  await page.getByTestId("org-delete").click()
  await expect(page.getByTestId("org-delete-workflows")).toContainText("워크플로우 1개")
  await shot(page, "s146-07-org-delete-ko")
  await app.close()
})
