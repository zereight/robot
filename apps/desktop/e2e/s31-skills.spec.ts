import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Skills (spec 017, 003, 013, 014): the Skills page with Edit and Duplicate, the list that opens
// with a slash (the command first, then the skills), the chip in the message box, and the copy of
// the instructions that a message keeps.

type Chat = { messages: { role: string; content: string }[] }
type SkillRow = {
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
  agentIds: string[] | null
}

const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })
const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const skillsOf = async (page: Page) =>
  rpc<SkillRow[]>(page, "skills.list", { serverId: await serverOf(page) })
const row = (page: Page, name: string) =>
  page.locator(`[data-testid=skill-row][data-skill='${name}']`)
const openSkills = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-skills").click()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("skills-section")).toHaveCount(0)
}
const fillForm = async (
  page: Page,
  fields: { name?: string; description?: string; instructions?: string },
) => {
  if (fields.name !== undefined) await page.getByTestId("skill-name").fill(fields.name)
  if (fields.description !== undefined)
    await page.getByTestId("skill-description").fill(fields.description)
  if (fields.instructions !== undefined)
    await page.getByTestId("skill-instructions").fill(fields.instructions)
}
/** Opens the instructions of a chip, unless they are open. */
const openChip = async (chip: Locator) => {
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click()
}
const openAgent = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]").filter({ hasText: name }).click()
/** What the model got for the message that holds this text. */
const sentTo = (mock: Awaited<ReturnType<typeof startMockProvider>>, text: string) =>
  mock.requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => (r.body as Chat).messages.at(-1)?.content ?? "")
    .find((c) => c.includes(text)) as string

test("skills: Edit, Duplicate, the list after a slash, the chip and its copy (English)", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  // Under 800 px wide is the narrow layout of spec 001.
  await resizeWindow(app, 760, 760)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgent(page, "Bo")

  // --- Settings, Skills: no skill yet, then the first one ---------------------------------------
  await openSkills(page)
  await expect(page.getByTestId("skills-empty")).toBeVisible()
  await shot(page, "s31-01-empty-en")
  await page.getByTestId("skills-new").click()
  await expect(page.getByRole("heading", { name: "New skill" })).toBeVisible()
  await fillForm(page, {
    name: "/Weekly summary",
    description: "Each Friday",
    instructions: "Write a weekly summary of the work.",
  })
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  await expect(row(page, "Weekly summary")).toBeVisible()
  await page.getByTestId("skills-new").click()
  await fillForm(page, {
    name: "Check a claim",
    instructions: "Find a source for the claim.",
  })
  // "Chosen agents": only Ada may use this skill.
  await page.getByTestId("skill-agents-mode").getByText("Chosen agents").click()
  await page.locator("[data-testid=skill-agent][data-agent=Ada]").check()
  await page.getByTestId("skill-save").click()
  await expect(row(page, "Check a claim").getByTestId("skill-row-agents")).toHaveText("Ada")

  // --- Edit: the form holds the fields; a taken name is refused; Save changes the skill ----------
  await row(page, "Weekly summary").getByTestId("skill-edit").click()
  await expect(page.getByRole("heading", { name: "Edit skill" })).toBeVisible()
  await expect(page.getByTestId("skill-name")).toHaveValue("Weekly summary")
  await expect(page.getByTestId("skill-description")).toHaveValue("Each Friday")
  await expect(page.getByTestId("skill-instructions")).toHaveValue(
    "Write a weekly summary of the work.",
  )
  await expect(page.getByTestId("skill-agents-mode").getByLabel("All agents")).toBeChecked()
  await shot(page, "s31-02-edit-form-en")
  await page.getByTestId("skill-name").fill("check A CLAIM")
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-error-name")).toHaveText("Another skill has this name.")
  await expect(page.getByTestId("skill-form-dialog")).toBeVisible()
  await shot(page, "s31-03-edit-taken-en")
  // The name may stay the same, with another letter case, when no other skill has it.
  await page.getByTestId("skill-name").fill("WEEKLY summary")
  await fillForm(page, { instructions: "Write a weekly summary. Keep it short." })
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  await expect(row(page, "WEEKLY summary")).toBeVisible()
  await expect(row(page, "WEEKLY summary").getByTestId("skill-switch")).toHaveAttribute(
    "aria-checked",
    "true",
  )
  // An empty field is refused, and nothing changes.
  await row(page, "WEEKLY summary").getByTestId("skill-edit").click()
  await fillForm(page, { instructions: "" })
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-error-instructions")).toBeVisible()
  await page.getByTestId("skill-cancel").click()
  expect((await skillsOf(page)).find((s) => s.name === "WEEKLY summary")?.instructions).toBe(
    "Write a weekly summary. Keep it short.",
  )
  // Rename it back for the rest of the test.
  await row(page, "WEEKLY summary").getByTestId("skill-edit").click()
  await fillForm(page, { name: "Weekly summary" })
  await page.getByTestId("skill-save").click()
  await expect(row(page, "Weekly summary")).toBeVisible()

  // --- Duplicate: a copy with "copy" in its name, off; a second copy gets a number ---------------
  await row(page, "Weekly summary").getByTestId("skill-duplicate").click()
  await expect(row(page, "Weekly summary copy")).toBeVisible()
  await expect(page.getByText("Made the copy Weekly summary copy.")).toBeVisible()
  await expect(row(page, "Weekly summary copy").getByTestId("skill-switch")).toHaveAttribute(
    "aria-checked",
    "false",
  )
  await row(page, "Weekly summary").getByTestId("skill-duplicate").click()
  await expect(row(page, "Weekly summary copy 2")).toBeVisible()
  const copies = (await skillsOf(page)).filter((s) => s.name.startsWith("Weekly summary copy"))
  expect(copies.map((s) => s.enabled)).toEqual([false, false])
  expect(copies.map((s) => s.instructions)).toEqual([
    "Write a weekly summary. Keep it short.",
    "Write a weekly summary. Keep it short.",
  ])
  await shot(page, "s31-04-list-en")
  // A copy that is off does not show in the list of a chat. Delete the second copy.
  await row(page, "Weekly summary copy 2").getByTestId("skill-delete").click()
  await row(page, "Weekly summary copy 2").getByTestId("skill-delete-confirm").click()
  await expect(row(page, "Weekly summary copy 2")).toHaveCount(0)
  await closeSettings(page)

  // --- The list after a slash: the command first, then the skills of this agent -------------------
  await openAgent(page, "Ada")
  await page.getByTestId("composer-input").fill("/")
  const options = page.locator("[data-testid=command-option], [data-testid=skill-option]")
  await expect(options).toHaveCount(3)
  await expect(options.nth(0)).toHaveAttribute("data-testid", "command-option")
  await expect(options.nth(0)).toContainText("/compact")
  await expect(options.nth(1)).toHaveAttribute("data-skill", "Check a claim")
  await expect(options.nth(2)).toHaveAttribute("data-skill", "Weekly summary")
  // The copy is off: it is not in the list.
  await expect(
    page.locator("[data-testid=skill-option][data-skill='Weekly summary copy']"),
  ).toHaveCount(0)
  await shot(page, "s31-05-slash-list-en")
  // A path is plain text: no list.
  await page.getByTestId("composer-input").fill("~/notes/todo")
  await expect(page.getByTestId("skill-picker")).toHaveCount(0)
  // The command is first and Compact is off in a chat with no turn: the reason shows, and Enter
  // does nothing.
  await page.getByTestId("composer-input").fill("/comp")
  await expect(page.getByTestId("command-option")).toHaveAttribute("aria-disabled", "true")
  await expect(page.getByTestId("command-option")).toContainText(
    "Compact is off: the conversation has 2 turns or fewer.",
  )
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-input")).toHaveValue("/comp")
  await expect(page.getByTestId("message")).toHaveCount(0)
  await page.getByTestId("composer-input").fill("")

  // Bo is not in the list of "Check a claim".
  await openAgent(page, "Bo")
  await page.getByTestId("composer-input").fill("/")
  await expect(page.locator("[data-testid=skill-option]")).toHaveCount(1)
  await expect(page.locator("[data-testid=skill-option]")).toHaveAttribute(
    "data-skill",
    "Weekly summary",
  )
  await page.getByTestId("composer-input").fill("")

  // --- Use: the chip, the text after it, the instructions before the text ------------------------
  await openAgent(page, "Ada")
  await page.getByTestId("composer-input").fill("/we")
  await expect(page.getByTestId("command-option")).toHaveCount(0)
  await expect(page.getByTestId("skill-option")).toHaveCount(1)
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-skill")).toContainText("Weekly summary")
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  // Backspace at the start of the box removes the chip.
  await page.getByTestId("composer-input").press("Backspace")
  await expect(page.getByTestId("composer-skill")).toHaveCount(0)
  await page.getByTestId("composer-input").fill("/we")
  await page.getByTestId("skill-option").click()
  await expect(page.getByTestId("composer-skill")).toContainText("Weekly summary")
  // A second skill replaces the first.
  await page.getByTestId("composer-input").fill("/check")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-skill")).toHaveCount(1)
  await expect(page.getByTestId("composer-skill")).toContainText("Check a claim")
  await page.getByTestId("composer-input").fill("/weekly")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-skill")).toContainText("Weekly summary")
  await page.getByTestId("composer-input").fill("for the team")
  await shot(page, "s31-06-chip-en")
  await page.getByTestId("composer-input").press("Enter")
  await settled(page)
  const sent = sentTo(mock, "for the team")
  expect(sent.indexOf("Write a weekly summary. Keep it short.")).toBeGreaterThanOrEqual(0)
  expect(sent.indexOf("Write a weekly summary. Keep it short.")).toBeLessThan(
    sent.indexOf("for the team"),
  )
  // The row shows the text and the chip above it; a click on the chip shows the instructions.
  const first = page.getByTestId("message").first()
  await expect(first.getByTestId("message-skill")).toContainText("Weekly summary")
  await expect(first).toContainText("for the team")
  await openChip(first.getByTestId("message-skill"))
  await expect(first.getByTestId("message-skill-text")).toHaveText(
    "Write a weekly summary. Keep it short.",
  )
  await shot(page, "s31-07-sent-en")

  // --- The chip alone is a message --------------------------------------------------------------
  await page.getByTestId("composer-input").fill("/weekly")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-send")).toBeEnabled()
  await page.getByTestId("composer-send").click()
  await settled(page)
  await expect(page.getByTestId("message-skill")).toHaveCount(2)

  // --- Edit after the send: an old message keeps the old instructions ---------------------------
  const weekly = (await skillsOf(page)).find((s) => s.name === "Weekly summary") as SkillRow
  await rpc(page, "skills.update", {
    id: weekly.id,
    name: "Weekly summary",
    description: "Each Friday",
    instructions: "NEW STEPS only.",
    agentIds: null,
  })
  await openChip(page.getByTestId("message").first().getByTestId("message-skill"))
  await expect(page.getByTestId("message").first().getByTestId("message-skill-text")).toHaveText(
    "Write a weekly summary. Keep it short.",
  )
  // The next message gets the new instructions.
  await page.getByTestId("composer-input").fill("/weekly")
  await page.getByTestId("composer-input").press("Enter")
  await page.getByTestId("composer-input").fill("again")
  await page.getByTestId("composer-input").press("Enter")
  await settled(page)
  expect(sentTo(mock, "again")).toContain("NEW STEPS only.")

  // --- A chip in the box, and the skill is turned off: the send is refused ------------------------
  await page.getByTestId("composer-input").fill("/weekly")
  await page.getByTestId("composer-input").press("Enter")
  await page.getByTestId("composer-input").fill("refused text")
  await rpc(page, "skills.setEnabled", { id: weekly.id, enabled: false })
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-error")).toHaveText("This skill is not available.")
  await expect(page.getByTestId("composer-skill")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toHaveValue("refused text")
  await shot(page, "s31-08-refused-en")
  await page.getByTestId("composer-skill-remove").click()
  await page.getByTestId("composer-input").press("Enter")
  await settled(page)
  await expect(page.getByTestId("composer-error")).toHaveCount(0)
  expect(sentTo(mock, "refused text")).toBe("refused text")

  // --- Compact is a command of the list, once the chat has enough turns --------------------------
  await rpc(page, "skills.setEnabled", { id: weekly.id, enabled: true })
  await page.getByTestId("composer-input").fill("/comp")
  await expect(page.getByTestId("command-option")).toContainText("Compact the conversation")
  await expect(page.getByTestId("command-option")).toHaveAttribute("aria-disabled", "false")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await expect(page.getByTestId("message-compacted")).toHaveCount(1, { timeout: 20_000 })
  await shot(page, "s31-09-compacted-en")

  // --- A delete keeps the chip of old messages --------------------------------------------------
  await openSkills(page)
  await row(page, "Weekly summary").getByTestId("skill-delete").click()
  await expect(page.getByTestId("skill-delete-ask")).toBeVisible()
  await row(page, "Weekly summary").getByTestId("skill-delete-confirm").click()
  await expect(row(page, "Weekly summary")).toHaveCount(0)
  await closeSettings(page)
  await expect(page.getByTestId("message-skill").first()).toContainText("Weekly summary")
  await openChip(page.getByTestId("message").first().getByTestId("message-skill"))
  await expect(page.getByTestId("message").first().getByTestId("message-skill-text")).toHaveText(
    "Write a weekly summary. Keep it short.",
  )

  await app.close()
  await mock.close()
})

test("skills: 100 skills is the most; Duplicate and New skill say so (English)", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 760, 760)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const serverId = await serverOf(page)
  for (let n = 1; n <= 100; n++)
    await rpc(page, "skills.create", {
      serverId,
      name: `Skill ${String(n).padStart(3, "0")}`,
      description: "",
      instructions: "Do it.",
      agentIds: null,
    })
  await openSkills(page)
  await expect(page.getByTestId("skill-row")).toHaveCount(100)

  await row(page, "Skill 001").getByTestId("skill-duplicate").click()
  await expect(page.getByTestId("skills-error")).toHaveText(
    "This server has 100 skills, the most it can hold.",
  )
  await expect(page.getByTestId("skill-row")).toHaveCount(100)
  await shot(page, "s31-10-full-en")

  await page.getByTestId("skills-new").click()
  await fillForm(page, { name: "One more", instructions: "Do it." })
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-error")).toHaveText(
    "This server has 100 skills, the most it can hold.",
  )
  await page.getByTestId("skill-cancel").click()
  // Edit still works at 100.
  await row(page, "Skill 001").getByTestId("skill-edit").click()
  await fillForm(page, { instructions: "Do it well." })
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  expect((await skillsOf(page)).find((s) => s.name === "Skill 001")?.instructions).toBe(
    "Do it well.",
  )

  await app.close()
  await mock.close()
})

test("skills: the page and the list in Korean, at a narrow window", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 560, 760)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "에이다")
  const serverId = await serverOf(page)
  await rpc(page, "skills.create", {
    serverId,
    name: "주간 요약",
    description: "금요일마다",
    instructions: "한 주의 일을 요약해 주세요.",
    agentIds: null,
  })
  await openSkills(page)
  await expect(row(page, "주간 요약")).toBeVisible()
  await shot(page, "s31-11-list-ko")
  await row(page, "주간 요약").getByTestId("skill-duplicate").click()
  await expect(row(page, "주간 요약 사본")).toBeVisible()
  await expect(page.getByText("스킬 주간 요약 사본을(를) 복제했어요.")).toBeVisible()
  await row(page, "주간 요약").getByTestId("skill-edit").click()
  await expect(page.getByRole("heading", { name: "스킬 수정" })).toBeVisible()
  await shot(page, "s31-12-edit-form-ko")
  await page.getByTestId("skill-cancel").click()
  await closeSettings(page)

  await page.getByTestId("composer-input").fill("/")
  await expect(page.getByTestId("command-option")).toContainText("/compact")
  await expect(page.getByTestId("command-option")).toContainText("대화가 2턴 이하예요")
  await expect(page.getByTestId("skill-option")).toHaveCount(1)
  await shot(page, "s31-13-slash-list-ko")
  await page.getByTestId("composer-input").press("ArrowDown")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-skill")).toContainText("주간 요약")
  await shot(page, "s31-14-chip-ko")

  await app.close()
  await mock.close()
})
