import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Send (spec 003, flow 1): Enter sends the message once. The host needs a short time to take the
// message. Enter again in that time must not send it again.

test("chat: Enter pressed again while a message goes sends it once", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  const input = page.getByTestId("composer-input")
  const mine = page.locator("[data-testid=message][data-author=user]")
  await input.fill("only once")
  // Five presses in one turn of the window: all of them reach the box before the host answers.
  await input.evaluate((box) => {
    for (let i = 0; i < 5; i++)
      box.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      )
  })
  // The box is empty at once, with no wait for the host.
  await expect(input).toHaveValue("")
  await expect(mine.first()).toContainText("only once")
  await expect(page.locator("[data-testid=message][data-author=agent]").first()).toContainText(
    "You said: only once",
  )
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
  await expect(mine).toHaveCount(1)
  await expect(page.getByTestId("queued")).toHaveCount(0)
  await shot(page, "send-once-01")

  await app.close()
  await mock.close()
})
