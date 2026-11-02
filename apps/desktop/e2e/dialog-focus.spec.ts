import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

/** The test id of the element that has the focus. */
const focused = (page: Page) =>
  page.evaluate(
    () =>
      (document.activeElement as HTMLElement | null)
        ?.closest("[data-testid]")
        ?.getAttribute("data-testid") ?? null,
  )

/** The exit motion of a box is short; the focus must stay where it is long after that. */
const PAST_EXIT = 500

test("dialogs: the focus goes back when a box closes, and never takes it from the user", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)

  // A box that closes gives the focus back to the button that opened it.
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("new-agent-dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0)
  await expect.poll(() => focused(page)).toBe("new-agent")

  // A new chat: the user goes straight to the message box. The closing box must not take the focus
  // away, as then keys would go to the "new agent" button and Enter would open the box again.
  await createAgent(page, "Zed")
  await page.getByTestId("composer-input").click()
  await page.waitForTimeout(PAST_EXIT)
  expect(await focused(page)).toBe("composer-input")
  await page.keyboard.type("hello there")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0)
  await expect(page.getByTestId("message").first()).toContainText("hello there")

  // A box that is closed and opened again at once keeps the focus in its first field.
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.waitForTimeout(PAST_EXIT)
  expect(await focused(page)).toBe("agent-name")

  await app.close()
  await mock.close()
})
