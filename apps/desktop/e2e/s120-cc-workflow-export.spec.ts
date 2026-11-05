import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

test("export for CC Workflow Studio: the file, the list of what it does not hold, and the import back", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s120-"))
  const source = join(work, "robot.json")
  const target = join(work, "digest.json")
  // A workflow with every kind of step, a note and a schedule.
  writeFileSync(
    source,
    JSON.stringify({
      format: "robot-workflows",
      version: 1,
      workflows: [
        {
          name: "Morning Digest",
          trigger: { kind: "schedule", schedule: { kind: "daily", times: ["08:30"] } },
          steps: [
            {
              kind: "agent",
              name: "Draft",
              agent: "Ada",
              prompt: "Write the digest.",
              effort: "low",
              x: 0,
              y: 0,
            },
            { kind: "condition", name: "Haiku?", mode: "contains", text: "haiku", x: 260, y: 0 },
            { kind: "approval", name: "Gate", message: "Send it?", x: 520, y: 0 },
            { kind: "post", name: "Share", text: "{{input}}", x: 520, y: 110 },
            { kind: "notify", name: "Tell", title: "Done", x: 780, y: 0 },
          ],
          connections: [
            { from: 1, to: 2 },
            { from: 2, to: 3, branch: "yes" },
            { from: 2, to: 4, branch: "no" },
            { from: 3, to: 5 },
          ],
          notes: [{ text: "Check the tone", tone: "blue", x: 0, y: 220 }],
        },
      ],
    }),
  )

  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_WORKFLOW_FILE_OPEN: source,
    ROBOT_TEST_WORKFLOW_FILE_SAVE: target,
  })
  await resizeWindow(app, 1400, 950)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Import the source file to have a workflow to export.
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-tabs").getByText("Workflows", { exact: true }).click()
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-import-file").click()
  const importDialog = page.getByTestId("workflow-import-dialog")
  await importDialog.getByTestId("workflow-import-submit").click()
  await expect(importDialog).toHaveCount(0)
  await expect(page.getByTestId("wf-card")).toHaveCount(1)

  // Export it for CC Workflow Studio.
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-export-cc").click()
  const dialog = page.getByTestId("workflow-export-cc-dialog")
  await expect(dialog.getByTestId("workflow-export-cc-item")).toHaveCount(1)
  await expect(dialog.getByTestId("workflow-export-cc-item")).toBeChecked()
  await dialog.getByTestId("workflow-export-cc-submit").click()
  await expect(dialog.getByTestId("workflow-export-cc-saved")).toContainText(target)

  // The list names what the file does not hold: two steps, the schedule, a note and an agent.
  const rows = dialog.getByTestId("not-exported-item")
  await expect(rows).toHaveCount(5)
  await expect(rows.nth(0)).toContainText("Step 4 “Share”")
  await expect(rows.nth(1)).toContainText("Step 5 “Tell”")
  await expect(rows.nth(2)).toContainText("Trigger: Schedule")
  await expect(rows.nth(3)).toContainText("1 notes")
  await expect(rows.nth(4)).toContainText("1 steps")
  await shot(page, "s120-01-exported")
  await dialog.getByTestId("workflow-export-cc-close").click()
  await expect(dialog).toHaveCount(0)

  const file = JSON.parse(readFileSync(target, "utf8")) as {
    name: string
    nodes: { id: string; type: string }[]
    connections: { from: string; fromPort: string; to: string }[]
  }
  expect(file.name).toBe("morning-digest")
  expect(file.nodes.map((n) => [n.id, n.type])).toEqual([
    ["start", "start"],
    ["step-1", "subAgent"],
    ["step-2", "ifElse"],
    ["step-3", "askUserQuestion"],
    ["end", "end"],
  ])
  expect(file.connections.map((c) => `${c.from}:${c.fromPort}>${c.to}`).sort()).toEqual([
    "start:output>step-1",
    "step-1:output>step-2",
    "step-2:branch-0>step-3",
    "step-2:branch-1>end",
    "step-3:branch-0>end",
  ])
  await app.close()
  await mock.close()
})
