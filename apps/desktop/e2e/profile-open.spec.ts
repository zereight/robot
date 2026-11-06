import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The profile of an agent opens from the face and the name of the agent by a message in the chat of
// the agent (spec 002).

const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}

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
