import { expect, test } from "@playwright/test"
import { freshUserData, launch, shot } from "./harness.ts"

test("workflows: make one, open it, keep it after a restart, delete it", async () => {
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)

  await expect(page.getByTestId("workflows-empty")).toBeVisible()
  await shot(page, "w4-01-empty")

  // The empty list has its own visible "New workflow" button (spec 001).
  await expect(page.getByTestId("new-workflow-empty")).toBeVisible()
  await expect(page.getByTestId("new-workflow-empty")).toHaveText("New workflow")
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("Weekly report")
  await page.getByTestId("new-workflow-create").click()
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await expect(page.getByTestId("workflow-header")).toContainText("Weekly report")
  // A new workflow has a short default responsible document in the language of the window (010).
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-text")).toHaveValue(/You answer for this workflow/)
  await shot(page, "w4-02-open")

  await expect(page.getByTestId("workflow-row")).toHaveCount(1)
  await expect(page.getByTestId("workflow-row")).toContainText("Weekly report")
  await expect(page.getByTestId("workflow-row")).toContainText("0 nodes")
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
  await page.getByTestId("workflow-open").click()
  await page.getByTestId("workflow-delete").click()
  await shot(page, "w4-05-delete-ask")
  await page.getByTestId("workflow-delete-confirm").click()
  await expect(page.getByTestId("workflows-empty")).toBeVisible()
  await app.close()
})

test("workflows: the default document follows the language of the window", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("주간 보고")
  await page.getByTestId("new-workflow-create").click()
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-text")).toHaveValue(/이 워크플로우를 책임집니다/)
  await app.close()
})
