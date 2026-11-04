import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const msgs = (page: Page) => page.getByTestId("channel-message")

test("channels: create, split a job, chips, summary, stop, mention, pick", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy"]) await createAgent(page, name)

  // Create a channel with three members and a lead.
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  await page.getByTestId("channel-topic").fill("Ship the first release")
  // The member search hides agents but keeps the choice, and Enter in it does not send the form.
  const member = (name: string) => page.getByTestId(`channel-member-${name}`)
  const search = page.getByTestId("channel-member-search")
  await member("Lia").check()
  // The box keeps its size for any search: a short list and "no match" do not resize it.
  const dialog = page.getByTestId("channel-dialog")
  const size = async () => {
    const box = await dialog.boundingBox()
    return { width: box?.width, height: box?.height }
  }
  const sizeBefore = await size()
  await search.fill("bo")
  await expect(member("Bo")).toBeVisible()
  await expect(member("Lia")).toHaveCount(0)
  await expect(member("Cy")).toHaveCount(0)
  expect(await size()).toEqual(sizeBefore)
  await expect(page.getByTestId("channel-member-count")).toHaveText("1 selected")
  await shot(page, "s9-00-member-search")
  await search.press("Enter")
  await expect(page.getByTestId("channel-form")).toBeVisible()
  await member("Bo").check()
  await search.fill("zzz")
  await expect(page.getByTestId("channel-member-nomatch")).toBeVisible()
  expect(await size()).toEqual(sizeBefore)
  await search.fill("")
  await expect(member("Lia")).toBeChecked()
  await member("Cy").check()
  await expect(page.getByTestId("channel-member-count")).toHaveText("3 selected")
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
  await expect(page.getByTestId("channel-header-topic")).toHaveText("Ship the first release")
  await expect(page.getByTestId("member-card")).toHaveCount(3)
  await shot(page, "s9-01-channel-empty")

  // A job with two parts: plan, two chips, two replies, one summary.
  await post(page, "split two things")
  await expect(page.locator("[data-kind=plan]")).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId("part-chip")).toHaveCount(2)
  await expect(page.locator("[data-kind=summary]")).toHaveCount(1, { timeout: 15_000 })
  await expect(msgs(page)).toHaveCount(5)
  await shot(page, "s9-02-split-done")

  // A chip jumps to the newest reply of its part, and Back returns.
  await page.getByTestId("part-chip").first().click()
  await expect(page.getByTestId("jump-back")).toBeVisible()
  await page.getByTestId("jump-back").click()
  await expect(page.getByTestId("jump-back")).toHaveCount(0)

  // A long part shows plan steps; stopping the channel cancels it and the steps leave.
  await post(page, "split long job")
  await expect(page.getByTestId("plan-step")).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId("plan-step")).toHaveAttribute("data-state", "running")
  await shot(page, "s9-03-steps")
  await page.getByTestId("channel-stop").click()
  await expect(page.getByTestId("plan-step")).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId("channel-send")).toBeVisible()

  // A mention goes to one member only.
  const before = await msgs(page).count()
  await post(page, "@Cy say hello")
  await expect(msgs(page)).toHaveCount(before + 2, { timeout: 15_000 })
  await expect(msgs(page).last()).toContainText("Cy")

  // Tasks of the channel show on the tasks page.
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-table")).toContainText("Channel")
  await page.getByTestId("page-chats").click()

  // Without a lead, the user picks who takes the job.
  await page.getByTestId("channel-settings").click()
  await page
    .getByTestId("channel-lead")
    .selectOption({ label: "No lead: ask me who takes each job" })
  await page.getByTestId("channel-submit").click()
  await post(page, "who takes this")
  await expect(page.getByTestId("pick-member")).toBeVisible()
  await page.getByTestId("pick-Bo").click()
  await expect(page.getByTestId("pick-member")).toHaveCount(0)
  await expect(msgs(page).last()).toContainText("Bo", { timeout: 15_000 })
  await shot(page, "s9-04-pick")

  // Survives a restart; Korean works.
  await app.close()
  const second = await launch(userData, env)
  await resizeWindow(second.app, 1300, 860)
  await second.page.locator("[data-testid^=place-channel-]").click()
  await expect(second.page.getByTestId("channel-header-name")).toHaveText("Launch")
  await expect(second.page.getByTestId("part-chip")).toHaveCount(3)
  await second.page.getByTestId("open-settings").click()
  await second.page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await second.page.getByTestId("settings-close").click()
  await expect(second.page.getByTestId("channel-panel")).toContainText("지금")
  await shot(second.page, "s9-05-korean")
  await second.app.close()
  await mock.close()
})
