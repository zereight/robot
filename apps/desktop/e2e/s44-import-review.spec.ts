import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const placeRows = (page: Page) => page.getByTestId("section-agents").locator("[data-place-row]")
const LOOKALIKE = "sk-looks-like-a-key-0123456789abcdef"
const daily = { kind: "daily", times: ["08:30"] }

test("review before an import: agent file and workflow file, ticks, not imported, checklist", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s44-"))
  const agentFile = join(work, "team.json")
  const badFile = join(work, "bad.json")
  const workflowFile = join(work, "flows.json")
  // Two agents and three routines. Bob's instructions hold a key; Ada has a field that this
  // version does not know.
  writeFileSync(
    agentFile,
    JSON.stringify({
      format: "robot-agents",
      version: 1,
      agents: [
        {
          name: "Ada",
          role: "Researcher",
          instructions: "Find sources.",
          model: { accountId: "other", model: "big" },
          routines: [
            { name: "Morning digest", prompt: "Summarise the news.", schedule: daily },
            { name: "Evening note", prompt: "Write a short note.", schedule: daily },
          ],
        },
        {
          name: "Bob",
          instructions: `Use ${LOOKALIKE} for the API.`,
          routines: [{ name: "Weekly check", prompt: "Check.", schedule: daily }],
        },
      ],
    }),
  )
  writeFileSync(
    badFile,
    JSON.stringify({ format: "robot-agents", version: 1, agents: [{ name: "A" }, { name: "a" }] }),
  )
  writeFileSync(
    workflowFile,
    JSON.stringify({
      format: "robot-workflows",
      version: 1,
      workflows: [
        {
          name: "Share a draft",
          trigger: { kind: "schedule", schedule: daily },
          steps: [
            { kind: "agent", name: "Draft", agent: "Zed", prompt: "Write", x: 0, y: 0 },
            { kind: "notify", name: "Share", title: "{{input}}", x: 260, y: 0 },
          ],
          connections: [{ from: 1, to: 2 }],
        },
      ],
    }),
  )

  let { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_AGENT_FILE_OPEN: badFile,
  })
  await resizeWindow(app, 1400, 950)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)

  // A file that the format refuses is refused before the review screen.
  await page.getByTestId("agents-menu").click()
  await page.getByTestId("agents-menu-import-file").click()
  await expect(page.getByTestId("agent-file-problem-text")).toContainText("Two agents")
  await expect(page.getByTestId("agent-import-dialog")).toHaveCount(0)
  await page.getByTestId("agent-file-problem").getByRole("button").click()
  await app.close()

  const userData = freshUserData()
  ;({ app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_AGENT_FILE_OPEN: agentFile,
    ROBOT_TEST_WORKFLOW_FILE_OPEN: workflowFile,
  }))
  await resizeWindow(app, 1400, 950)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)

  await page.getByTestId("agents-menu").click()
  await page.getByTestId("agents-menu-import-file").click()
  const dialog = page.getByTestId("agent-import-dialog")
  const items = dialog.getByTestId("agent-import-item")
  await expect(items).toHaveCount(2)
  // Ticks at the start: agents and instructions ticked, routines not.
  await expect(dialog.getByTestId("agent-import-tick")).toHaveCount(2)
  for (const tick of await dialog.getByTestId("agent-import-tick").all())
    await expect(tick).toBeChecked()
  await expect(dialog.getByTestId("agent-import-routine")).toHaveCount(3)
  for (const tick of await dialog.getByTestId("agent-import-routine-tick").all())
    await expect(tick).not.toBeChecked()
  await expect(items.nth(0).getByTestId("agent-import-instructions-tick")).toBeChecked()
  // The instructions that held a key are not ticked, with the mark.
  await expect(items.nth(1).getByTestId("agent-import-instructions-tick")).not.toBeChecked()
  await expect(items.nth(1).getByTestId("agent-import-instructions")).toContainText(
    "A secret was removed",
  )
  // "Not imported" names the field that this version does not know.
  await expect(dialog.getByTestId("agent-import-not-imported")).toContainText("Ada: model")
  await expect(dialog.getByTestId("agent-import-not-imported")).toContainText(
    "This version of ROBot does not know this field.",
  )
  await expect(dialog.getByTestId("agent-import-counts")).toHaveText(
    "ROBot will make 2 agents, 0 routines (paused).",
  )
  await dialog.getByTestId("model-model").selectOption("o3-mini")
  await shot(page, "s44-01-agent-review")

  // Nothing ticked: the import button is off.
  for (const tick of await dialog.getByTestId("agent-import-tick").all()) await tick.uncheck()
  await expect(dialog.getByTestId("agent-import-counts")).toHaveText("Nothing is ticked.")
  await expect(dialog.getByTestId("agent-import-submit")).toBeDisabled()

  // Tick Ada and one routine, and leave Bob not ticked.
  await items.nth(0).getByTestId("agent-import-tick").check()
  await items.nth(0).getByTestId("agent-import-routine-tick").nth(1).check()
  await expect(dialog.getByTestId("agent-import-counts")).toHaveText(
    "ROBot will make 1 agents, 1 routines (paused).",
  )
  await expect(dialog.getByTestId("agent-import-submit")).toHaveText("Import 1 agents")
  await shot(page, "s44-02-agent-ticks")
  await dialog.getByTestId("agent-import-submit").click()
  await expect(dialog).toHaveCount(0)

  // One agent is made, with one paused routine.
  // The row shows the role line of the file as a badge after the name (spec 001).
  await expect(placeRows(page)).toHaveCount(1)
  await expect(placeRows(page).first()).toHaveAttribute("data-place-name", "Ada")
  await expect(placeRows(page).first().getByTestId("role-badge")).toHaveText("Researcher")
  await placeRows(page).first().click()
  const checklist = page.getByTestId("chat-checklist")
  await expect(checklist).toBeVisible()
  await expect(checklist.getByTestId("checklist-sender")).toHaveText("ROBot")
  await expect(checklist.getByTestId("checklist-item")).toHaveCount(1)
  await expect(checklist.getByTestId("checklist-item")).toContainText("Evening note")
  await expect(checklist.getByTestId("checklist-item")).toHaveAttribute("data-done", "false")
  await expect(checklist.getByTestId("checklist-action")).toHaveText("Turn on")
  await shot(page, "s44-03-chat-checklist")

  // "Turn on" opens the routine; turning it on ticks the item.
  await checklist.getByTestId("checklist-action").click()
  const card = page.getByTestId("routine-card")
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("Evening note")
  await expect(card).toHaveAttribute("data-enabled", "false")
  await expect(card.getByTestId("routine-enabled")).toBeFocused()
  await shot(page, "s44-04-routine-revealed")
  await card.getByTestId("routine-enabled").click()
  await expect(card).toHaveAttribute("data-enabled", "true")
  await page.getByTestId("page-chats").click()
  await expect(checklist.getByTestId("checklist-item")).toHaveAttribute("data-done", "true")
  await expect(checklist.getByTestId("checklist-progress")).toHaveText("1 of 1 done")
  await shot(page, "s44-05-checklist-done")

  // Workflow file with an agent that the app cannot find: the list names the agent.
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-import-file").click()
  const wfDialog = page.getByTestId("workflow-import-dialog")
  await expect(wfDialog.getByTestId("workflow-import-item")).toHaveCount(1)
  await expect(wfDialog.getByTestId("workflow-import-tick")).toBeChecked()
  await expect(wfDialog.getByTestId("workflow-import-missing")).toHaveText("Agents not found: Zed")
  await expect(wfDialog.getByTestId("workflow-import-counts")).toHaveText(
    "ROBot will make 1 workflows (off).",
  )
  await wfDialog.getByTestId("workflow-import-tick").uncheck()
  await expect(wfDialog.getByTestId("workflow-import-submit")).toBeDisabled()
  await wfDialog.getByTestId("workflow-import-tick").check()
  await shot(page, "s44-06-workflow-review")
  await wfDialog.getByTestId("workflow-import-submit").click()
  await expect(wfDialog).toHaveCount(0)

  // The canvas of the new workflow shows the checklist with "Pick".
  await page.getByTestId("wf-open").click()
  const wfChecklist = page.getByTestId("wf-checklist")
  await expect(wfChecklist.getByTestId("checklist-item")).toHaveCount(2)
  await expect(wfChecklist.getByTestId("checklist-item").nth(0)).toContainText(
    "Pick an agent for step 1 “Draft”.",
  )
  await expect(wfChecklist.getByTestId("checklist-action").nth(0)).toHaveText("Pick")
  await shot(page, "s44-07-canvas-checklist")

  // "Pick" opens the step; picking an agent ticks the item.
  await wfChecklist.getByTestId("checklist-action").nth(0).click()
  await expect(page.getByTestId("wf-step-agent")).toBeFocused()
  await page.getByTestId("wf-step-agent").selectOption({ label: "Ada" })
  await expect(wfChecklist.getByTestId("checklist-item").nth(0)).toHaveAttribute(
    "data-done",
    "true",
  )
  await page.getByTestId("wf-save").click()
  // The import of S67 shows a toast of its own, and it can still be on screen: look for the toast
  // of the save by its text.
  await expect(page.getByTestId("toast-success").filter({ hasText: "Workflow saved." })).toHaveText(
    "Workflow saved.",
  )

  // "Turn on" opens the list at the workflow; turning it on ticks the last item.
  await wfChecklist.getByTestId("checklist-item").nth(1).getByTestId("checklist-action").click()
  const wfCard = page.getByTestId("wf-card")
  await expect(wfCard.getByTestId("wf-enabled")).toBeFocused()
  await wfCard.getByTestId("wf-enabled").click()
  await expect(wfCard).toHaveAttribute("data-enabled", "true")
  await page.getByTestId("wf-open").click()
  await expect(wfChecklist.getByTestId("checklist-item").nth(1)).toHaveAttribute(
    "data-done",
    "true",
  )
  await expect(wfChecklist.getByTestId("checklist-progress")).toHaveText("2 of 2 done")
  await shot(page, "s44-08-canvas-progress")
  await app.close()
  await mock.close()
})

test("an agent made by hand shows no checklist", async () => {
  test.setTimeout(60_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Cleo")
  await expect(page.getByTestId("chat-start")).toBeVisible()
  await expect(page.getByTestId("chat-checklist")).toHaveCount(0)
  await app.close()
  await mock.close()
})
