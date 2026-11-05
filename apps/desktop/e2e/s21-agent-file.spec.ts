import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const placeRows = (page: Page) => page.getByTestId("section-agents").locator("[data-place-row]")

test("agent file: export two agents, import the file in an empty app", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s21-"))
  const agentFile = join(work, "team.json")
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }

  // App one: two agents, a routine for the first, and the export.
  let { app, page } = await launch(freshUserData(), {
    ...env,
    ROBOT_TEST_AGENT_FILE_SAVE: agentFile,
  })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgent(page, "Bob")
  await page.getByTestId("page-routines").click()
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Morning check")
  await page.getByTestId("routine-agent").selectOption({ label: "Ada" })
  await page.getByTestId("routine-prompt").fill("Say good morning")
  await page.getByTestId("routine-kind").selectOption("daily")
  await page.getByTestId("routine-times").fill("09:00")
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-card")).toHaveAttribute("data-enabled", "true")
  await page.getByTestId("page-chats").click()

  // The menu of the Agents header closes on Escape and gives the focus back.
  await page.getByTestId("agents-menu").click()
  await expect(page.getByTestId("agents-menu-export")).toBeFocused()
  await shot(page, "s21-01-menu")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agents-menu-export")).toHaveCount(0)
  await expect(page.getByTestId("agents-menu")).toBeFocused()

  await page.getByTestId("agents-menu").click()
  await page.getByTestId("agents-menu-export").click()
  await expect(page.getByTestId("agent-export-item")).toHaveCount(2)
  await shot(page, "s21-02-export")
  await page.getByTestId("agent-export-submit").click()
  await expect(page.getByTestId("agent-export-saved")).toContainText(agentFile)
  await page.getByTestId("agent-export-close").click()
  await expect(page.getByTestId("agent-export-dialog")).toHaveCount(0)
  await app.close()

  // The file holds the five fields of each agent and nothing else.
  const text = readFileSync(agentFile, "utf8")
  const written = JSON.parse(text) as {
    format: string
    version: number
    agents: Record<string, unknown>[]
  }
  // The format is version 2 since S67 (docs/agent-file-format.md; spec 002, "Agent file"). With
  // no tick box ticked the file holds the same fields as version 1.
  expect(written).toMatchObject({ format: "robot-agents", version: 2 })
  expect(written.agents.map((a) => a.name)).toEqual(["Ada", "Bob"])
  for (const agent of written.agents)
    expect(Object.keys(agent).sort()).toEqual(["face", "instructions", "name", "role", "routines"])
  expect(written.agents[0]?.routines).toEqual([
    {
      name: "Morning check",
      prompt: "Say good morning",
      schedule: { kind: "daily", times: ["09:00"] },
    },
  ])
  for (const absent of ["mock-fast", "o3-mini", GOOD_KEY, "workspace", "permission"])
    expect(text).not.toContain(absent)

    // App two has an account and no agent. The import asks for one model for both agents.
  ;({ app, page } = await launch(freshUserData(), {
    ...env,
    ROBOT_TEST_AGENT_FILE_OPEN: agentFile,
  }))
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await expect(placeRows(page)).toHaveCount(0)
  await page.getByTestId("agents-menu").click()
  await page.getByTestId("agents-menu-import-file").click()
  const dialog = page.getByTestId("agent-import-dialog")
  await expect(dialog.getByTestId("agent-import-item")).toHaveCount(2)
  // The routine is listed under its agent, not ticked, and starts paused when ticked.
  await expect(dialog.getByTestId("agent-import-routine")).toHaveCount(1)
  await expect(dialog.getByTestId("agent-import-routine")).toContainText("Starts paused")
  await expect(dialog.getByTestId("agent-import-routine-tick")).not.toBeChecked()
  await dialog.getByTestId("agent-import-routine-tick").check()
  await expect(dialog.getByTestId("agent-import-counts")).toHaveText(
    "ROBot will make 2 agents, 1 routines (paused).",
  )
  await dialog.getByTestId("model-model").selectOption("o3-mini")
  // The effort starts at "Default" in an import, though the model offers "Medium" (spec 002).
  await expect(dialog.getByTestId("model-effort")).toHaveValue("")
  await shot(page, "s21-03-import")
  await dialog.getByTestId("agent-import-submit").click()
  await expect(dialog).toHaveCount(0)

  // Two agents exist, with the model that the user picked in the dialog.
  await expect(placeRows(page)).toHaveText(["Ada", "Bob"])
  for (const name of ["Ada", "Bob"]) {
    await placeRows(page)
      .filter({ hasText: new RegExp(`^${name}$`) })
      .click()
    await expect(page.getByTestId("chat-start").locator("h2")).toHaveText(name)
    await expect(page.getByTestId("chat-header-model")).toHaveText("o3-mini")
  }
  // The routine is there, and it is paused.
  await page.getByTestId("page-routines").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(1)
  await expect(page.getByTestId("routine-card")).toContainText("Morning check")
  await expect(page.getByTestId("routine-card")).toHaveAttribute("data-enabled", "false")
  await expect(page.getByTestId("routine-next")).toHaveCount(0)
  await shot(page, "s21-04-paused-routine")
  await page.getByTestId("page-chats").click()

  // A second import makes new agents only: the taken names get a number.
  await page.getByTestId("agents-menu").click()
  await page.getByTestId("agents-menu-import-file").click()
  await expect(dialog.getByTestId("agent-import-item")).toHaveCount(2)
  await expect(dialog.getByTestId("agent-import-item").first()).toContainText("Ada 2")
  await expect(dialog.getByTestId("agent-import-item").first()).toContainText(
    "Name in the file: Ada",
  )
  await shot(page, "s21-05-numbered")
  await dialog.getByTestId("agent-import-submit").click()
  await expect(dialog).toHaveCount(0)
  await expect(placeRows(page)).toHaveText(["Ada", "Ada 2", "Bob", "Bob 2"])
  await app.close()
  await mock.close()
})
