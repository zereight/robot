import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The `@` list of the message box in a channel (spec 004, "Mention"). The user types `@`, the list
// of the members opens and narrows, and a pick writes `@Name` in the box.

const msgs = (page: Page) => page.getByTestId("channel-message")

test("channels: an @ in the box opens a list of the members, and a pick writes the name", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy"]) await createAgent(page, name)

  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")

  const input = page.getByTestId("channel-input")
  const list = page.getByTestId("mention-list")
  const options = page.getByTestId("mention-option")

  // No list before the user types an @. An @ inside a word is plain text.
  await input.click()
  await input.pressSequentially("mail a@")
  await expect(list).toHaveCount(0)
  await input.fill("")

  // An @ opens the list with every member, and the list narrows as the user types.
  await input.pressSequentially("@")
  await expect(list).toBeVisible()
  // The three members, then `@all` as the last line.
  await expect(options).toHaveCount(4)
  await expect(options.first()).toHaveAttribute("aria-selected", "true")
  await expect(options.last()).toHaveAttribute("data-member", "@all")
  await shot(page, "channel-mention-01-list")
  await input.pressSequentially("b")
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveAttribute("data-member", "Bo")

  // Enter picks the member. It writes the name and a space, and it sends nothing.
  await input.press("Enter")
  await expect(input).toHaveValue("@Bo ")
  await expect(list).toHaveCount(0)
  await expect(msgs(page)).toHaveCount(0)

  // A second mention in the same message: the arrow keys move the mark, and a click also picks.
  await input.pressSequentially("hi @")
  await expect(options).toHaveCount(4)
  await input.press("ArrowDown")
  await input.press("ArrowDown")
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true")
  await input.press("Enter")
  await expect(input).toHaveValue("@Bo hi @Cy ")
  await input.fill("")
  await input.pressSequentially("@")
  await options.filter({ hasText: "Lia" }).click()
  await expect(input).toHaveValue("@Lia ")
  await expect(input).toBeFocused()

  // Escape closes the list and keeps the text.
  await input.fill("")
  await input.pressSequentially("@")
  await expect(list).toBeVisible()
  await input.press("Escape")
  await expect(list).toHaveCount(0)
  await expect(input).toHaveValue("@")

  // A message with two picked mentions goes to those two members, and the lead does not read it.
  await input.fill("")
  await input.pressSequentially("@")
  await input.pressSequentially("bo")
  await input.press("Tab")
  await input.pressSequentially("and @cy")
  await input.press("Enter")
  await expect(input).toHaveValue("@Bo and @Cy ")
  await input.press("Enter")
  await expect(input).toHaveValue("")
  await expect(msgs(page)).toHaveCount(3, { timeout: 15_000 })
  await expect(page.locator("[data-kind=plan]")).toHaveCount(0)
  await shot(page, "channel-mention-02-sent")

  // `@all` is in the list when the word starts "all". Picked, it calls every member, and the lead
  // makes no plan.
  const before = await msgs(page).count()
  await input.pressSequentially("@al")
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveAttribute("data-member", "@all")
  await input.press("Enter")
  await expect(input).toHaveValue("@all ")
  await input.pressSequentially("say hi")
  await input.press("Enter")
  await expect(input).toHaveValue("")
  await expect(msgs(page)).toHaveCount(before + 4, { timeout: 15_000 })
  await expect(page.locator("[data-kind=plan]")).toHaveCount(0)
  await shot(page, "channel-mention-03-all")

  await app.close()
  await mock.close()
})
