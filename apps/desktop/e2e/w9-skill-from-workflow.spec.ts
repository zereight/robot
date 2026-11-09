import { expect, type Page, test } from "@playwright/test"
import { buildFlow, launch, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 017: "Make a skill" from a workflow, the diet of the draft, and the skill check.

const env = { ROBOT_TEST_OPENAI_URL: "", ROBOT_TEST_OPENAI_KEY: "", ROBOT_SYSTEM_LOCALE: "en-US" }

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

test("a workflow with no node cannot make a skill", async () => {
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Empty")
  await page.getByTestId("workflow-make-skill").click()
  await expect(page.getByTestId("toast-error").last()).toHaveText("This workflow has no node.")
  await expect(page.getByTestId("skill-draft-dialog")).toHaveCount(0)
  await app.close()
})

test("make a skill: draft with a diet, save, check, try it, and check from the list", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Weekly")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Collect", prompt: "Collect the news.\n\nCollect the news." },
      { name: "Write", prompt: "Write a summary of {{input}}  for the team." },
      { name: "Gate", kind: "approval", question: "Send it?" },
    ],
    edges: [
      [0, 1],
      [1, 2],
    ],
  })
  await page.getByTestId("workflow-make-skill").click()
  const dialog = page.getByTestId("skill-draft-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("skill-name")).toHaveValue("Weekly")
  await expect(dialog.getByTestId("skill-instructions")).toHaveValue(
    "1. Collect the news.\n2. Write a summary of for the team.\n3. Ask the user: Send it?\nIf the user rejects it, stop.",
  )
  await expect(dialog.getByTestId("skill-description")).toHaveValue(
    "Do the steps of the workflow Weekly: Collect, Write, Gate.",
  )
  await expect(dialog.getByTestId("skill-diet")).toContainText("Diet")
  await shot(page, "w9-01-draft")
  await dialog.getByTestId("skill-save").click()
  const facts = page.getByTestId("skill-check-fact")
  await expect(facts).toHaveCount(7)
  for (const status of await facts.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-status")),
  ))
    expect(status).toBe("ok")
  await shot(page, "w9-02-check")
  await page.getByTestId("skill-try").click()
  await expect(page.getByTestId("skill-draft-dialog")).toHaveCount(0)
  await expect(page.getByTestId("skill-chip")).toContainText("Weekly")
  await expect(page.getByTestId("chat-input")).toHaveValue("")

  await page.getByTestId("workflow-make-skill").click()
  await expect(page.getByTestId("skill-draft-dialog").getByTestId("skill-name")).toHaveValue(
    "Weekly 2",
  )
  await page.getByTestId("skill-discard").click()
  await expect(page.getByTestId("skill-draft-dialog")).toHaveCount(0)

  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-skills").click()
  await expect(page.getByTestId("skill-row")).toHaveCount(1)
  await page.getByTestId("skill-check-open").click()
  await expect(page.getByTestId("skill-check-dialog").getByTestId("skill-check-fact")).toHaveCount(
    7,
  )
  await shot(page, "w9-03-row-check")
  await app.close()
  await mock.close()
})
