import { expect, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow } from "./harness.ts"

// The settings part "Organization" (spec 030, 013): the hand-off rule, "Any agent" by default.

test("organization: the hand-off rule is set in settings and kept after a restart", async () => {
  test.setTimeout(90_000)
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const first = await launch(userData, env)
  await resizeWindow(first.app, 1300, 860)
  await first.page.getByTestId("open-settings").click()
  await first.page.getByTestId("settings-nav-organization").click()

  const rule = (page: typeof first.page, value: string) =>
    page.getByTestId("organization-hand-off").locator(`label[data-value="${value}"] input`)

  // The default is "Any agent", and the part says what that means.
  await expect(rule(first.page, "any")).toBeChecked()
  await expect(first.page.getByTestId("organization-hand-off-now")).toContainText(
    "Every agent can send a message to every other agent.",
  )
  // This computer changes the rule, so no read-only line shows.
  await expect(first.page.getByTestId("organization-readonly")).toHaveCount(0)

  await first.page
    .getByTestId("organization-hand-off")
    .locator('label[data-value="channels"]')
    .click()
  await expect(rule(first.page, "channels")).toBeChecked()
  await expect(first.page.getByTestId("organization-hand-off-now")).toContainText(
    "An agent can send a message to the agents of its channels",
  )
  await first.app.close()

  // The rule stays after the app starts again.
  const second = await launch(userData, env)
  await resizeWindow(second.app, 1300, 860)
  await second.page.getByTestId("open-settings").click()
  await second.page.getByTestId("settings-nav-organization").click()
  await expect(rule(second.page, "channels")).toBeChecked()
  await second.app.close()
})
