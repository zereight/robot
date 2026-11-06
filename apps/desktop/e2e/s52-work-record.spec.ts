import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The work record (specs 002, 005): the task view lists the moments of a task with their clock
// times, and the profile of an agent has the block "Recent work" with the last 20 tasks.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
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

test("moments in the task view and Recent work in the profile of an agent", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Ada", "Dee"]) await createAgent(page, name)

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

  // --- Korean: the block and the moments have their own words ----------------------------------
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-general").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await openProfile(page, "Ada")
  await expect(page.getByTestId("recent-work").locator("h3")).toHaveText("최근 작업")
  await expect(page.getByTestId("recent-show-all")).toHaveText("모두 보기")
  const doneKo = page.locator("[data-testid=recent-row][data-state=done]").first()
  await expect(doneKo.getByTestId("recent-state")).toHaveText("완료")
  await doneKo.click()
  await expect(page.getByTestId("task-moments")).toBeVisible()
  await expect(moments(page).first()).toContainText("맡김: 채팅")
  await expect(moments(page).nth(2)).toContainText("끝남: 완료")
  await shot(page, "s52-11-korean")
})
