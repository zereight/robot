import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, launch, resizeWindow, shot, shotsDir } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
const settings = (args: unknown) => `TOOL settings ${JSON.stringify(args)}`
/** The tool card of the newest reply. */
const lastCard = (page: Page) =>
  page.locator("[data-testid=message][data-author=agent]").last().getByTestId("tool-card")

test("changes from the chat: model by a loose name with Undo, refusals, instruction history", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  // A second account with one Claude Sonnet model and two Haiku models.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("anthropic")
  await page.getByTestId("provider-base-url").fill(mock.anthropicUrl)
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText(["Connected", "Connected"])
  await page.getByTestId("settings-close").click()

  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill("Ada")
  await page.getByTestId("agent-instructions").fill("Be brief.")
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: "Ada" }).waitFor()
  const report: string[] = ["# S40 changes from the chat", ""]

  // "Which model are you?" reads the settings and changes nothing.
  await send(page, settings({}))
  await settled(page)
  await expect(lastCard(page)).toContainText("- model: mock-fast")
  await expect(page.getByTestId("settings-line")).toHaveCount(0)
  report.push(
    "1. A call with no change read the settings: the card shows model mock-fast. No line.",
  )

  // The permission level is not for the agent to change. The agent reads where the user goes.
  await send(page, settings({ permission: "full" }))
  await settled(page)
  await expect(lastCard(page)).toContainText(
    "The permission level: the user changes it in the profile of the agent.",
  )
  await expect(page.getByTestId("settings-line")).toHaveCount(0)
  report.push("2. permission: full was refused. The agent read: the profile of the agent.")

  // Two Haiku models match: nothing changes, and the agent gets the list.
  await send(page, settings({ model: "haiku" }))
  await settled(page)
  await expect(lastCard(page)).toContainText("More than one model matches")
  await expect(lastCard(page)).toContainText("claude-haiku-5-5")
  await expect(lastCard(page)).toContainText("claude-3-5-haiku-latest")
  report.push("3. model: haiku matched two models. Nothing changed. The agent got the list.")

  // The instructions from the chat: a line, and one more version in the history.
  await send(page, settings({ instructions: "Answer in Korean." }))
  await settled(page)
  const instructionsLine = page.getByTestId("settings-line").last()
  await expect(instructionsLine).toContainText("Changed the instructions")
  await expect(instructionsLine.getByTestId("settings-undo")).toBeEnabled()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("instruction-history").locator("summary").click()
  const versions = page.getByTestId("instruction-version")
  await expect(versions).toHaveCount(2)
  await expect(versions.nth(0)).toHaveAttribute("data-source", "chat")
  await expect(versions.nth(1)).toHaveAttribute("data-source", "profile")
  await shot(page, "s40-01-instruction-history")
  report.push("4. Instructions from the chat: the line shows with Undo. History: Chat, Profile.")

  // Restore the older version: the text is back, and a version from a restore is on top.
  await versions.nth(1).getByTestId("instruction-version-open").click()
  await expect(versions.nth(1).getByTestId("instruction-version-text")).toHaveText("Be brief.")
  await versions.nth(1).getByTestId("instruction-version-restore").click()
  await expect(versions).toHaveCount(3)
  await expect(versions.nth(0)).toHaveAttribute("data-source", "restore")
  await expect(page.getByTestId("agent-instructions")).toHaveValue("Be brief.")
  report.push(
    "5. Restore of the older version: instructions are Be brief. History: Restore, Chat, Profile.",
  )
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await expect(versions).toHaveCount(0)
  // The instructions changed again since the line: Undo is off, with the reason.
  await expect(instructionsLine.getByTestId("settings-undo")).toBeDisabled()
  await expect(instructionsLine.getByTestId("settings-changed-again")).toHaveText(
    "Changed again since",
  )
  report.push("6. The instructions line: Undo is off, with Changed again since.")

  // "Switch to Sonnet": the model changes, the line has Undo, and the next turn uses it.
  await send(page, settings({ model: "Sonnet" }))
  await settled(page)
  const modelLine = page.getByTestId("settings-line").last()
  await expect(modelLine).toContainText("Changed the model: mock-fast → claude-sonnet-4-5")
  await expect(modelLine.getByTestId("settings-undo")).toBeEnabled()
  await shot(page, "s40-02-model-line")
  await send(page, "hello")
  await settled(page)
  const lastBody = (path: string) =>
    mock.requests.filter((r) => r.path === path).at(-1)?.body as { model?: string } | undefined
  expect(lastBody("/anthropic/v1/messages")?.model).toBe("claude-sonnet-4-5")
  report.push("7. model: Sonnet changed the model to claude-sonnet-4-5. The next turn went to it.")

  // Undo: the old model is back, and the next turn uses it.
  await modelLine.getByTestId("settings-undo").click()
  await expect(modelLine.getByTestId("settings-undone")).toHaveText("Undone")
  const before = mock.requests.filter((r) => r.path === "/v1/chat/completions").length
  await send(page, "hello again")
  await settled(page)
  expect(mock.requests.filter((r) => r.path === "/v1/chat/completions").length).toBeGreaterThan(
    before,
  )
  expect(lastBody("/v1/chat/completions")?.model).toBe("mock-fast")
  report.push("8. Undo put back mock-fast. The next turn went to it.")

  // An app setting changes at once.
  await send(page, settings({ theme: "light" }))
  await settled(page)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect(page.getByTestId("settings-line").last()).toContainText(
    "Changed the theme: Follow the system → Light",
  )
  await shot(page, "s40-03-theme-line")
  report.push(
    "9. theme: light applied at once. Line: Changed the theme: Follow the system → Light.",
  )

  // The action log has an entry for each change.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await expect(page.getByTestId("action-log-entry")).toHaveCount(3)
  report.push("10. The action log has 3 entries (instructions, model, theme):")
  for (const text of await page.getByTestId("action-log-entry").allInnerTexts())
    report.push(`   - ${text.replace(/\n/g, " | ")}`)

  const reports = resolve(shotsDir, "..", "reports")
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, "s40-changes-from-chat.md"), `${report.join("\n")}\n`)
  await app.close()
  await mock.close()
})
