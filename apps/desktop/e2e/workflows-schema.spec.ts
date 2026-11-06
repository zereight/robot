import { expect, test } from "@playwright/test"
import { freshUserData, launch, shot } from "./harness.ts"

test("workflows: make one, open it, keep it after a restart, delete it", async () => {
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)

  await expect(page.getByTestId("workflows-empty")).toBeVisible()
  await shot(page, "w4-01-empty")

  await page.getByTestId("new-workflow").click()
  await page.getByTestId("new-workflow-name").fill("Weekly report")
  await page.getByTestId("new-workflow-create").click()
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await expect(page.getByTestId("workflow-header")).toContainText("Weekly report")
  await shot(page, "w4-02-open")

  await page.getByTestId("workflow-back").click()
  await expect(page.getByTestId("workflow-row")).toHaveCount(1)
  await expect(page.getByTestId("workflow-row")).toContainText("Weekly report")
  await shot(page, "w4-03-list")

  // A second workflow with the same name is refused, and the dialog says why.
  await page.getByTestId("new-workflow").click()
  await page.getByTestId("new-workflow-name").fill("weekly REPORT")
  await page.getByTestId("new-workflow-create").click()
  await expect(page.getByTestId("new-workflow-error")).toBeVisible()
  await shot(page, "w4-04-name-taken")
  await page.keyboard.press("Escape")
  await app.close()

  ;({ app, page } = await launch(userData, env))
  await expect(page.getByTestId("workflow-row")).toHaveCount(1)
  await page.getByTestId("workflow-row").click()
  await page.getByTestId("workflow-delete").click()
  await shot(page, "w4-05-delete-ask")
  await page.getByTestId("workflow-delete-confirm").click()
  await expect(page.getByTestId("workflows-empty")).toBeVisible()
  await app.close()
})
