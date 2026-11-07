import { expect, type Page, test } from "@playwright/test"
import { buildFlow, freshUserData, launch, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 010 ("Assistant"), 007 ("Following a run in the chat", "Guarded steps"): the chat reads and
// changes the graph, starts, stops and reads a run. The model is a stand-in that makes the tool
// call that the message names.

test.setTimeout(90_000)

const en = { ROBOT_SYSTEM_LOCALE: "en-US" }

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

const say = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text)
  await page.getByTestId("chat-input").press("Enter")
}

/** Waits until the tool card at this place has ended, and gives it. */
const ended = async (page: Page, index: number) => {
  const card = page.getByTestId("tool-card").nth(index)
  await expect(card).toBeVisible()
  await expect(card).not.toHaveAttribute("data-state", "running")
  return card
}

/** Opens a card and gives the text of its details (the arguments and the answer of the tool). */
const details = async (page: Page, index: number) => {
  const card = await ended(page, index)
  await card.locator("summary").click()
  return card
}

const rpc = <T>(page: Page, method: string, input?: unknown): Promise<T> =>
  page.evaluate(
    async ([m, i]) => {
      const invoke = (
        window as unknown as {
          robot: { invoke: (m: string, i?: unknown) => Promise<{ ok: boolean; value?: unknown }> }
        }
      ).robot.invoke
      const result = await invoke(m as string, i)
      if (!result.ok) throw new Error(`${m}: ${JSON.stringify(result)}`)
      return result.value
    },
    [method, input] as const,
  ) as Promise<T>

interface Detail {
  id: string
  graph: { nodes: { id: string; number: number; name: string; model: string | null }[] }
}
const detail = async (page: Page): Promise<Detail> => {
  const servers = await rpc<{ id: string; kind: string }[]>(page, "servers.list")
  const server = servers.find((s) => s.kind === "local")
  const flows = await rpc<{ id: string }[]>(page, "workflows.list", { serverId: server?.id })
  return rpc<Detail>(page, "workflows.get", { id: flows[0]?.id })
}

const twoNodes = (mockUrl: string, extra: { level?: string; slow?: boolean } = {}) => ({
  provider: { openaiUrl: mockUrl, key: GOOD_KEY },
  ...(extra.level ? { level: extra.level } : {}),
  nodes: [
    { name: "Fetch", prompt: extra.slow ? "slow" : "Fetch the data." },
    { name: "Write", prompt: "Write the report. {{input}}" },
  ],
  edges: [[0, 1]] as [number, number][],
})

test("add a node by chat: node 3 on the canvas, the version holds the graph from before", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await newWorkflow(page, "Weekly")
  await buildFlow(page, twoNodes(mock.openaiUrl))
  await expect(page.getByTestId("graph-node")).toHaveCount(2)
  await page.getByTestId("graph-versions-toggle").click()
  const before = await page.getByTestId("graph-version").count()

  await say(
    page,
    'tool add_node {"kind":"text","name":"Send","prompt":"Send the report.","after":2}',
  )
  const card = await details(page, 0)
  await expect(card).toContainText("Added a node")
  await expect(card).not.toContainText("add_node Tool")
  await expect(card).toContainText("kept as a version")
  // The canvas shows the saved change at once, with node 3 after node 2.
  await expect(page.getByTestId("graph-node")).toHaveCount(3)
  await expect(page.getByTestId("graph-node").nth(2)).toContainText("3. Send")
  await expect(page.getByTestId("graph-line")).toHaveCount(2)
  await expect(page.getByTestId("graph-version")).toHaveCount(before + 1)
  await shot(page, "b1-01-add-node")
  await app.close()
  await mock.close()
})

test("the cards of the tools speak Korean", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await newWorkflow(page, "주간 보고")
  await buildFlow(page, twoNodes(mock.openaiUrl))
  await say(page, 'tool add_node {"kind":"text","name":"보내기","prompt":"보고서를 보내요."}')
  const card = await ended(page, 0)
  await expect(card).toContainText("노드를 더했어요")
  await say(page, 'tool edit_node {"node":2,"prompt":"짧게 써요."}')
  await expect(await ended(page, 1)).toContainText("노드 2번을 바꿨어요")
  await shot(page, "b1-02-cards-ko")
  await app.close()
  await mock.close()
})

test("run by chat, ask how far it ran, then stop it by chat", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await newWorkflow(page, "Weekly")
  await buildFlow(page, twoNodes(mock.openaiUrl, { slow: true }))

  await say(page, 'tool start_run {"trigger":"Weekly"}')
  const started = await details(page, 0)
  await expect(started).toContainText("Started a run")
  await expect(started).toContainText("started. State: running")
  await page.getByTestId("tab-runs").click()
  await expect(page.getByTestId("runs-list").locator("li")).toHaveCount(1)

  // "How far is the run?": the node that works, and the node that is not reached.
  await say(page, "tool read_run {}")
  const read = await details(page, 1)
  await expect(read).toContainText("Read the state of a run")
  await expect(read).toContainText('Node 1 "Fetch" (text): running')
  await expect(read).toContainText('Node 2 "Write" (text): not reached')
  await expect(read).toContainText("Result: none yet")
  await shot(page, "b1-03-read-run")

  // A second run in the same turn is not possible; in a new turn a run works already.
  await say(page, "tool start_run {}")
  const again = await details(page, 2)
  await expect(again).toContainText("works or waits")

  await say(page, "tool stop_run {}")
  const stop = await details(page, 3)
  await expect(stop).toContainText("Stopped a run")
  await expect(stop).toContainText("was stopped")
  await page.getByTestId("tab-runs").click()
  await expect(page.getByTestId("runs-list")).toContainText("Cancelled")
  await shot(page, "b1-04-stopped")
  await app.close()
  await mock.close()
})

test("Read only refuses a change and a run", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await newWorkflow(page, "Weekly")
  await buildFlow(page, twoNodes(mock.openaiUrl, { level: "read_only" }))
  await say(page, 'tool add_node {"kind":"text","name":"Send"}')
  const change = await details(page, 0)
  await expect(change).toHaveAttribute("data-state", "failed")
  await expect(change).toContainText("Read only")
  await say(page, "tool start_run {}")
  const run = await details(page, 1)
  await expect(run).toHaveAttribute("data-state", "failed")
  await expect(run).toContainText("Read only")
  expect((await detail(page)).graph.nodes).toHaveLength(2)
  await page.getByTestId("tab-runs").click()
  await expect(page.getByTestId("runs-none")).toBeVisible()
  // A read works at Read only.
  await say(page, "tool read_workflow {}")
  await expect(await details(page, 2)).toContainText('Node 1 "Fetch"')
  await shot(page, "b1-05-read-only")
  await app.close()
  await mock.close()
})

test("a stale change is refused, the chat reads the graph again and the next change works", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await newWorkflow(page, "Weekly")
  await buildFlow(page, twoNodes(mock.openaiUrl))
  await say(page, 'tool-hold add_node {"kind":"text","name":"Send"}')
  await expect.poll(() => mock.held()).toBe(1)
  // The user renames node 1 in the editor while the turn works.
  const before = await detail(page)
  await rpc(page, "workflows.node.update", {
    id: before.graph.nodes[0]?.id,
    patch: { name: "Fetch data" },
  })
  mock.release()
  const stale = await details(page, 0)
  await expect(stale).toHaveAttribute("data-state", "failed")
  await expect(stale).toContainText("read_workflow")
  expect((await detail(page)).graph.nodes.map((n) => n.name)).toEqual(["Fetch data", "Write"])
  await shot(page, "b1-06-stale")

  await say(page, "tool read_workflow {}")
  await expect(await details(page, 1)).toContainText("Fetch data")
  await say(page, 'tool add_node {"kind":"text","name":"Send"}')
  await expect(await ended(page, 2)).toHaveAttribute("data-state", "done")
  expect((await detail(page)).graph.nodes.map((n) => n.name)).toEqual([
    "Fetch data",
    "Write",
    "Send",
  ])
  await app.close()
  await mock.close()
})

test("a model that the account does not offer is refused", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await newWorkflow(page, "Weekly")
  await buildFlow(page, twoNodes(mock.openaiUrl))
  await say(page, 'tool edit_node {"node":1,"model":"no-such-model"}')
  const card = await details(page, 0)
  await expect(card).toHaveAttribute("data-state", "failed")
  await expect(card).toContainText('does not offer the model "no-such-model"')
  expect((await detail(page)).graph.nodes[0]?.model).toBe("mock-fast")
  await say(page, 'tool edit_node {"node":1,"model":"gpt-5","effort":"high"}')
  await expect(await ended(page, 1)).toHaveAttribute("data-state", "done")
  expect((await detail(page)).graph.nodes[0]?.model).toBe("gpt-5")
  await shot(page, "b1-07-bad-model")
  await app.close()
  await mock.close()
})
