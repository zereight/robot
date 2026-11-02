import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The work record (specs 002, 005): the task view lists the moments of a task with their clock
// times, and the profile of an agent has the block "Recent work" with the last 20 tasks.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
const place = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`)
const openProfile = async (page: Page, name: string) => {
  await place(page, name).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}
/** The block is at the end of the profile, which scrolls: bring it into view for the picture. */
const shotRecent = async (page: Page, name: string) => {
  await page.getByTestId("recent-work").scrollIntoViewIfNeeded()
  await shot(page, name)
}
const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}
const recentRows = (page: Page) => page.getByTestId("recent-row")
const moments = (page: Page) => page.locator("[data-testid=task-moment]")
const momentIds = (page: Page) =>
  moments(page).evaluateAll((els) => els.map((e) => e.dataset.moment))
const taskRows = (page: Page, label: string) =>
  page.locator("[data-testid=task-row]").filter({ hasText: label })

test("moments in the task view and Recent work in the profile of an agent", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy", "Ada", "Dee"]) await createAgent(page, name)

  // --- An agent with no task: one muted line, no "Show all" ------------------------------------
  await openProfile(page, "Dee")
  await expect(page.getByTestId("recent-work")).toBeVisible()
  await expect(page.getByTestId("recent-empty")).toHaveText("No work yet.")
  await expect(recentRows(page)).toHaveCount(0)
  await expect(page.getByTestId("recent-show-all")).toHaveCount(0)
  await shotRecent(page, "s52-01-recent-empty")
  await closeProfile(page)

  // --- A chat with 25 tasks: the block lists 20, newest first ----------------------------------
  await place(page, "Ada").click()
  for (let i = 1; i <= 25; i++) {
    await send(page, `note ${String(i).padStart(2, "0")}`)
    await settled(page)
    await expect(page.getByTestId("message").last()).toContainText(
      `You said: note ${String(i).padStart(2, "0")}`,
    )
  }
  await page.getByTestId("chat-header-agent").click()
  await expect(recentRows(page)).toHaveCount(20)
  await expect(recentRows(page).first().getByTestId("recent-label")).toContainText("note 25")
  await expect(recentRows(page).last().getByTestId("recent-label")).toContainText("note 06")
  await expect(recentRows(page).first().getByTestId("recent-state")).toHaveText("Done")
  await expect(recentRows(page).first().getByTestId("recent-source")).toHaveText("Chat")
  await expect(recentRows(page).first().getByTestId("recent-since")).toHaveText("now")
  await shotRecent(page, "s52-02-recent-twenty")

  // "Show all" opens the Tasks page with the filter set to this agent.
  await page.getByTestId("recent-show-all").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await expect(page.getByTestId("tasks-page")).toBeVisible()
  await expect(page.getByTestId("tasks-filter-agent")).toHaveValue(/.+/)
  await expect(page.getByTestId("tasks-filter-agent").locator("option:checked")).toHaveText("Ada")
  await expect(page.locator("[data-testid=task-row]")).toHaveCount(25)
  await shot(page, "s52-03-tasks-for-agent")

  // A row opens the task view. The moments of a chat task: Given, Started, Ended, Closed.
  await page.getByTestId("page-chats").click()
  await place(page, "Ada").click()
  await page.getByTestId("chat-header-agent").click()
  await recentRows(page).nth(1).click()
  await expect(page.getByTestId("task-detail")).toBeVisible()
  await expect(page.getByTestId("task-detail-state")).toHaveText("Done")
  await expect(momentIds(page)).resolves.toEqual(["given", "started", "ended", "closed"])
  await expect(moments(page).nth(0)).toContainText("Given in a chat")
  await expect(moments(page).nth(2)).toContainText("Ended: done")
  await expect(moments(page).nth(3)).toContainText("Closed: Done")
  // A clock time on each line, in plain text.
  for (const time of await moments(page).locator("time").allTextContents())
    expect(time).toMatch(/\d{1,2}:\d{2}/)
  await expect(page.getByTestId("task-verdict")).toHaveCount(0)
  await shot(page, "s52-04-moments-chat-task")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)

  // --- A step that waits for approval, and a question: the words say what the task waits for ---
  await page.getByTestId("page-chats").click()
  await place(page, "Ada").click()
  await send(page, `TOOL run_command ${JSON.stringify({ command: "sudo ls" })}`)
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("chat-header-agent").click()
  await expect(recentRows(page).first().getByTestId("recent-state")).toHaveText(
    "Waits for your approval",
  )
  await shotRecent(page, "s52-05-waits-for-approval")
  await closeProfile(page)
  await page.getByTestId("ask-deny").click()
  await settled(page)
  await send(page, `TOOL ask_user ${JSON.stringify({ question: "Which colour?" })}`)
  await expect(page.getByTestId("ask-card")).toContainText("Which colour?", { timeout: 15_000 })
  await page.getByTestId("chat-header-agent").click()
  await expect(recentRows(page).first().getByTestId("recent-state")).toHaveText(
    "Waits for your answer",
  )
  // The block changes while the profile is open: the answer ends the wait.
  await closeProfile(page)
  await page.getByTestId("ask-input").fill("green")
  await page.getByTestId("ask-send").click()
  await settled(page)

  // --- The profile changes while it is open: a task that runs ends --------------------------------
  await send(page, "slow work")
  await page.getByTestId("chat-header-agent").click()
  await expect(recentRows(page).first().getByTestId("recent-state")).toHaveText("Running")
  await expect(recentRows(page).first().getByTestId("recent-state")).toHaveText("Done", {
    timeout: 30_000,
  })
  await closeProfile(page)

  // --- A channel with "Review parts": a part waits for review, one is blocked, one is queued ----
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-review-parts").click()
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-form")).toHaveCount(0)

  // Bo is busy in his own chat, so his part of the job waits behind it.
  await place(page, "Bo").click()
  await send(page, "run long work")
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(1, {
    timeout: 15_000,
  })
  await place(page, "Launch").click()
  await post(page, "split review of the release")
  await expect(page.getByTestId("part-chip")).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator("[data-testid=part-card][data-state=blocked]")).toHaveCount(1, {
    timeout: 30_000,
  })
  await openProfile(page, "Bo")
  const queued = recentRows(page).filter({ hasText: "Write the introduction" })
  await expect(queued.getByTestId("recent-state")).toHaveText("Waits behind its own chat")
  await expect(queued.getByTestId("recent-source")).toHaveText("Channel")
  await shotRecent(page, "s52-06-waits-behind")
  await closeProfile(page)

  // Cy cannot do the work: the row says Blocked and gives the reason.
  await openProfile(page, "Cy")
  const blocked = recentRows(page).first()
  await expect(blocked.getByTestId("recent-state")).toHaveText("Blocked")
  await expect(blocked.getByTestId("recent-reason")).toHaveText("no access to the repository")
  await closeProfile(page)

  // Stop the chat of Bo: his part runs and waits for review.
  await place(page, "Bo").click()
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 10_000 })
  await place(page, "Launch").click()
  await expect(page.getByTestId("part-review-bar")).toHaveCount(1, { timeout: 30_000 })
  await openProfile(page, "Bo")
  const review = recentRows(page).filter({ hasText: "Write the introduction" })
  await expect(review.getByTestId("recent-state")).toHaveText("Waits for your review")
  await shotRecent(page, "s52-07-waits-for-review")

  // The task view of the part: Given by the lead, Started, Ended (waits for review).
  await review.click()
  await expect(page.getByTestId("task-detail-state")).toHaveText("In review")
  await expect(momentIds(page)).resolves.toEqual(["given", "started", "ended"])
  await expect(moments(page).nth(0)).toContainText("Given by the lead, Lia")
  await expect(moments(page).nth(2)).toContainText("Ended: waits for review")
  await shot(page, "s52-08-moments-part-in-review")

  // Ask for changes: the Decided moment shows the text of the request.
  await page.getByTestId("task-request-changes").click()
  await page.getByTestId("changes-text").fill("Make the introduction shorter")
  await page.getByTestId("changes-send").click()
  await expect(page.getByTestId("changes-dialog")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)
  await page.getByTestId("page-tasks").click()
  await taskRows(page, "Write the introduction for the first release")
    .filter({ hasText: "Done" })
    .first()
    .getByTestId("task-open")
    .click()
  await expect(momentIds(page)).resolves.toEqual(["given", "started", "ended", "decided", "closed"])
  await expect(moments(page).nth(3)).toContainText(
    "You asked for changes: Make the introduction shorter",
  )
  await shot(page, "s52-09-moments-decided-changes")
  await page.keyboard.press("Escape")
  await page.getByTestId("page-chats").click()
  await place(page, "Launch").click()

  // Accept the new part: it is done, with a Decided moment and no text.
  await expect(page.getByTestId("part-review-bar")).toHaveCount(1, { timeout: 30_000 })
  await page.getByTestId("part-accept").click()
  await expect(page.locator("[data-kind=summary]")).toHaveCount(1, { timeout: 30_000 })
  await page.getByTestId("page-tasks").click()
  await taskRows(page, "Changes: Write the introduction").first().getByTestId("task-open").click()
  await expect(moments(page).filter({ hasText: "You accepted the part" })).toHaveCount(1)
  await page.keyboard.press("Escape")

  // --- A channel without review: the lead judges, and the task view has the Judged moment -------
  await page.getByTestId("page-chats").click()
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Checks")
  for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Checks")
  await post(page, "split verdicts of the release")
  await expect(page.locator("[data-testid=channel-message][data-kind=summary]")).toHaveCount(1, {
    timeout: 60_000,
  })
  await page.getByTestId("page-tasks").click()
  const facts = taskRows(page, "List the facts")
  await facts.last().getByTestId("task-open").click()
  await expect(page.getByTestId("task-verdict")).toHaveText("Not met")
  await expect(momentIds(page)).resolves.toEqual(["given", "started", "ended", "judged", "closed"])
  await expect(moments(page).nth(3)).toContainText(
    "The lead judged it: Not met. Only two of the five facts are listed.",
  )
  await expect(moments(page).locator("[data-moment=decided]")).toHaveCount(0)
  await shot(page, "s52-10-moments-judged")
  await page.keyboard.press("Escape")
  await page.getByTestId("page-chats").click()

  // --- Korean: the block and the moments have their own words ----------------------------------
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-general").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await openProfile(page, "Cy")
  await expect(page.getByTestId("recent-work").locator("h3")).toHaveText("최근 작업")
  await expect(page.getByTestId("recent-show-all")).toHaveText("모두 보기")
  const blockedKo = page.locator("[data-testid=recent-row][data-state=blocked]")
  await expect(blockedKo.getByTestId("recent-state")).toHaveText("막힘")
  await expect(blockedKo.getByTestId("recent-reason")).toHaveText("no access to the repository")
  await blockedKo.click()
  await expect(page.getByTestId("task-moments")).toBeVisible()
  await expect(moments(page).first()).toContainText("맡김: 리드 Lia")
  await expect(moments(page).nth(2)).toContainText("끝남: 막힘")
  await shot(page, "s52-11-korean")
})
