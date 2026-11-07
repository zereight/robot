import { expect, test } from "@playwright/test"
import { freshUserData, launch, shot } from "./harness.ts"

// Spec 001 (the list, the empty state, the cards) and 010 (flow 1, "New workflow").

test("workflow list: the empty state, a new workflow, the card, the delete question", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })

  // No workflow: one line that says what a workflow is, and a visible "New workflow" button.
  await expect(page.getByTestId("workflows-empty")).toBeVisible()
  await expect(page.getByTestId("new-workflow-empty")).toHaveText("New workflow")
  await shot(page, "w5-01-list-empty")

  await page.getByTestId("new-workflow-empty").click()
  await shot(page, "w5-02-new-dialog")
  // An empty name cannot be created.
  await expect(page.getByTestId("new-workflow-create")).toBeDisabled()
  await page.getByTestId("new-workflow-name").fill("Weekly")
  await page.getByTestId("new-workflow-create").click()
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await expect(page.getByTestId("workflow-header")).toContainText("Weekly")

  // The responsible document has the short default text.
  await expect(page.getByTestId("document-text")).toHaveValue(/You answer for this workflow/)

  await page.getByTestId("workflow-back").click()
  const card = page.getByTestId("workflow-row")
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId("workflow-nodes")).toHaveText("0 nodes")
  await expect(card.getByTestId("workflow-last-run")).toHaveText("No run yet")
  await expect(card.getByTestId("workflow-check")).toHaveText("Check: Not checked")
  await shot(page, "w5-03-list-card")

  // A second card; the list shows both.
  await page.getByTestId("new-workflow").click()
  await page.getByTestId("new-workflow-name").fill("Daily digest")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await page.getByTestId("workflow-back").click()
  await expect(page.getByTestId("workflow-row")).toHaveCount(2)

  // Delete from the card asks first; "Keep it" changes nothing.
  await page.getByTestId("workflow-card-delete").first().click()
  await expect(page.getByTestId("workflow-delete-ask")).toContainText("Weekly")
  await shot(page, "w5-04-list-delete-ask")
  await page.getByTestId("workflow-delete-keep").click()
  await expect(page.getByTestId("workflow-row")).toHaveCount(2)
  await page.getByTestId("workflow-card-delete").first().click()
  await page.getByTestId("workflow-delete-confirm").click()
  await expect(page.getByTestId("workflow-row")).toHaveCount(1)
  await expect(page.getByTestId("workflow-row")).toContainText("Daily digest")
  await app.close()
})

test("workflow list in Korean: the words 워크플로우 and 담당 문서", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await expect(page.getByTestId("new-workflow-empty")).toHaveText("새 워크플로우")
  await expect(page.getByTestId("workflows-empty")).toContainText("워크플로우")
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("주간 보고")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("document-editor")).toContainText("담당 문서")
  await shot(page, "w5-05-document-ko")
  await page.getByTestId("workflow-back").click()
  await expect(page.getByTestId("workflow-last-run")).toHaveText("아직 실행한 적이 없어요")
  await expect(page.getByTestId("workflow-check")).toHaveText("검사: 검사 안 함")
  await shot(page, "w5-06-list-ko")
  await app.close()
})
