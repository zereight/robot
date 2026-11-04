import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const msgs = (page: Page) => page.getByTestId("channel-message")

/** The layout size of a box. The screen box is not used: a box scales in while it opens. */
const layoutSize = (box: Locator) =>
  box.evaluate((el) => {
    const e = el as HTMLElement
    return { width: e.offsetWidth, height: e.offsetHeight }
  })

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
  const size = () => layoutSize(dialog)
  const sizeBefore = await size()
  // Few agents: the member box is as high as all of them, under its limit of 180 px.
  const box = page.getByTestId("channel-member-box")
  const boxHeight = async () => (await layoutSize(box)).height
  const fewHeight = await boxHeight()
  expect(fewHeight).toBeGreaterThan(0)
  expect(fewHeight).toBeLessThan(180)
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
  expect(await boxHeight()).toBe(fewHeight)
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

test("channels: the member box stops at 180 px for many agents and keeps its height in a search", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  const names = ["Ada", "Bea", "Cai", "Dan", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jon", "Kim", "Lou"]
  for (const name of names) await createAgent(page, name)

  await page.getByTestId("new-channel").click()
  const box = page.getByTestId("channel-member-box")
  const height = async () => (await layoutSize(box)).height
  const dialog = page.getByTestId("channel-dialog")
  const size = () => layoutSize(dialog)
  await expect(page.getByTestId("channel-member-Ada")).toBeVisible()
  expect(await height()).toBe(180)
  const before = await size()
  // The list scrolls inside the box: the last agent is there, and the box did not grow for it.
  await page.getByTestId("channel-member-Lou").scrollIntoViewIfNeeded()
  await page.getByTestId("channel-member-Lou").check()
  expect(await height()).toBe(180)

  const search = page.getByTestId("channel-member-search")
  await search.fill("ea")
  await expect(page.getByTestId("channel-member-Bea")).toBeVisible()
  await expect(page.getByTestId("channel-member-Ada")).toHaveCount(0)
  expect(await height()).toBe(180)
  await search.fill("zzz")
  await expect(page.getByTestId("channel-member-nomatch")).toBeVisible()
  expect(await height()).toBe(180)
  // The first chosen member added a line of count; it was there already, so the box is the same.
  expect(await size()).toEqual(before)
  await shot(page, "s9-06-member-box-many")
  await app.close()
  await mock.close()
})

test("channels: the activity panel adds and removes members", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy"]) await createAgent(page, name)

  // A channel with Lia as the lead and Bo as a member. Cy stays out.
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Panel")
  await page.getByTestId("channel-member-Lia").check()
  await page.getByTestId("channel-member-Bo").check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("member-card")).toHaveCount(2)

  // A member with a running part stays: the panel shows the reason.
  await post(page, "split long job")
  await expect(page.getByTestId("plan-step")).toHaveAttribute("data-state", "running", {
    timeout: 15_000,
  })
  await page.getByTestId("panel-remove-Bo").click()
  await expect(page.getByTestId("panel-error")).toHaveText(
    "This member is working. Wait for its part to end or stop it.",
  )
  await expect(page.getByTestId("member-card")).toHaveCount(2)

  // After a stop, Bo leaves the channel.
  await page.getByTestId("channel-stop").click()
  await expect(page.getByTestId("plan-step")).toHaveCount(0, { timeout: 10_000 })
  await page.getByTestId("panel-remove-Bo").click()
  await expect(page.getByTestId("member-card")).toHaveCount(1)
  await expect(page.getByTestId("panel-error")).toHaveCount(0)

  // Add: the picker lists the agents outside the channel. A click adds one at once.
  await page.getByTestId("panel-add").click()
  await expect(page.getByTestId("panel-add-list")).toBeVisible()
  await expect(page.getByTestId("panel-add-pick-Bo")).toBeVisible()
  await expect(page.getByTestId("panel-add-pick-Cy")).toBeVisible()
  await expect(page.getByTestId("panel-add-pick-Lia")).toHaveCount(0)
  await page.getByTestId("panel-add-pick-Cy").click()
  await expect(page.getByTestId("member-card")).toHaveCount(2)
  await expect(page.getByTestId("panel-add-pick-Cy")).toHaveCount(0)
  await page.getByTestId("panel-add-pick-Bo").click()
  await expect(page.getByTestId("member-card")).toHaveCount(3)
  await expect(page.getByTestId("panel-add-empty")).toBeVisible()
  await shot(page, "s9-07-panel-members")

  // Removing the lead clears it: the next job asks who takes it.
  await page.getByTestId("panel-remove-Lia").click()
  await expect(page.getByTestId("member-card")).toHaveCount(2)
  const before = await msgs(page).count()
  await post(page, "who takes this")
  await expect(page.getByTestId("pick-member")).toBeVisible()
  await page.getByTestId("pick-Cy").click()
  await expect(page.getByTestId("pick-member")).toHaveCount(0)
  await expect(msgs(page).last()).toContainText("Cy", { timeout: 15_000 })
  expect(await msgs(page).count()).toBeGreaterThan(before)
  await app.close()
  await mock.close()
})
