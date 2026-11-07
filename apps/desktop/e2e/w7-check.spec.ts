import { expect, type Page, test } from "@playwright/test"
import { buildFlow, freshUserData, launch, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 010, "Check": a graph with a fault shows "Problem found" with its place and its path. The
// run does not start. After the fix the check passes and the run goes.

test.setTimeout(90_000)

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("graph-editor")).toBeVisible()
}

/** Draft, then Edit and Publish that wait for each other: a loop that no run can leave. */
const badGraph = async (page: Page, mock: { openaiUrl: string }) =>
  buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Draft", prompt: "Write: {{trigger}}" },
      { name: "Edit", prompt: "Edit: {{input}}" },
      { name: "Publish", prompt: "Publish: {{input}}" },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 1],
    ],
  })

test("check: a loop shows Problem found with its place, the run does not start, the fix passes and runs", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await badGraph(page, mock)

  // The check runs by itself after the change. The panel names the nodes of the problem and shows
  // the path to it as a numbered list.
  await expect(page.getByTestId("check-state")).toHaveText("Problem found")
  await expect(page.getByTestId("graph-problems")).toContainText("wait for each other")
  await expect(page.getByTestId("graph-problems")).toContainText("2 “Edit”")
  await expect(page.getByTestId("graph-problems")).toContainText("3 “Publish”")
  await expect(page.getByTestId("check-path-line")).toHaveCount(1)
  await expect(page.getByTestId("check-path-line").first()).toHaveText("Node 1 “Draft” runs.")
  // "Problem found" is in a live region, as "Passed" is.
  await expect(page.getByTestId("check-status")).toHaveAttribute("role", "status")
  await expect(page.getByTestId("check-status").getByTestId("check-problem-found")).toHaveText(
    "Problem found",
  )

  // The canvas marks the nodes of the problem with the danger colour and an icon, and the node of
  // the path with the number of its line. A click on a line selects its node.
  const nodes = page.getByTestId("graph-node")
  await expect(nodes.nth(0).getByTestId("graph-node-mark")).toHaveText("1")
  await expect(nodes.nth(0)).toHaveAttribute("data-problem", "false")
  await expect(nodes.nth(1)).toHaveAttribute("data-problem", "true")
  await expect(nodes.nth(2)).toHaveAttribute("data-problem", "true")
  await expect(nodes.nth(1).getByTestId("graph-node-mark").locator("svg")).toHaveCount(1)
  // A screen reader hears the mark and the problem: they are in the name of the node button.
  await expect(nodes.nth(0)).toHaveAttribute("aria-label", "Node 1: Draft. Step 1 of the path")
  await expect(nodes.nth(1)).toHaveAttribute("aria-label", "Node 2: Edit. Problem node")
  await page.getByTestId("check-path-line").first().click()
  await expect(nodes.nth(0)).toHaveAttribute("aria-pressed", "true")
  await shot(page, "w7-01-problem")

  // The run does not start, and the message says why. A loop has its own test that does not use
  // the checker, so it has its own words.
  await page.getByTestId("workflow-run").click()
  await expect(
    page.getByText("The nodes of this workflow make a loop. A run cannot start."),
  ).toBeVisible()
  await page.getByTestId("tab-runs").click()
  await expect(page.getByTestId("runs-none")).toBeVisible()
  await page.getByTestId("tab-graph").click()

  // The card of the list shows the same state.
  await page.getByTestId("workflow-back").click()
  await expect(page.getByTestId("workflow-check")).toHaveText("Check: Problem found")
  await shot(page, "w7-02-card-problem")
  await page.getByTestId("workflow-open").click()

  // The fix: Publish stops waiting for Edit. The check runs again and passes.
  await nodes.nth(2).click()
  await page.getByTestId("node-next-remove").click()
  await page.getByTestId("node-next-confirm").click()
  await expect(page.getByTestId("check-state")).toHaveText("Passed")
  await expect(page.getByTestId("check-passed")).toContainText("no problem")
  await expect(page.getByTestId("graph-problems")).toHaveCount(0)
  await expect(page.getByTestId("graph-node-mark")).toHaveCount(0)
  await shot(page, "w7-03-passed")

  // The button "Check" runs the check again on request.
  await page.getByTestId("graph-check").click()
  await expect(page.getByTestId("check-state")).toHaveText("Passed")

  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await page.getByTestId("workflow-back").click()
  await expect(page.getByTestId("workflow-check")).toHaveText("Check: Passed")
  await app.close()
  await mock.close()
})

test("check: the problem and its path are in Korean when the window is Korean", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await newWorkflow(page, "주간 보고")
  await badGraph(page, mock)
  await expect(page.getByTestId("check-state")).toHaveText("문제 발견")
  await expect(page.getByTestId("graph-problems")).toContainText("서로를 기다려서")
  await expect(page.getByTestId("check-path-line").first()).toHaveText("노드 1 “Draft” 실행")
  await shot(page, "w7-04-problem-ko")
  await page.getByTestId("workflow-back").click()
  await expect(page.getByTestId("workflow-check")).toHaveText("검사: 문제 발견")
  await app.close()
  await mock.close()
})

test("check: the panel closes and opens again, and the marks go with it", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await badGraph(page, mock)
  await expect(page.getByTestId("check-state")).toHaveText("Problem found")
  await expect(page.getByTestId("graph-node-mark")).toHaveCount(3)
  await page.getByTestId("check-close").click()
  await expect(page.getByTestId("check-panel")).toHaveCount(0)
  await expect(page.getByTestId("graph-node-mark")).toHaveCount(0)
  await page.getByTestId("check-open").click()
  await expect(page.getByTestId("graph-node-mark")).toHaveCount(3)
  await app.close()
  await mock.close()
})

test("check: a background result does not take the focus from a node of the canvas", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await badGraph(page, mock)
  await expect(page.getByTestId("check-state")).toHaveText("Problem found")
  await page.evaluate(() => {
    const w = window as unknown as {
      robot: { on: (event: string, fn: () => void) => void }
      changed: number
    }
    w.changed = 0
    w.robot.on("workflows.changed", () => {
      w.changed++
    })
  })
  const changed = () => page.evaluate(() => (window as unknown as { changed: number }).changed)
  const node = page.getByTestId("graph-node").nth(1)
  await node.focus()
  await expect(node).toBeFocused()
  const before = await changed()
  // "Check" runs the check again: the main process sends "workflows.changed".
  await page.evaluate(async () => {
    const invoke = (
      window as unknown as {
        robot: { invoke: (m: string, i?: unknown) => Promise<{ ok: boolean; value?: unknown }> }
      }
    ).robot.invoke
    const servers = (await invoke("servers.list")).value as { id: string; kind: string }[]
    const local = servers.find((s) => s.kind === "local")
    const flows = (await invoke("workflows.list", { serverId: local?.id })).value as {
      id: string
    }[]
    for (const flow of flows) await invoke("workflows.check", { id: flow.id })
  })
  await expect
    .poll(changed, { message: "no workflows.changed event arrived" })
    .toBeGreaterThan(before)
  await expect(page.getByTestId("check-state")).toHaveText("Problem found")
  await expect(node).toBeFocused()
  await app.close()
  await mock.close()
})

test("check: a stopped check and a failed check show words of the window, not the words of the checker", async () => {
  const userData = freshUserData()
  let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await app.close()

  const { DatabaseSync } = await import("node:sqlite")
  const { join } = await import("node:path")
  const seed = (outcome: object) => {
    const db = new DatabaseSync(join(userData, "robot.db"))
    const flow = db.prepare("SELECT id FROM workflow").get() as { id: string }
    // The key of a graph with no node (the key is the shape: see `checkGraphKey`).
    db.prepare(
      `INSERT INTO workflow_check (workflow_id, graph_key, outcome, checked_at) VALUES (?, '[[],[]]', ?, 1)
       ON CONFLICT (workflow_id) DO UPDATE SET outcome = excluded.outcome, graph_key = excluded.graph_key`,
    ).run(flow.id, JSON.stringify(outcome))
    db.close()
  }
  const raw = "Unexpected token in module Workflow at line 12"

  seed({ state: "stopped", reason: "states" })
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" }))
  // The app opens at the workflow that was open.
  const stopped = page.getByTestId("check-stopped")
  await expect(stopped).toContainText("stops after 60 seconds")
  await expect(stopped).not.toContainText("at the same time")
  await expect(page.getByTestId("check-state")).toHaveText("Could not check")
  await app.close()

  seed({ state: "failed", message: raw })
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  const failed = page.getByTestId("check-failed")
  await expect(failed).toContainText("앱의 문제예요")
  await expect(failed).not.toContainText("Unexpected")
  await expect(page.locator("body")).not.toContainText(raw)
  await shot(page, "w7-05-failed-ko")
  await app.close()
})
