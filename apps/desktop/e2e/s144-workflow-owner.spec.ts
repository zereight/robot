import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The owner of a workflow (spec 010, "Owner and participants"): "Docs" has the lead Ada and the member
// Bo, "Ops" has the lead Cy and the member Dee, and Eve is in no organization. The agent list of a step
// of a workflow of "Docs" shows Ada, Bo and Cy. A step that names Dee fails with "Not a participant"
// until Dee leads "Ops". The page filters by owner, and a delete of "Docs" leaves the workflow shared.

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await serverOf(page), archived: false })
const idOf = async (page: Page, name: string) =>
  (await agentsOf(page)).find((a) => a.name === name)?.id as string

/** The names in the agent list of a step, without the organization prefix of the window. */
const stepAgentNames = async (page: Page) =>
  (await page.getByTestId("wf-step-agent").locator("option").allInnerTexts()).map((text) =>
    text.replace(/^\[[^\]]*\]\s*/, "").replace(/\s·.*$/, ""),
  )

const setup = async (locale: string) => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: locale })
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await page.getByTestId("page-chats").click()
  await createAgent(page, "Ada")
  const template = (await agentsOf(page))[0] as AgentInfo
  const server = await serverOf(page)
  for (const name of ["Bo", "Cy", "Dee", "Eve"])
    await rpc(page, "agents.create", {
      serverId: server,
      name,
      role: "",
      instructions: "",
      model: template.model,
    })
  const [ada, bo, cy, dee] = await Promise.all(["Ada", "Bo", "Cy", "Dee"].map((n) => idOf(page, n)))
  const docs = await rpc<{ id: string }>(page, "organizations.create", {
    serverId: server,
    name: "Docs",
    memberIds: [ada, bo],
    leadId: ada,
  })
  const ops = await rpc<{ id: string }>(page, "organizations.create", {
    serverId: server,
    name: "Ops",
    memberIds: [cy, dee],
    leadId: cy,
  })
  return { app, page, server, ada: ada as string, bo, cy, dee: dee as string, docs, ops }
}

test("workflow owner: only the participants work in a step, the page filters, and a delete leaves the workflow shared", async () => {
  test.setTimeout(240_000)
  const s = await setup("en-US")
  const { page } = s

  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-new").click()
  await page.getByTestId("wf-name").fill("Weekly")
  await page.getByTestId("wf-owner").selectOption({ label: "Docs" })

  // The agent list shows the members of "Docs" and the lead of "Ops", and nobody else.
  await page.getByTestId("wf-add-agent").click()
  expect(await stepAgentNames(page)).toEqual(["Pick an agent", "Ada", "Bo", "Cy"])
  const cyOption = page.getByTestId("wf-step-agent").locator("option", { hasText: "Cy" })
  await page.getByTestId("wf-step-agent").selectOption((await cyOption.getAttribute("value")) ?? "")
  await page.getByTestId("wf-step-prompt").fill("Write the weekly note")
  await page.getByTestId("wf-save").click()
  await shot(page, "s144-01-editor-owner")

  // A lead of another organization works in the step.
  await page.getByTestId("wf-run").click()
  await expect(page.locator("[data-testid=wf-node][data-state=done]")).toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(page.getByTestId("wf-node-outsider")).toHaveCount(0)

  // A step that names Dee fails: Dee is a member of "Ops" and is not its lead.
  const [flow] = await rpc<{ id: string; steps: { id: string }[] }[]>(page, "workflows.list", {
    serverId: s.server,
  })
  const step = flow?.steps[0] as { id: string }
  await rpc(page, "workflows.update", {
    id: flow?.id,
    patch: { steps: [{ ...step, agentId: s.dee }] },
  })
  await page.getByTestId("wf-back").click()
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-node-outsider")).toHaveText("Not a participant")
  await page.getByTestId("wf-node").first().click()
  expect(await stepAgentNames(page)).toEqual(["Pick an agent", "Ada", "Bo", "Cy", "Dee"])
  await shot(page, "s144-02-not-a-participant")
  await page.getByTestId("wf-run").click()
  await expect(page.locator("[data-testid=wf-node][data-state=failed]")).toHaveCount(1, {
    timeout: 30_000,
  })
  await page.getByTestId("wf-run-step").first().locator("summary").click()
  await expect(page.getByTestId("wf-run-step").first()).toContainText("Not a participant")

  // Dee leads "Ops" now. No step was edited, and the next run works.
  await rpc(page, "organizations.update", { id: s.ops.id, patch: { leadId: s.dee } })
  await expect(page.getByTestId("wf-node-outsider")).toHaveCount(0)
  await page.getByTestId("wf-run").click()
  await expect(page.locator("[data-testid=wf-node][data-state=done]")).toHaveCount(1, {
    timeout: 30_000,
  })

  // The page: the card names the owner, and the filter shows by owner.
  await page.getByTestId("wf-back").click()
  await expect(page.getByTestId("wf-owner")).toHaveText("Owner: Docs")
  await page.getByTestId("wf-owner-filter").selectOption({ label: "None" })
  await expect(page.getByTestId("wf-card")).toHaveCount(0)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "Docs" })
  await expect(page.getByTestId("wf-card")).toHaveCount(1)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "Ops" })
  await expect(page.getByTestId("wf-card")).toHaveCount(0)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "All" })
  await shot(page, "s144-03-list")

  // A workflow of an agent has that agent only.
  await page.getByTestId("wf-open").click()
  await page.getByTestId("wf-owner").selectOption({ label: "Eve" })
  await page.getByTestId("wf-node").first().click()
  expect(await stepAgentNames(page)).toEqual(["Pick an agent", "Eve", "Dee"])

  // A delete of "Docs" leaves the workflow with no owner, and the runs stay.
  await page.getByTestId("wf-owner").selectOption({ label: "Docs" })
  await page.getByTestId("wf-save").click()
  await rpc(page, "organizations.delete", { id: s.docs.id })
  await page.getByTestId("wf-back").click()
  await expect(page.getByTestId("wf-owner")).toHaveCount(0)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "None" })
  await expect(page.getByTestId("wf-card")).toHaveCount(1)
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-owner")).toHaveValue("")
  await expect(page.getByTestId("wf-run-row")).toHaveCount(3)
  await page.getByTestId("wf-node").first().click()
  expect(await stepAgentNames(page)).toEqual(["Pick an agent", "Ada", "Bo", "Cy", "Dee", "Eve"])
  await s.app.close()
})

test("workflow owner: the words are Korean", async () => {
  test.setTimeout(180_000)
  const s = await setup("ko-KR")
  const { page } = s
  await rpc(page, "workflows.create", {
    serverId: s.server,
    name: "주간",
    trigger: { kind: "manual" },
    steps: [
      {
        id: "a",
        kind: "agent",
        name: "쓰기",
        x: 40,
        y: 60,
        agentId: s.dee,
        prompt: "써 줘",
        continueOnFailure: false,
      },
    ],
    edges: [],
    owner: { kind: "organization", id: s.docs.id },
  })
  await page.getByTestId("page-workflows").click()
  await expect(page.getByTestId("wf-owner")).toHaveText("소유자: Docs")
  await shot(page, "s144-04-list-ko")
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-node-outsider")).toHaveText("참석자 아님")
  await page.getByTestId("wf-node").first().click()
  await shot(page, "s144-05-editor-ko")
  await page.getByTestId("wf-run").click()
  await page.getByTestId("wf-run-step").first().locator("summary").click()
  await expect(page.getByTestId("wf-run-step").first()).toContainText("참석자 아님")
  await s.app.close()
})
