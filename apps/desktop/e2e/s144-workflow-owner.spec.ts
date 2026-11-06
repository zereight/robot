import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The owner of a workflow (spec 010, "Owner and participants"): the owner is an agent or none. A
// workflow of Eve has Eve only in the agent list of a step. A step that names Bo fails with "Not a
// participant". With no owner, all agents can work in a step. The page filters by owner.

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

/** The names in the agent list of a step, without the mark of an agent that is not a participant. */
const stepAgentNames = async (page: Page) =>
  (await page.getByTestId("wf-step-agent").locator("option").allInnerTexts()).map((text) =>
    text.replace(/\s·.*$/, ""),
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
  for (const name of ["Bo", "Eve"])
    await rpc(page, "agents.create", {
      serverId: server,
      name,
      role: "",
      instructions: "",
      model: template.model,
    })
  const [bo, eve] = await Promise.all(["Bo", "Eve"].map((n) => idOf(page, n)))
  return { app, page, mock, server, bo: bo as string, eve: eve as string }
}

test("workflow owner: only the owner works in a step, the page filters, and no owner allows all agents", async () => {
  test.setTimeout(240_000)
  const s = await setup("en-US")
  const { page } = s

  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-new").click()
  await page.getByTestId("wf-name").fill("Weekly")
  await page.getByTestId("wf-owner").selectOption({ label: "Eve" })

  // The agent list shows the owner, and nobody else. The new step names Ada, who is not a
  // participant: the list keeps her as the marked pick.
  await page.getByTestId("wf-add-agent").click()
  expect(await stepAgentNames(page)).toEqual(["Pick an agent", "Eve", "Ada"])
  await expect(page.getByTestId("wf-node-outsider")).toHaveText("Not a participant")
  await page.getByTestId("wf-step-agent").selectOption({ label: "Eve" })
  await page.getByTestId("wf-step-prompt").fill("Write the weekly note")
  await page.getByTestId("wf-save").click()
  await shot(page, "s144-01-editor-owner")

  await page.getByTestId("wf-run").click()
  await expect(page.locator("[data-testid=wf-node][data-state=done]")).toHaveCount(1, {
    timeout: 30_000,
  })
  await expect(page.getByTestId("wf-node-outsider")).toHaveCount(0)

  // A step that names Bo fails: Bo is not the owner.
  const [flow] = await rpc<{ id: string; steps: { id: string }[] }[]>(page, "workflows.list", {
    serverId: s.server,
  })
  const step = flow?.steps[0] as { id: string }
  await rpc(page, "workflows.update", {
    id: flow?.id,
    patch: { steps: [{ ...step, agentId: s.bo }] },
  })
  await page.getByTestId("wf-back").click()
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-node-outsider")).toHaveText("Not a participant")
  await page.getByTestId("wf-node").first().click()
  expect(await stepAgentNames(page)).toEqual(["Pick an agent", "Eve", "Bo"])
  await shot(page, "s144-02-not-a-participant")
  await page.getByTestId("wf-run").click()
  await expect(page.locator("[data-testid=wf-node][data-state=failed]")).toHaveCount(1, {
    timeout: 30_000,
  })
  await page.getByTestId("wf-run-step").first().locator("summary").click()
  await expect(page.getByTestId("wf-run-step").first()).toContainText("Not a participant")

  // The page: the card names the owner, and the filter shows by owner.
  await page.getByTestId("wf-back").click()
  await expect(page.getByTestId("wf-owner")).toHaveText("Owner: Eve")
  await page.getByTestId("wf-owner-filter").selectOption({ label: "None" })
  await expect(page.getByTestId("wf-card")).toHaveCount(0)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "Eve" })
  await expect(page.getByTestId("wf-card")).toHaveCount(1)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "Ada" })
  await expect(page.getByTestId("wf-card")).toHaveCount(0)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "All" })
  await shot(page, "s144-03-list")

  // With no owner, all agents can work in a step, and the runs stay.
  await page.getByTestId("wf-open").click()
  await page.getByTestId("wf-owner").selectOption({ label: "None" })
  await page.getByTestId("wf-save").click()
  await expect(page.getByTestId("wf-node-outsider")).toHaveCount(0)
  await page.getByTestId("wf-node").first().click()
  expect(await stepAgentNames(page)).toEqual(["Pick an agent", "Ada", "Bo", "Eve"])
  await page.getByTestId("wf-back").click()
  await expect(page.getByTestId("wf-owner")).toHaveCount(0)
  await page.getByTestId("wf-owner-filter").selectOption({ label: "None" })
  await expect(page.getByTestId("wf-card")).toHaveCount(1)
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-run-row")).toHaveCount(2)
  await s.app.close()
  await s.mock.close()
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
        agentId: s.bo,
        prompt: "써 줘",
        continueOnFailure: false,
      },
    ],
    edges: [],
    owner: { kind: "agent", id: s.eve },
  })
  await page.getByTestId("page-workflows").click()
  await expect(page.getByTestId("wf-owner")).toHaveText("소유자: Eve")
  await shot(page, "s144-04-list-ko")
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-node-outsider")).toHaveText("참석자 아님")
  await page.getByTestId("wf-node").first().click()
  await shot(page, "s144-05-editor-ko")
  await page.getByTestId("wf-run").click()
  await page.getByTestId("wf-run-step").first().locator("summary").click()
  await expect(page.getByTestId("wf-run-step").first()).toContainText("참석자 아님")
  await s.app.close()
  await s.mock.close()
})
