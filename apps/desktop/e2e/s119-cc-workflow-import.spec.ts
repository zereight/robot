import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const node = (id: string, type: string, data: Record<string, unknown>, name = id, x = 40) => ({
  id,
  type,
  name,
  position: { x, y: 60 },
  data,
})
const link = (from: string, to: string, fromPort: string) => ({
  id: `${from}-${to}`,
  from,
  to,
  fromPort,
  toPort: "input",
})
const workflow = (nodes: unknown[], connections: unknown[]) => ({
  id: "w1",
  name: "daily-flow",
  version: "1.0.0",
  nodes,
  connections,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
})

const openImport = async (page: Page) => {
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-tabs").getByText("Workflows", { exact: true }).click()
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-import-file").click()
}

test("a file of CC Workflow Studio: review, lost connection, note, checklist, agent for the steps", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s119-"))
  const file = join(work, "workflow.json")
  const ccOut = join(work, "out.json")
  // First prompt, a question node, second prompt. ROBot has no step for the question node, so the
  // second prompt loses its input. The file is in the wrapped form.
  writeFileSync(
    file,
    JSON.stringify({
      meta: { exportedAt: "2026-01-01T00:00:00.000Z" },
      workflow: workflow(
        [
          node("start", "start", { label: "Start" }),
          node("a", "prompt", { label: "First", prompt: "Collect the news." }),
          node(
            "q",
            "askUserQuestion",
            { questionText: "Which way?", options: [{ label: "Left" }, { label: "Right" }] },
            "which-way",
            300,
          ),
          node(
            "b",
            "subAgent",
            {
              description: "Second",
              agentDefinition: "You write short reports.",
              prompt: "Write the report.",
              model: "sonnet",
            },
            "b",
            560,
          ),
          node("end", "end", { label: "End" }),
        ],
        [
          link("start", "a", "output"),
          link("a", "q", "output"),
          link("q", "b", "branch-0"),
          link("b", "end", "output"),
        ],
      ),
    }),
  )

  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_WORKFLOW_FILE_OPEN: file,
    ROBOT_TEST_WORKFLOW_FILE_SAVE: ccOut,
  })
  await resizeWindow(app, 1400, 950)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Reviewer")

  // The review: one workflow, not ticked because a connection was lost.
  await openImport(page)
  const dialog = page.getByTestId("workflow-import-dialog")
  await expect(dialog.getByTestId("workflow-import-item")).toHaveCount(1)
  await expect(dialog.getByTestId("workflow-import-tick")).not.toBeChecked()
  await expect(dialog.getByTestId("workflow-import-lost")).toHaveText("Connections were lost")
  await expect(dialog.getByTestId("workflow-import-need-agent")).toHaveText(
    "2 agent steps need an agent.",
  )
  await expect(dialog.getByTestId("workflow-import-not-imported")).toContainText(
    "daily-flow: askUserQuestion “which-way”",
  )
  await expect(dialog.getByTestId("workflow-import-not-imported")).toContainText(
    "daily-flow: subAgent.model",
  )
  await expect(dialog.getByTestId("workflow-import-submit")).toBeDisabled()
  await shot(page, "s119-01-review")

  // Tick it and import with no agent: the canvas has the note and the checklist.
  await dialog.getByTestId("workflow-import-tick").check()
  await dialog.getByTestId("workflow-import-submit").click()
  await expect(dialog).toHaveCount(0)
  await page.getByTestId("wf-open").click()
  const note = page.getByTestId("wf-note")
  await expect(note).toHaveCount(1)
  await expect(page.getByTestId("wf-node")).toHaveCount(2)
  // The nodes keep the places of the file, so the two steps and the note do not sit on each other.
  const left = async (id: string) =>
    (await page.getByTestId(id).first().boundingBox())?.x ?? Number.NaN
  const [firstBox, secondBox, noteLeft] = [
    await page.getByTestId("wf-node").nth(0).boundingBox(),
    await page.getByTestId("wf-node").nth(1).boundingBox(),
    await left("wf-note"),
  ]
  expect(firstBox?.x).toBeLessThan(noteLeft)
  expect(noteLeft).toBeLessThan(secondBox?.x ?? Number.NaN)
  const checklist = page.getByTestId("wf-checklist")
  await expect(checklist.getByTestId("checklist-item")).toHaveCount(3)
  await expect(checklist.getByTestId("checklist-item").nth(0)).toContainText(
    "Pick an agent for step 1 “First”.",
  )
  await expect(checklist.getByTestId("checklist-item").nth(2)).toContainText(
    "Connect step 2 “Second”. Its input was lost.",
  )
  await expect(checklist.getByTestId("checklist-action").nth(2)).toHaveText("Connect")
  await shot(page, "s119-02-canvas")

  // Export the same workflow. The note has no node in that file.
  await page.getByTestId("wf-back").click()
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-export-cc").click()
  const exportDialog = page.getByTestId("workflow-export-cc-dialog")
  await exportDialog.getByTestId("workflow-export-cc-submit").click()
  await expect(exportDialog.getByTestId("workflow-not-exported")).toContainText(
    "The file holds no notes.",
  )
  await shot(page, "s119-02c-export")
  expect(readFileSync(ccOut, "utf8")).toContain('"type": "subAgent"')
  await exportDialog.getByTestId("workflow-export-cc-close").click()

  // Import the same file again and pick the agent: no item "Pick" shows, "Connect" stays.
  await openImport(page)
  const second = page.getByTestId("workflow-import-dialog")
  await expect(second.getByTestId("workflow-import-item")).toContainText("daily-flow 2")
  await second.getByTestId("workflow-import-agent").selectOption({ label: "Reviewer" })
  await second.getByTestId("workflow-import-tick").check()
  await shot(page, "s119-03-review-agent")
  await second.getByTestId("workflow-import-submit").click()
  await expect(second).toHaveCount(0)
  await page
    .getByTestId("wf-card")
    .filter({ hasText: "daily-flow 2" })
    .getByTestId("wf-open")
    .click()
  const secondChecklist = page.getByTestId("wf-checklist")
  await expect(secondChecklist.getByTestId("checklist-item")).toHaveCount(1)
  await expect(secondChecklist.getByTestId("checklist-item")).toContainText("Connect step 2")
  await app.close()
  await mock.close()
})

test("a file of CC Workflow Studio that breaks a rule of the graph is refused", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s119-"))
  const file = join(work, "loop.json")
  writeFileSync(
    file,
    JSON.stringify(
      workflow(
        [node("a", "prompt", { prompt: "1" }), node("b", "prompt", { prompt: "2" })],
        [link("a", "b", "output"), link("b", "a", "output")],
      ),
    ),
  )
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_WORKFLOW_FILE_OPEN: file,
  })
  await resizeWindow(app, 1200, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await openImport(page)
  await expect(page.getByTestId("workflow-file-problem-text")).toContainText(
    "In the workflow “daily-flow”, connection 2 makes a loop.",
  )
  await expect(page.getByTestId("workflow-import-dialog")).toHaveCount(0)
  await app.close()
  await mock.close()
})
