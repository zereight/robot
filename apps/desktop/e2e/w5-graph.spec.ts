import { expect, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, launch, shot, startHangingRun } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 010: the graph and node editor.

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("graph-editor")).toBeVisible()
}

test("graph: add nodes, edit a node, connect, decision options, delete, versions", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly")
  await expect(page.getByTestId("graph-empty")).toBeVisible()
  await shot(page, "w5-20-graph-empty")

  // Add a text node: it is numbered 1 and selected, and its panel opens.
  await page.getByTestId("graph-add-text").click()
  await expect(page.getByTestId("graph-node")).toHaveCount(1)
  await expect(page.getByTestId("node-panel")).toBeVisible()
  await page.getByTestId("node-name").fill("Collect")
  await page.getByTestId("node-name").press("Tab")
  // A change in the editor that saves says so.
  await expect(page.getByTestId("toast-success").last()).toHaveText(/Saved\./)
  await page.getByTestId("node-prompt").fill("Collect the news. {{input}}")
  await page.getByTestId("node-prompt").press("Tab")
  await expect(page.getByTestId("graph-node")).toContainText("1. Collect")

  // Provider, model and reasoning level come from the connected account.
  await page.getByTestId("node-provider").selectOption({ label: "Mock" })
  await page.getByTestId("node-model").selectOption("gpt-5")
  await page.getByTestId("node-effort").selectOption("high")
  // A new model resets a level that it does not list.
  await page.getByTestId("node-model").selectOption("mock-fast")
  await expect(page.getByTestId("node-effort")).toHaveCount(0)
  await page.getByTestId("node-model").selectOption("gpt-5")
  await page.getByTestId("node-effort").selectOption("medium")

  // The permission level of a node is never looser than the workflow ("Ask for risky steps").
  const levels = await page.getByTestId("node-permission").locator("option").allTextContents()
  expect(levels).toEqual([
    "Same as the workflow",
    "Read only",
    "Ask for everything",
    "Ask for risky steps",
  ])
  await page.getByTestId("node-permission").selectOption("read_only")

  // The silent limit of the node: Follow settings, minutes, or Never. It saves like other fields.
  const silent = await page.getByTestId("node-silent-limit").locator("option").allTextContents()
  expect(silent).toEqual([
    "Follow settings",
    "1 min",
    "5 min",
    "10 min",
    "30 min",
    "60 min",
    "Never",
  ])
  await page.getByTestId("node-silent-limit").selectOption("30")
  await expect(page.getByTestId("toast-success").last()).toHaveText(/Saved\./)
  await page.getByTestId("node-silent-limit").scrollIntoViewIfNeeded()
  await shot(page, "w5-21b-node-silent-limit")

  // A second text node, and a connection from the first to it.
  await page.getByTestId("graph-add-text").click()
  await page.getByTestId("node-name").fill("Write")
  await page.getByTestId("node-name").press("Tab")
  await page.getByTestId("graph-node").first().click()
  await page.getByTestId("node-next-add").selectOption({ label: "2. Write" })
  await expect(page.getByTestId("graph-line")).toHaveCount(1)
  await expect(page.getByTestId("node-next")).toContainText("2. Write")
  await shot(page, "w5-21-graph-two-nodes")

  // A decision node has two options and one outgoing connection for each. No option leads
  // anywhere yet: the editor names both as problems of the graph.
  await page.getByTestId("graph-add-decision").click()
  await expect(page.getByTestId("node-option")).toHaveCount(2)
  await expect(page.getByTestId("node-effort")).toHaveCount(0)
  // A decision node has no silent limit of its own.
  await expect(page.getByTestId("node-silent-limit")).toHaveCount(0)
  await expect(page.getByTestId("node-threshold")).toHaveValue("0.9")
  await expect(page.getByTestId("graph-problems").locator("li")).toHaveCount(2)
  // The two kinds differ in shape and icon, not only in the word: a text node is a solid card, a
  // decision node a dashed pill.
  const textNode = page.locator('[data-testid="graph-node"][data-kind="text"]').first()
  const decisionNode = page.locator('[data-testid="graph-node"][data-kind="decision"]')
  await expect(textNode).toHaveCSS("border-top-style", "solid")
  await expect(decisionNode).toHaveCSS("border-top-style", "dashed")
  await expect(textNode.getByTestId("graph-node-kind").locator("svg")).toHaveCount(1)
  await expect(decisionNode.getByTestId("graph-node-kind").locator("svg")).toHaveCount(1)
  await page.getByTestId("node-option-target").first().selectOption({ label: "2. Write" })
  await expect(page.getByTestId("graph-problems").locator("li")).toHaveCount(1)
  await expect(page.getByTestId("graph-line")).toHaveCount(2)
  // An option can be renamed, added and removed. The last two stay.
  await page.getByTestId("node-option-label").nth(1).fill("Never")
  await page.getByTestId("node-option-label").nth(1).press("Tab")
  await page.getByTestId("node-option-add").click()
  await expect(page.getByTestId("node-option")).toHaveCount(3)
  await page.getByTestId("node-option-remove").last().click()
  await expect(page.getByTestId("node-option")).toHaveCount(2)
  await expect(page.getByTestId("node-option-remove").first()).toBeDisabled()
  await shot(page, "w5-22-graph-decision")

  // The workflow card counts the problem.
  await expect(page.getByTestId("workflow-check")).toHaveText("Check: Problem found")
  await expect(page.getByTestId("workflow-nodes")).toHaveText("3 nodes")
  await page.getByTestId("workflow-open").click()

  // The graph stays after a restart, with the place and the settings of each node.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await expect(page.getByTestId("graph-node")).toHaveCount(3)
  await page.getByTestId("graph-node").first().click()
  await expect(page.getByTestId("node-prompt")).toHaveValue("Collect the news. {{input}}")
  await expect(page.getByTestId("node-model")).toHaveValue("gpt-5")
  await expect(page.getByTestId("node-effort")).toHaveValue("medium")
  await expect(page.getByTestId("node-permission")).toHaveValue("read_only")
  await expect(page.getByTestId("node-silent-limit")).toHaveValue("30")

  // Removing a connection asks first. "Keep it" changes nothing.
  await page.getByTestId("node-next-remove").click()
  await expect(page.getByTestId("node-next-ask")).toContainText("Write")
  await page.getByRole("button", { name: "Keep it" }).click()
  await expect(page.getByTestId("graph-line")).toHaveCount(2)
  await page.getByTestId("node-next-remove").click()
  await page.getByTestId("node-next-confirm").click()
  await expect(page.getByTestId("graph-line")).toHaveCount(1)

  // Deleting a node asks first, takes its connections with it, and renumbers the rest.
  await page.getByTestId("graph-node").first().click()
  await page.getByTestId("node-delete").click()
  await expect(page.getByTestId("node-delete-ask")).toContainText("Collect")
  await shot(page, "w5-23-graph-delete-ask")
  await page.getByTestId("node-delete-confirm").click()
  await expect(page.getByTestId("graph-node")).toHaveCount(2)
  await expect(page.getByTestId("graph-node").first()).toContainText("1. Write")
  await expect(page.getByTestId("graph-line")).toHaveCount(1)

  // Each change kept a version. Restoring one brings the graph back, and keeps the one it replaces.
  await page.getByTestId("graph-versions-toggle").click()
  const before = await page.getByTestId("graph-version").count()
  expect(before).toBeGreaterThan(5)
  await page.getByTestId("graph-version-restore").last().click()
  await expect(page.getByTestId("toast-success").last()).toContainText("Restored.")
  await expect(page.getByTestId("graph-node")).toHaveCount(0)
  await expect(page.getByTestId("graph-version")).toHaveCount(before + 1)
  await shot(page, "w5-24-graph-versions")
  await app.close()
  await mock.close()
})

test("graph: a node moves with the keyboard and the pointer, and keeps its number", async () => {
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await page.getByTestId("graph-add-text").click()
  const node = page.getByTestId("graph-node")
  const before = await node.boundingBox()
  await node.focus()
  await page.keyboard.press("Alt+ArrowRight")
  await expect
    .poll(async () => (await node.boundingBox())?.x ?? 0)
    .toBeGreaterThan((before?.x ?? 0) + 8)
  while ((await page.getByTestId("toast-dismiss").count()) > 0)
    await page.getByTestId("toast-dismiss").first().click()
  const mid = await node.boundingBox()
  await page.mouse.move((mid?.x ?? 0) + 20, (mid?.y ?? 0) + 20)
  await page.mouse.down()
  await page.mouse.move((mid?.x ?? 0) + 120, (mid?.y ?? 0) + 90, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await node.boundingBox())?.y ?? 0)
    .toBeGreaterThan((mid?.y ?? 0) + 50)
  await expect(page.getByTestId("toast-success").last()).toHaveText(/Saved\./)
  await expect(node).toContainText("1.")
  // A move keeps no version of the graph.
  await page.getByTestId("graph-versions-toggle").click()
  await expect(page.getByTestId("graph-version")).toHaveCount(1)
  await app.close()
})

test("workflow settings: the permission level and the folder, in Korean words too", async () => {
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("주간 보고")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("tab-graph")).toHaveText("그래프")
  await expect(page.getByTestId("graph-add-text")).toHaveText("텍스트 노드 추가")
  await shot(page, "w5-25-graph-ko")
  await page.getByTestId("tab-settings").click()
  await expect(page.getByTestId("workflow-permission")).toHaveValue("ask_risky")
  await page.getByTestId("workflow-permission").selectOption("read_only")
  await page.getByTestId("tab-graph").click()
  await page.getByTestId("tab-settings").click()
  await expect(page.getByTestId("workflow-permission")).toHaveValue("read_only")
  await expect(page.getByTestId("workflow-folder")).toContainText("workflow")
  await shot(page, "w5-26-settings-ko")
  await app.close()
})

test("workflow settings: the folder and the level are read-only while a run works", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("Weekly")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("tab-settings")).toBeVisible()
  await startHangingRun(page, { openaiUrl: mock.openaiUrl, key: GOOD_KEY })
  await page.getByTestId("tab-settings").click()
  await expect(page.getByTestId("workflow-settings-readonly")).toBeVisible()
  await expect(page.getByTestId("workflow-permission")).toBeDisabled()
  await expect(page.getByTestId("workflow-folder-pick")).toBeDisabled()
  // A workflow that runs is not deleted: the button is off and the read-only line shows.
  await expect(page.getByTestId("workflow-running-readonly")).toBeVisible()
  await expect(page.getByTestId("workflow-delete")).toBeDisabled()
  await expect(page.getByTestId("workflow-card-readonly")).toBeVisible()
  await expect(page.getByTestId("workflow-card-delete")).toBeDisabled()
  await shot(page, "w5-27-card-running")
  await app.close()
  await mock.close()
})

test("node panel: a background change keeps the focus and the typed text of a field", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await page.getByTestId("graph-add-decision").click()
  await expect(page.getByTestId("node-option")).toHaveCount(2)
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
  // "Check" runs the check again: the main process sends "workflows.changed", the window reads
  // the workflow again, and the new objects must not replace the field that holds the focus.
  const check = () =>
    page.evaluate(async () => {
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
  // The text is typed and not saved: a field saves when it loses the focus.
  for (const id of ["node-option-label", "node-name", "node-question"]) {
    const field = page.getByTestId(id).first()
    await field.focus()
    await field.pressSequentially(" half-typed")
    await expect(field).toBeFocused()
    const typed = await field.inputValue()
    expect(typed).toContain("half-typed")
    const before = await changed()
    await check()
    await expect
      .poll(changed, { message: `no workflows.changed event arrived (${id})` })
      .toBeGreaterThan(before)
    await expect(page.getByTestId("check-state")).toHaveText("Problem found")
    await expect(field).toBeFocused()
    await expect(field).toHaveValue(typed)
  }
  await app.close()
})
