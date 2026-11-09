import { expect, type Page, test } from "@playwright/test"
import { buildFlow, launch, shot, startRunCall } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const env = {
  ROBOT_TEST_OPENAI_URL: "",
  ROBOT_TEST_OPENAI_KEY: "",
  ROBOT_SYSTEM_LOCALE: "en-US",
}

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

const gate = (page: Page) => page.getByTestId("card-verdict")

test("run: an approval node waits for the user; approve with a comment goes on", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Approval")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Draft", prompt: "Draft" },
      { name: "Gate", kind: "approval", question: "Ship it?" },
      { name: "Ship", prompt: "Ship {{input}}" },
    ],
    edges: [
      [0, 1],
      [1, 2, { output: "approve" }],
    ],
  })
  await page.getByTestId("workflow-run").click()
  await expect(gate(page)).toBeVisible()
  await expect(gate(page).getByTestId("card-summary")).toHaveText("Ship it?")
  await expect(gate(page).getByTestId("card-verdict-input")).toHaveText("You said: Draft")
  await expect(page.getByTestId("run-state")).toHaveText("Waiting for you")
  await expect(page.getByTestId("run-node-state-2")).toHaveText("Waiting for you")
  await shot(page, "w6a-01-approval-card")
  await gate(page).getByTestId("card-comment-input").fill("Shorter")
  await gate(page).getByTestId("card-approve").click()
  await expect(page.getByTestId("card-verdict")).toHaveCount(0)
  await expect(page.getByTestId("card-answered")).toContainText("Approved")
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-input-3")).toContainText("Comment from the user:")
  const input = await page.getByTestId("run-node-input-3").textContent()
  expect(input?.endsWith("Comment from the user:\nShorter")).toBe(true)
  await expect(page.getByTestId("run-node-approval-2")).toContainText("Answer: Approved")
  await expect(page.getByTestId("run-node-approval-2")).toContainText("Comment: Shorter")
  await expect(page.getByTestId("run-node-approval-2").locator("span").nth(2)).not.toBeEmpty()
  await shot(page, "w6a-02-approval-answered")
  await app.close()
  await mock.close()
})

test("run: reject follows the reject output; an output with no connection skips its nodes", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Rejection")
  const workflowId = await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Draft", prompt: "Draft" },
      { name: "Gate", kind: "approval", question: "Ship it?" },
      { name: "Ship", prompt: "Ship {{input}}" },
      { name: "Rework", prompt: "Rework {{input}}" },
    ],
    edges: [
      [0, 1],
      [1, 2, { output: "approve" }],
      [1, 3, { output: "reject" }],
    ],
  })
  await startRunCall(page, workflowId)
  await expect(gate(page)).toBeVisible()
  await gate(page).getByTestId("card-comment-input").fill("Too long")
  await gate(page).getByTestId("card-reject").click()
  await expect(page.getByTestId("card-answered")).toContainText("Rejected")
  await page.getByTestId("runs-list").locator("button").first().click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-state-3")).toHaveText("Skipped")
  await expect(page.getByTestId("run-node-state-4")).toHaveText("Done")
  await expect(page.getByTestId("run-node-input-4")).toContainText("Too long")
  await app.close()
  await mock.close()
})

test("graph: an approval node is added on the canvas with its own shape; the panel edits the question", async () => {
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Gate on canvas")
  await page.getByTestId("graph-add-approval").click()
  const node = page.getByTestId("graph-node")
  await expect(node).toHaveCount(1)
  await expect(node).toHaveAttribute("data-kind", "approval")
  await expect(page.getByTestId("graph-node-kind")).toContainText("Approval node")
  await expect(node).toHaveCSS("border-style", "solid")
  await expect(node).toHaveCSS("border-bottom-left-radius", "0px")
  await expect(node).not.toHaveCSS("border-radius", "999px")
  await expect(page.getByTestId("node-question")).toHaveValue("Approve this run?")
  await page.getByTestId("node-question").fill("Ship it?")
  await page.getByTestId("node-question").press("Tab")
  await expect(page.getByTestId("node-option")).toHaveCount(2)
  await expect(page.getByTestId("node-option-label").first()).toHaveText("Approve")
  await expect(page.getByTestId("node-option-label").nth(1)).toHaveText("Reject")
  await shot(page, "w6a-03-approval-node")
  await app.close()
})
