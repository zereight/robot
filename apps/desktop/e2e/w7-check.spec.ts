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

  // The canvas marks the nodes of the problem with the danger colour and an icon, and the node of
  // the path with the number of its line. A click on a line selects its node.
  const nodes = page.getByTestId("graph-node")
  await expect(nodes.nth(0).getByTestId("graph-node-mark")).toHaveText("1")
  await expect(nodes.nth(0)).toHaveAttribute("data-problem", "false")
  await expect(nodes.nth(1)).toHaveAttribute("data-problem", "true")
  await expect(nodes.nth(2)).toHaveAttribute("data-problem", "true")
  await expect(nodes.nth(1).getByTestId("graph-node-mark").locator("svg")).toHaveCount(1)
  await page.getByTestId("check-path-line").first().click()
  await expect(nodes.nth(0)).toHaveAttribute("aria-pressed", "true")
  await shot(page, "w7-01-problem")

  // The run does not start, and the message says why.
  await page.getByTestId("workflow-run").click()
  await expect(
    page.getByText("The check found a problem. Open the workflow to see it."),
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
