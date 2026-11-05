import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// A busy provider (spec 006). The stand-in says that it is overloaded twice, then it answers.
// The chat shows a muted line for each wait. The waits are 2 seconds and 4 seconds.

test("a busy model is tried again, and the chat shows the muted lines", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await page.getByTestId("composer-input").fill("Say hello after the model busy")
  await page.getByTestId("composer-input").press("Enter")

  const lines = page.getByTestId("busy-line")
  await expect(lines).toHaveCount(2, { timeout: 20_000 })
  await expect(lines.nth(0)).toHaveText("The model is busy. Trying again (1 of 3).")
  await expect(lines.nth(1)).toHaveText("The model is busy. Trying again (2 of 3).")
  await expect(page.locator("[data-testid=message][data-author=agent]").last()).toContainText(
    "Hello!",
    { timeout: 20_000 },
  )
  await shot(page, "s100-01-busy-lines")
  await app.close()
})
