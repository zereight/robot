import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// S30: permission rules (spec 007), the rules page (013), the action log, and the decision order.
// The model is a stand-in. Every test works in a data folder and a work area of its own.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
const tool = (name: string, args: unknown) => `TOOL ${name} ${JSON.stringify(args)}`
const area = () => mkdtempSync(join(tmpdir(), "robot-e2e-rules-"))

const openPermissions = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await expect(page.getByTestId("rules")).toBeVisible()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("rules")).toBeHidden()
}
const ruleRows = (page: Page) => page.getByTestId("rule-row")
const logRows = (page: Page) => page.getByTestId("action-log-entry")

const setFullAccess = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("agent-permission").getByText("Full access").click()
  await page.getByTestId("full-access-use").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
}

/** Adds a rule in the dialog of the rules page. The labels are the English words of the page. */
const addRule = async (
  page: Page,
  rule: { agent: string; kind: string; text: string; decision: "Allow" | "Deny" },
) => {
  await page.getByTestId("rule-add").click()
  const dialog = page.getByTestId("rule-dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByTestId("rule-form-agent").selectOption({ label: rule.agent })
  await dialog.getByTestId("rule-form-kind").selectOption({ label: rule.kind })
  await dialog.getByTestId("rule-form-text").fill(rule.text)
  await dialog.getByTestId("rule-form-decision").getByText(rule.decision, { exact: true }).click()
  await dialog.getByTestId("rule-form-save").click()
}

const reports = resolve(shotsDir, "..", "reports")
const writeReport = (name: string, lines: string[]) => {
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, `${name}.md`), `${lines.join("\n")}\n`)
}

test("Always allow saves one rule; the same step then runs by it; the log names it; a deleted rule keeps its text", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const work = area()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const report = ["# S30 rule from a card, the decision, the log", ""]

  // (i) At "Ask for risky steps" a command that deletes outside the workspace shows a card.
  const gone = join(work, "gone.txt")
  const command = `rm "${gone}"`
  writeFileSync(gone, "x")
  await send(page, tool("run_command", { command }))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  expect(existsSync(gone)).toBe(true)
  await expect(page.getByTestId("ask-always")).toContainText("Always allow for this agent")
  await page.getByTestId("ask-always").click()
  await settled(page)
  await expect.poll(() => existsSync(gone)).toBe(false)
  report.push("1. The card of a delete command offers Always allow for this agent. It ran.")

  // The rules page shows one Allow rule with the command.
  await openPermissions(page)
  await expect(ruleRows(page)).toHaveCount(1)
  const rule = ruleRows(page).first()
  await expect(rule.getByTestId("rule-tag")).toHaveText("Allow")
  await expect(rule.getByTestId("rule-text")).toHaveText(command)
  await expect(rule.getByTestId("rule-agent")).toContainText("Ada")
  await expect(rule).toContainText("Shell command")
  await shot(page, "s30-01-rule-from-card")
  report.push(`2. The rules page lists one rule: Allow, Ada, Shell command, ${command}`)
  await closeSettings(page)

  // The same command runs with no question, and its card says "Allowed by a rule".
  writeFileSync(gone, "x")
  await send(page, tool("run_command", { command }))
  await settled(page)
  await expect.poll(() => existsSync(gone)).toBe(false)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  const allowed = page.getByTestId("tool-rule-allowed")
  await expect(allowed).toHaveCount(1)
  await expect(allowed).toHaveText("Allowed by a rule")
  await shot(page, "s30-02-allowed-by-a-rule")
  report.push("3. The same command ran with no card. The card says: Allowed by a rule.")

  // A command that the rule does not name still asks: the rule is not wider than the step.
  writeFileSync(gone, "x")
  await send(page, tool("run_command", { command: `rm -f "${gone}"` }))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("ask-always")).toBeVisible()
  await page.getByTestId("ask-deny").click()
  await settled(page)
  expect(existsSync(gone)).toBe(true)
  report.push("4. A command with another text still asks. Deny keeps the file.")

  // The log has an entry for each step. The newest one that the rule decided names the rule.
  await openPermissions(page)
  await expect(logRows(page)).toHaveCount(3)
  const byRule = logRows(page).filter({ has: page.getByTestId("action-log-rule") })
  await expect(byRule).toHaveCount(1)
  await expect(byRule).toContainText("Allow rule")
  await expect(byRule).toContainText("Ran")
  await expect(byRule.getByTestId("action-log-rule")).toContainText(`Rule: ${command}`)
  await shot(page, "s30-03-log-names-the-rule")
  report.push("5. The log has three entries. One names the rule and says: Allow rule, Ran.")

  // A row that a rule decided opens the rules page on that rule.
  await byRule.getByTestId("action-log-rule-open").click()
  await expect(ruleRows(page).first()).toHaveAttribute("data-focused", "true")
  await shot(page, "s30-04-log-row-opens-the-rule")
  report.push("6. The row opens the rule: the rule row is marked.")

  // Any other row opens the task of its step: the settings close and the Tasks page shows it.
  const byUser = logRows(page).filter({ hasText: "You, on a card" }).last()
  await byUser.getByTestId("action-log-task-open").click()
  await expect(page.getByTestId("tasks-page")).toBeVisible()
  await expect(page.getByTestId("rules")).toBeHidden()
  await expect(page.getByTestId("task-detail-state")).toBeVisible()
  await shot(page, "s30-05-log-row-opens-the-task")
  await page.getByTestId("task-detail").getByText("Close", { exact: true }).click()
  await expect(page.getByTestId("task-detail")).toBeHidden()
  await page.getByTestId("page-chats").click()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  report.push("7. A row that no rule decided opens the task of the step on the Tasks page.")

  // Filters of the log: step kind, agent, and a search of the target.
  await openPermissions(page)
  await page.getByTestId("action-log-kind").selectOption({ label: "Web page" })
  await expect(page.getByTestId("action-log-empty")).toHaveText("No step matches.")
  await page.getByTestId("action-log-kind").selectOption({ label: "Shell command" })
  await expect(logRows(page)).toHaveCount(3)
  await page.getByTestId("action-log-search").fill("rm -f")
  await expect(logRows(page)).toHaveCount(1)
  await expect(logRows(page).first()).toContainText("Refused")
  await page.getByTestId("action-log-search").fill("")
  await page.getByTestId("action-log-agent").selectOption({ label: "Ada" })
  await expect(logRows(page)).toHaveCount(3)
  await page.getByTestId("action-log-result").getByText("Refused").click()
  await expect(logRows(page)).toHaveCount(1)
  report.push("8. The log filters by step kind, agent, result and a search of the target.")
  await page.getByTestId("action-log-result").getByText("All", { exact: true }).click()
  await page.getByTestId("action-log-kind").selectOption({ label: "Any step" })
  await page.getByTestId("action-log-agent").selectOption({ label: "Any agent" })

  // (vi) The rule is deleted. The row of the log keeps its text, marked as deleted.
  await expect(ruleRows(page)).toHaveCount(1)
  await ruleRows(page).first().getByTestId("rule-delete").click()
  await expect(page.getByTestId("rules-empty")).toBeVisible()
  const deleted = logRows(page).filter({ has: page.getByTestId("action-log-rule") })
  await expect(deleted).toHaveCount(1)
  await expect(deleted.getByTestId("action-log-rule")).toHaveAttribute("data-deleted", "true")
  await expect(deleted.getByTestId("action-log-rule")).toContainText(command)
  await expect(deleted.getByTestId("action-log-rule-deleted")).toHaveText("Deleted")
  await expect(deleted.getByTestId("action-log-rule-open")).toHaveCount(0)
  await shot(page, "s30-06-deleted-rule-in-the-log")
  report.push("9. The rule was deleted. Its log row shows the text of the rule and: Deleted.")
  await closeSettings(page)

  // After the delete, the same command asks again.
  writeFileSync(gone, "x")
  await send(page, tool("run_command", { command }))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("ask-deny").click()
  await settled(page)
  expect(existsSync(gone)).toBe(true)
  report.push("10. After the delete, the same command asks again.")

  writeReport("s30-rule-from-a-card", report)
  await app.close()
  await mock.close()
})

test("a Deny rule wins at Full access; Deny and Allow together refuse; the agent goes on", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const work = area()
  const blocked = join(work, "blocked")
  mkdirSync(blocked, { recursive: true })
  const free = join(work, "free")
  mkdirSync(free, { recursive: true })
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const report = ["# S30 Deny rule at Full access", ""]

  // (ii) A Deny rule for a folder, added in the rules page.
  await openPermissions(page)
  await addRule(page, { agent: "Ada", kind: "File", text: blocked, decision: "Deny" })
  await expect(ruleRows(page)).toHaveCount(1)
  await expect(ruleRows(page).first().getByTestId("rule-tag")).toHaveText("Deny")
  await closeSettings(page)
  await setFullAccess(page)

  // A write inside the folder does not run: no card, "Denied by a rule", and the file stays out.
  const target = join(blocked, "a.txt")
  await send(page, tool("write_file", { path: target, content: "x" }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  const state = page.getByTestId("tool-state").last()
  await expect(state).toHaveText("Denied by a rule")
  await expect(state).toHaveAttribute("data-state", "refused")
  expect(existsSync(target)).toBe(false)
  // The agent got a failed step and went on: the answer after the step holds the refusal.
  await expect(page.getByTestId("message").last()).toContainText("Denied by a rule")
  await shot(page, "s30-07-denied-by-a-rule")
  report.push(
    "1. Full access, write in a folder with a Deny rule: no card. The card: Denied by a rule.",
  )
  report.push("   The file is not there. The agent got a failed step and answered.")

  // A write outside the folder runs at Full access: the rule is not wider than its folder.
  const other = join(free, "b.txt")
  await send(page, tool("write_file", { path: other, content: "y" }))
  await settled(page)
  await expect.poll(() => existsSync(other)).toBe(true)
  report.push("2. A write in another folder ran.")

  // A link into the folder does not reach it: the rule compares real paths.
  const link = join(free, "link")
  symlinkSync(blocked, link)
  await send(page, tool("write_file", { path: join(link, "c.txt"), content: "z" }))
  await settled(page)
  expect(existsSync(join(blocked, "c.txt"))).toBe(false)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Denied by a rule")
  report.push("3. A write through a link into the folder was denied too: real paths count.")

  // A Deny rule and an Allow rule both match: the step is refused.
  await openPermissions(page)
  await addRule(page, { agent: "All agents", kind: "File", text: blocked, decision: "Allow" })
  await expect(ruleRows(page)).toHaveCount(2)
  await closeSettings(page)
  await send(page, tool("write_file", { path: join(blocked, "d.txt"), content: "w" }))
  await settled(page)
  expect(existsSync(join(blocked, "d.txt"))).toBe(false)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Denied by a rule")
  report.push("4. A Deny rule and an Allow rule both match: the step is refused.")

  // The log: the filter "Refused" lists the three steps that the Deny rule stopped. A row opens
  // the rule that stopped the step.
  await openPermissions(page)
  await page.getByTestId("action-log-result").getByText("Refused").click()
  await expect(logRows(page)).toHaveCount(3)
  for (const row of await logRows(page).all()) {
    await expect(row).toContainText("Deny rule")
    await expect(row.getByTestId("action-log-rule")).toContainText(blocked)
  }
  await shot(page, "s30-08-refused-in-the-log")
  await logRows(page).first().getByTestId("action-log-rule-open").click()
  const focused = page.locator('[data-testid=rule-row][data-focused="true"]')
  await expect(focused).toHaveCount(1)
  await expect(focused.getByTestId("rule-tag")).toHaveText("Deny")
  report.push(
    "5. The log, filtered by Refused, lists three steps of the Deny rule. A row opens it.",
  )

  writeReport("s30-deny-at-full-access", report)
  await app.close()
  await mock.close()
})

test("a rule that cannot be read asks, also at Full access, and the page lets the user delete it", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await setFullAccess(page)
  const report = ["# S30 a rule that cannot be read", ""]

  // (iii) A bad row, written while the app is closed: a known step and text, an unknown decision.
  await app.close()
  const db = new DatabaseSync(join(userData, "robot.db"))
  const server = db.prepare("SELECT id FROM server WHERE kind = 'local'").get() as { id: string }
  const ada = db.prepare("SELECT id FROM agent WHERE name = 'Ada'").get() as { id: string }
  db.prepare(
    `INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
     VALUES ('bad-rule', ?, ?, 'shell', 'echo unreadable-rule', NULL, 'sideways', 'list', ?)`,
  ).run(server.id, ada.id, Date.now())
  db.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1100, 800)
  await page.locator("[data-place-row]").filter({ hasText: "Ada" }).first().click()

  // At Full access the command meets the rule, and it asks.
  await send(page, tool("run_command", { command: "echo unreadable-rule" }))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("ask-unreadable")).toContainText(
    "A rule cannot be read, so this step asks you.",
  )
  await expect(page.getByTestId("ask-allow")).toBeVisible()
  await expect(page.getByTestId("ask-deny")).toBeVisible()
  await expect(page.getByTestId("ask-always")).toHaveCount(0)
  await shot(page, "s30-09-unreadable-card")
  await page.getByTestId("ask-allow").click()
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Done")
  report.push("1. Full access, a command that meets a rule that cannot be read: a card asks.")
  report.push("   The card has Allow once and Deny only, and says why.")

  // A command that the rule does not name runs with no question at Full access.
  await send(page, tool("run_command", { command: "echo another-command" }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)

  // The page marks the rule and offers Delete only. The log names "a rule that cannot be read".
  await openPermissions(page)
  await expect(ruleRows(page)).toHaveCount(1)
  const bad = ruleRows(page).first()
  await expect(bad.getByTestId("rule-unreadable")).toHaveText("Cannot be read")
  await expect(bad.getByTestId("rule-unreadable-hint")).toBeVisible()
  await expect(bad.getByTestId("rule-edit")).toHaveCount(0)
  await expect(bad.getByTestId("rule-delete")).toBeVisible()
  await expect(bad.getByTestId("rule-tag")).toHaveCount(0)
  await shot(page, "s30-10-unreadable-rule")
  const entry = logRows(page).filter({ hasText: "echo unreadable-rule" })
  await expect(entry).toContainText("A rule that cannot be read, then you")
  report.push(
    "2. The rules page: Cannot be read, with Delete only. The log names the rule and the user.",
  )

  // Delete it. The same command then runs with no question.
  await bad.getByTestId("rule-delete").click()
  await expect(page.getByTestId("rules-empty")).toBeVisible()
  await closeSettings(page)
  await send(page, tool("run_command", { command: "echo unreadable-rule" }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  report.push("3. After Delete, the same command runs at Full access with no card.")

  writeReport("s30-unreadable-rule", report)
  await app.close()
  await mock.close()
})

test("the rules page: add, edit, delete, filter, duplicate; deleting an agent deletes its rules", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgent(page, "Bo")
  const report = ["# S30 the rules page", ""]

  await openPermissions(page)
  await expect(page.getByTestId("rules-empty")).toHaveText("No rules yet.")
  await shot(page, "s30-11-rules-empty")

  // (iv) Add three rules. The list is newest first.
  await addRule(page, {
    agent: "Ada",
    kind: "Shell command",
    text: "git status",
    decision: "Allow",
  })
  await expect(ruleRows(page)).toHaveCount(1)
  await addRule(page, { agent: "Bo", kind: "Web page", text: "example.com", decision: "Deny" })
  await expect(ruleRows(page)).toHaveCount(2)
  await addRule(page, {
    agent: "All agents",
    kind: "File",
    text: "/tmp/robot-shared",
    decision: "Allow",
  })
  await expect(ruleRows(page)).toHaveCount(3)
  await expect(ruleRows(page).nth(0).getByTestId("rule-text")).toHaveText("/tmp/robot-shared")
  await expect(ruleRows(page).nth(0).getByTestId("rule-agent")).toHaveText("All agents")
  await expect(ruleRows(page).nth(1).getByTestId("rule-text")).toHaveText("example.com")
  await expect(ruleRows(page).nth(2).getByTestId("rule-text")).toHaveText("git status")
  await shot(page, "s30-12-three-rules")
  report.push("1. Three rules were added. The list shows the newest first.")

  // Filters: by agent, by "All agents", and by decision.
  await page.getByTestId("rules-agent").selectOption({ label: "Bo" })
  await expect(ruleRows(page)).toHaveCount(1)
  await expect(ruleRows(page).first().getByTestId("rule-text")).toHaveText("example.com")
  await page.getByTestId("rules-agent").selectOption({ label: "All agents" })
  await expect(ruleRows(page)).toHaveCount(1)
  await expect(ruleRows(page).first().getByTestId("rule-text")).toHaveText("/tmp/robot-shared")
  await page.getByTestId("rules-agent").selectOption({ label: "Any agent" })
  await page.getByTestId("rules-decision").getByText("Deny", { exact: true }).click()
  await expect(ruleRows(page)).toHaveCount(1)
  await page.getByTestId("rules-decision").getByText("Allow", { exact: true }).click()
  await expect(ruleRows(page)).toHaveCount(2)
  await page.getByTestId("rules-decision").getByText("All", { exact: true }).click()
  await expect(ruleRows(page)).toHaveCount(3)
  report.push("2. The filters by agent, by All agents and by decision work.")

  // A rule that equals one that exists is refused with a short message.
  await page.getByTestId("rule-add").click()
  const dialog = page.getByTestId("rule-dialog")
  await dialog.getByTestId("rule-form-agent").selectOption({ label: "Ada" })
  await dialog.getByTestId("rule-form-kind").selectOption({ label: "Shell command" })
  await dialog.getByTestId("rule-form-text").fill("git status")
  await dialog.getByTestId("rule-form-save").click()
  await expect(dialog.getByTestId("rule-form-error")).toHaveText("This rule exists already.")
  await shot(page, "s30-13-duplicate-refused")
  // The other decision is not the same rule. A relative path is refused.
  await dialog.getByTestId("rule-form-decision").getByText("Deny", { exact: true }).click()
  await dialog.getByTestId("rule-form-save").click()
  await expect(dialog).toBeHidden()
  await expect(ruleRows(page)).toHaveCount(4)
  await page.getByTestId("rule-add").click()
  await dialog.getByTestId("rule-form-kind").selectOption({ label: "File" })
  await dialog.getByTestId("rule-form-text").fill("relative/path")
  await dialog.getByTestId("rule-form-save").click()
  await expect(dialog.getByTestId("rule-form-error")).toHaveText(
    "Type a full path. It starts with / or ~.",
  )
  await dialog.getByText("Cancel").click()
  await expect(dialog).toBeHidden()
  report.push("3. A duplicate is refused: This rule exists already. A relative path is refused.")

  // Edit a rule: the text changes, the count does not.
  const git = ruleRows(page).filter({ hasText: "git status" }).last()
  await git.getByTestId("rule-edit").click()
  await dialog.getByTestId("rule-form-text").fill("git diff")
  await dialog.getByTestId("rule-form-save").click()
  await expect(dialog).toBeHidden()
  await expect(ruleRows(page)).toHaveCount(4)
  await expect(ruleRows(page).filter({ hasText: "git diff" })).toHaveCount(1)
  report.push("4. A rule was edited in place.")

  // Delete the Deny rule for git, the one that was added by the duplicate test.
  await ruleRows(page).filter({ hasText: "git status" }).first().getByTestId("rule-delete").click()
  await expect(ruleRows(page)).toHaveCount(3)
  report.push("5. A rule was deleted.")

  // (v) Deleting an agent deletes its rules. A rule for all agents stays.
  await closeSettings(page)
  await page.locator("[data-place-row]").filter({ hasText: "Bo" }).first().click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  // The profile has a link that opens the page filtered to the agent.
  await page.getByTestId("agent-rules-link").click()
  await expect(page.getByTestId("rules")).toBeVisible()
  await expect(ruleRows(page)).toHaveCount(1)
  // The agent filter shows the agent of the link, not "Any agent".
  await expect(page.getByTestId("rules-agent").locator("option:checked")).toHaveText("Bo")
  await expect(ruleRows(page).first().getByTestId("rule-text")).toHaveText("example.com")
  await shot(page, "s30-14-rules-of-one-agent")
  report.push("6. The link in the profile of Bo opens the page with Bo's rule only.")
  await closeSettings(page)
  await page.locator("[data-place-row]").filter({ hasText: "Bo" }).first().click()
  await page.getByTestId("chat-header-agent").click()
  await page.getByTestId("agent-archive").click()
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await page.getByTestId("archive-delete").click()
  await page.getByTestId("delete-confirm-button").click()
  await expect(page.getByTestId("archive-section")).toContainText("No archived agents.")
  await page.getByTestId("settings-nav-permissions").click()
  await expect(ruleRows(page)).toHaveCount(2)
  await expect(page.getByTestId("rules-list")).not.toContainText("example.com")
  await expect(page.getByTestId("rules-list")).toContainText("/tmp/robot-shared")
  await expect(page.getByTestId("rules-list")).toContainText("git diff")
  report.push(
    "7. Bo was deleted. Its rule is gone. The rule for All agents and the rule of Ada stay.",
  )

  writeReport("s30-rules-page", report)
  await app.close()
  await mock.close()
})

test("the smallest window and Korean: the rules page, the log, and the cards", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const work = area()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const report = ["# S30 Korean run", ""]

  const gone = join(work, "gone.txt")
  const command = `rm "${gone}"`
  writeFileSync(gone, "x")
  await send(page, tool("run_command", { command }))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await shot(page, "s30-15-ko-card")
  await page.getByTestId("ask-always").click()
  await settled(page)
  writeFileSync(gone, "x")
  await send(page, tool("run_command", { command }))
  await settled(page)
  await expect(page.getByTestId("tool-rule-allowed")).toHaveText("규칙으로 허용됨")
  await shot(page, "s30-16-ko-allowed-by-a-rule")

  await openPermissions(page)
  await expect(page.getByTestId("rules")).toContainText("규칙")
  await expect(ruleRows(page).first().getByTestId("rule-tag")).toHaveText("허용")
  await expect(page.getByTestId("rule-add")).toHaveText("규칙 추가")
  await expect(logRows(page).first().getByTestId("action-log-rule")).toContainText(
    `규칙: ${command}`,
  )
  await expect(logRows(page).first()).toContainText("허용 규칙")
  await shot(page, "s30-17-ko-rules-and-log")
  report.push("1. The page, the tag, the button and the log row show Korean words.")

  // The dialog in Korean.
  await page.getByTestId("rule-add").click()
  await expect(page.getByTestId("rule-dialog")).toContainText("규칙 추가")
  await shot(page, "s30-18-ko-dialog")
  await page.getByTestId("rule-dialog").getByText("취소").click()
  await expect(page.getByTestId("rule-dialog")).toBeHidden()

  // The smallest window that the app allows.
  await resizeWindow(app, 480, 700)
  await expect(page.getByTestId("rules")).toBeVisible()
  await shot(page, "s30-19-ko-smallest-window")
  // The rows of the rules and of the log must stay inside the window: no sideways scroll.
  await page.getByTestId("rule-add").scrollIntoViewIfNeeded()
  await shot(page, "s30-20-ko-smallest-rules")
  await page.getByTestId("action-log-search").scrollIntoViewIfNeeded()
  await shot(page, "s30-21-ko-smallest-log-filters")
  const overflow = await page.getByTestId("action-log-search").evaluate((el) => {
    const box = el.getBoundingClientRect()
    return box.right > window.innerWidth
  })
  expect(overflow).toBe(false)
  report.push("2. The smallest window shows the page.")

  writeReport("s30-korean", report)
  await app.close()
  await mock.close()
})
