import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Review of parts, the state Blocked, and the log entries of a step that Read only refuses
// (specs 004, 005, 007): one channel with "Review parts" on, a lead that splits a job into a part
// that ends (and waits for review) and a part that cannot be done (and is Blocked).

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
const rows = (page: Page, state: string) =>
  page.locator(`[data-testid=task-row][data-state=${state}]`)

test("review of parts, Blocked, and the Refused entries of Read only in the action log", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy", "Ada"]) await createAgent(page, name)

  // --- A channel with a lead; "Review parts" is off at first and is a setting of the channel ----
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  // The setting is for a channel that exists: the form of a new channel has no switch.
  await expect(page.getByTestId("channel-review-parts")).toHaveCount(0)
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")

  await page.getByTestId("channel-settings").click()
  const review = page.getByTestId("channel-review-parts")
  await expect(review).toHaveAttribute("aria-checked", "false")
  await review.click()
  await expect(review).toHaveAttribute("aria-checked", "true")
  await shot(page, "review-blocked-01-setting")
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-form")).toHaveCount(0)

  // --- A job with two parts: one waits for review, one is Blocked, the summary waits (004, 005) -
  await post(page, "split review of the release")
  await expect(page.getByTestId("part-chip")).toHaveCount(2, { timeout: 30_000 })
  const bar = page.getByTestId("part-review-bar")
  await expect(bar).toHaveCount(1, { timeout: 30_000 })
  await expect(bar).toContainText("This part waits for your review.")
  await expect(bar.getByTestId("part-accept")).toBeVisible()
  await expect(bar.getByTestId("part-changes")).toBeVisible()
  const blocked = page.locator("[data-testid=part-card][data-state=blocked]")
  await expect(blocked).toHaveCount(1)
  await expect(blocked).toContainText("This part is blocked.")
  await expect(blocked.getByTestId("part-blocked-reason")).toHaveText("no access to the repository")
  await expect(blocked.getByTestId("part-retry")).toBeVisible()
  await expect(blocked.getByTestId("part-end-request")).toBeVisible()
  // The plan steps carry the eye and the stop sign, with a name for each state.
  await expect(page.getByTestId("plan-step")).toHaveCount(2)
  await expect(page.locator("[data-testid=plan-step][data-state=review]")).toHaveCount(1)
  await expect(page.locator("[data-testid=plan-step][data-state=blocked]")).toHaveCount(1)
  await shot(page, "review-blocked-02-review-and-blocked")
  // The part in review has not ended, so the lead does not write the summary yet.
  await page.waitForTimeout(1_500)
  await expect(page.locator("[data-kind=summary]")).toHaveCount(0)

  // --- The Tasks page: the two states with their icons, and the actions of each (005) ----------
  await page.getByTestId("page-tasks").click()
  await expect(rows(page, "review")).toHaveCount(1)
  await expect(rows(page, "blocked")).toHaveCount(1)
  await expect(rows(page, "review").getByTestId("task-state")).toHaveText("In review")
  await expect(rows(page, "review").locator("svg")).not.toHaveCount(0)
  await expect(rows(page, "blocked").getByTestId("task-state")).toHaveText("Blocked")
  await expect(rows(page, "blocked").locator("svg")).not.toHaveCount(0)
  await shot(page, "review-blocked-03-tasks")

  await rows(page, "blocked").getByTestId("task-open").click()
  await expect(page.getByTestId("task-detail-state")).toHaveText("Blocked")
  await expect(page.getByTestId("task-error")).toContainText("no access to the repository")
  await expect(page.getByTestId("task-retry")).toBeVisible()
  await expect(page.getByTestId("task-end-request")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)

  await rows(page, "review").getByTestId("task-open").click()
  await expect(page.getByTestId("task-detail-state")).toHaveText("In review")
  await expect(page.getByTestId("task-accept")).toBeVisible()
  await expect(page.getByTestId("task-request-changes")).toBeVisible()
  await expect(page.getByTestId("task-end-request")).toBeVisible()
  await shot(page, "review-blocked-04-task-in-review")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)
  await page.getByTestId("page-chats").click()

  // --- Request changes: 1 to 2000 characters; a new part with a short label; review again -------
  await page.getByTestId("part-changes").click()
  const text = page.getByTestId("changes-text")
  await expect(page.getByTestId("changes-send")).toBeDisabled()
  await text.fill("   ")
  await expect(page.getByTestId("changes-send")).toBeDisabled()
  await text.fill("Make the introduction shorter")
  await expect(page.getByTestId("changes-send")).toBeEnabled()
  await shot(page, "review-blocked-05-request-changes")
  await page.getByTestId("changes-send").click()
  await expect(page.getByTestId("changes-dialog")).toHaveCount(0)
  // The new part answers and waits for review in its turn. The old part is done.
  await expect(page.getByTestId("part-review-bar")).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId("part-chip")).toHaveCount(3)
  await expect(page.locator("[data-kind=summary]")).toHaveCount(0)
  await page.getByTestId("page-tasks").click()
  await expect(rows(page, "review")).toHaveCount(1)
  // The label is "Changes: " and the old label, cut at 48 characters with an ellipsis.
  await expect(rows(page, "review")).toContainText(
    "Changes: Write the introduction for the first r…",
  )
  await page.getByTestId("page-chats").click()

  // --- Accept: the part is done, and the lead sums up, with the blocked part named (005) --------
  await page.getByTestId("part-accept").click()
  await expect(page.getByTestId("part-review-bar")).toHaveCount(0)
  await expect(page.locator("[data-kind=summary]")).toHaveCount(1, { timeout: 30_000 })
  await shot(page, "review-blocked-06-accepted-summary")
  await page.getByTestId("page-tasks").click()
  await expect(rows(page, "review")).toHaveCount(0)
  await expect(rows(page, "blocked")).toHaveCount(1)
  await page.getByTestId("page-chats").click()

  // --- End the request: a part in review and the rest of the request are cancelled (004, 005) ---
  await post(page, "split review of the next release")
  await expect(page.getByTestId("part-review-bar")).toHaveCount(1, { timeout: 30_000 })
  const blockedAgain = page.locator("[data-testid=part-card][data-state=blocked]")
  await expect(blockedAgain).toHaveCount(2)
  await blockedAgain.last().getByTestId("part-end-request").click()
  await expect(page.getByTestId("end-request-confirm")).toBeVisible()
  // Back changes nothing.
  await page.getByTestId("end-request-back").click()
  await expect(page.getByTestId("end-request-confirm")).toHaveCount(0)
  await expect(page.getByTestId("part-review-bar")).toHaveCount(1)
  await blockedAgain.last().getByTestId("part-end-request").click()
  await shot(page, "review-blocked-07-end-request")
  await page.getByTestId("end-request-confirm").click()
  await expect(page.getByTestId("part-review-bar")).toHaveCount(0, { timeout: 15_000 })
  await page.getByTestId("page-tasks").click()
  await expect(rows(page, "review")).toHaveCount(0)
  await expect(rows(page, "cancelled")).not.toHaveCount(0)
  // A part that was Blocked stays Blocked: it ended before the request did.
  await expect(rows(page, "blocked")).toHaveCount(2)
  await page.getByTestId("page-chats").click()

  // --- Read only: a refused step is in the action log, decided by the level (007) --------------
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
  await page.getByTestId("chat-header-agent").click()
  await page.locator("[data-testid=agent-permission] label[data-value=read_only]").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
  const write = { path: "written.txt", content: "x" }
  await send(page, `TOOL write_file ${JSON.stringify(write)}`)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Refused: read only")
  await send(page, `TOOL run_command ${JSON.stringify({ command: "touch touched.txt" })}`)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Refused: read only")

  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await page.getByTestId("action-log-result").getByText("Refused").click()
  const entries = page.getByTestId("action-log-entry")
  await expect(entries).toHaveCount(2)
  const file = entries.filter({ hasText: "written.txt" })
  await expect(file).toContainText("File")
  await expect(file.getByTestId("action-log-access")).toHaveAttribute("data-access", "write")
  await expect(file).toContainText("Refused")
  await expect(file).toContainText("Permission level")
  await expect(file).toContainText("Ada")
  const shell = entries.filter({ hasText: "touch touched.txt" })
  await expect(shell).toContainText("Shell command")
  await expect(shell).toContainText("Refused")
  await expect(shell).toContainText("Permission level")
  await shot(page, "review-blocked-08-read-only-log")

  // --- Korean: the states and the actions have their own words (005) ----------------------------
  await page.getByTestId("settings-nav-general").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await page.getByTestId("page-tasks").click()
  await expect(rows(page, "blocked").first().getByTestId("task-state")).toHaveText("막힘")
  await shot(page, "review-blocked-09-korean")

  await app.close()
  await mock.close()
})
