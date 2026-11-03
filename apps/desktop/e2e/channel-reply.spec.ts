import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// A reply to a part in a channel goes to the member of that part as a new part (spec question of
// 004). A reply to another message mentions its author, as before.

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const msgs = (page: Page) => page.getByTestId("channel-message")

test("channels: a reply to a part goes to its member as a new part", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy"]) await createAgent(page, name)

  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")

  await post(page, "split two things")
  await expect(page.locator("[data-kind=summary]")).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId("part-chip")).toHaveCount(2)

  // The reply of Bo in his part. Reply shows a quote line, Escape takes it away, and Reply again
  // brings it back.
  const target = page
    .locator("[data-testid=channel-message][data-kind=text]")
    .filter({ hasText: "Bo" })
    .first()
  await target.hover()
  await target.getByTestId("action-reply").click()
  const quote = page.getByTestId("channel-reply-quote")
  await expect(quote).toContainText("Replying to Bo")
  await expect(page.getByTestId("channel-input")).toHaveValue("")
  await page.getByTestId("channel-input").press("Escape")
  await expect(quote).toHaveCount(0)
  await target.hover()
  await target.getByTestId("action-reply").click()
  await expect(quote).toBeVisible()
  await shot(page, "channel-reply-01-quote")

  // Send: the quote goes, Bo answers in a new part, and the lead makes no new plan.
  const before = await msgs(page).count()
  await post(page, "make it shorter")
  await expect(quote).toHaveCount(0)
  await expect(page.getByTestId("part-chip")).toHaveCount(2)
  await expect(msgs(page)).toHaveCount(before + 2, { timeout: 15_000 })
  await expect(msgs(page).last()).toContainText("Bo")
  await expect(page.locator("[data-kind=plan]")).toHaveCount(1)
  await shot(page, "channel-reply-02-answered")

  // A reply to the summary of the lead mentions the lead, as before.
  const summary = page.locator("[data-kind=summary]").last()
  await summary.hover()
  await summary.getByTestId("action-reply").click()
  await expect(quote).toHaveCount(0)
  await expect(page.getByTestId("channel-input")).toHaveValue("@Lia ")

  await app.close()
  await mock.close()
})
