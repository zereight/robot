import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The profile of an agent opens from the face and the name of the agent by a message, in a channel and in the
// chat of the agent, and from the card of a member in the "Now" panel of a channel (spec 002, 004).

const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}

test("the profile of an agent opens from the Now panel and from a message in a channel", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo"]) await createAgent(page, name)

  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  for (const name of ["Lia", "Bo"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")

  // The card of a member in the panel: its face and name open the profile of that member.
  const cards = page.getByTestId("member-card")
  await expect(cards).toHaveCount(2)
  await cards.filter({ hasText: "Bo" }).getByTestId("member-profile").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("agent-name")).toHaveValue("Bo")
  await shot(page, "profile-open-01-panel")
  await closeProfile(page)

  // The face by a message of a member opens the profile of that member.
  await page.getByTestId("channel-input").fill("@Bo hello")
  await page.getByTestId("channel-input").press("Enter")
  const reply = page
    .locator("[data-testid=message][data-author=agent]")
    .filter({ hasText: "Bo" })
    .first()
  await expect(reply).toBeVisible({ timeout: 15_000 })
  await reply.getByTestId("message-avatar").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("agent-name")).toHaveValue("Bo")
  await shot(page, "profile-open-02-message")
  await closeProfile(page)

  // The name by a message opens it too.
  await shot(page, "profile-open-03-name-row")
  await reply.getByTestId("message-name").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("agent-name")).toHaveValue("Bo")
  await closeProfile(page)

  await app.close()
  await mock.close()
})

test("the profile of an agent opens from the face by a message in the chat of the agent", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await page.getByTestId("composer-input").fill("hello there")
  await page.getByTestId("composer-input").press("Enter")
  const answer = page.locator("[data-testid=message][data-author=agent]").first()
  await expect(answer).toBeVisible({ timeout: 15_000 })
  await answer.getByTestId("message-avatar").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("agent-name")).toHaveValue("Ada")
  await closeProfile(page)

  // The name opens it too, and the name of the user does not.
  await answer.getByTestId("message-name").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("agent-name")).toHaveValue("Ada")
  await closeProfile(page)
  await expect(
    page.locator("[data-testid=message][data-author=user]").getByTestId("message-name"),
  ).toHaveCount(0)

  await app.close()
  await mock.close()
})
