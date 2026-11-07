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
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-text")).toHaveValue(/You answer for this workflow/)

  const card = page.getByTestId("workflow-row")
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId("workflow-nodes")).toHaveText("0 nodes")
  await expect(card.getByTestId("workflow-last-run")).toHaveText("No run yet")
  await expect(card.getByTestId("workflow-check")).toHaveText("Check: Passed")
  await shot(page, "w5-03-list-card")

  // A second card; the list shows both.
  await page.getByTestId("new-workflow").click()
  await page.getByTestId("new-workflow-name").fill("Daily digest")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await expect(page.getByTestId("workflow-row")).toHaveCount(2)

  // Delete from the card asks first; "Keep it" changes nothing. The list is alphabetical.
  await page.getByTestId("workflow-card-delete").first().click()
  await expect(page.getByTestId("workflow-delete-ask")).toContainText("Daily digest")
  await shot(page, "w5-04-list-delete-ask")
  await page.getByTestId("workflow-delete-keep").click()
  await expect(page.getByTestId("workflow-row")).toHaveCount(2)
  await page.getByTestId("workflow-card-delete").first().click()
  await page.getByTestId("workflow-delete-confirm").click()
  await expect(page.getByTestId("workflow-row")).toHaveCount(1)
  await expect(page.getByTestId("workflow-row")).toContainText("Weekly")
  await app.close()
})

test("workflow list in Korean: the words 워크플로우 and 담당 문서", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await expect(page.getByTestId("new-workflow-empty")).toHaveText("새 워크플로우")
  await expect(page.getByTestId("workflows-empty")).toContainText("워크플로우")
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("주간 보고")
  await page.getByTestId("new-workflow-name").press("Enter")
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-editor")).toContainText("담당 문서")
  await shot(page, "w5-05-document-ko")
  await expect(page.getByTestId("workflow-last-run")).toHaveText("아직 실행한 적이 없어요")
  await expect(page.getByTestId("workflow-check")).toHaveText("검사: 통과")
  await shot(page, "w5-06-list-ko")
  await app.close()
})

test("new workflow: Enter during an IME composition does not submit", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await page.getByTestId("new-workflow-empty").click()
  const name = page.getByTestId("new-workflow-name")
  await name.fill("주간 보고")
  // The Enter key that ends a Korean composition has isComposing set (and keyCode 229).
  await name.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    )
  })
  await expect(page.getByTestId("new-workflow-dialog")).toBeVisible()
  await expect(page.getByTestId("workflow-view")).toHaveCount(0)
  await name.press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await app.close()
})

test("workflow list: a state that this version does not know is not shown as 'No run yet'", async () => {
  const userData = freshUserData()
  let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("Weekly")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await app.close()

  const { DatabaseSync } = await import("node:sqlite")
  const { join } = await import("node:path")
  const db = new DatabaseSync(join(userData, "robot.db"))
  const flow = db.prepare("SELECT id FROM workflow").get() as { id: string }
  db.prepare(
    "INSERT INTO run (id, workflow_id, state, source, started_at, finished_at) VALUES ('r1', ?, 'from_a_later_version', 'hand', 1, 2)",
  ).run(flow.id)
  db.close()

  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" }))
  await expect(page.getByTestId("workflow-last-run")).toHaveText("Last run: state not known")
  await app.close()
})

test("workflow list: a background event does not close the delete question", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("Weekly")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await page.getByTestId("new-workflow").click()
  await page.getByTestId("new-workflow-name").fill("Daily digest")
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await expect(page.getByTestId("workflow-row")).toHaveCount(2)

  // Count the events "workflows.changed" that the window gets.
  await page.evaluate(() => {
    const w = window as unknown as {
      robot: { on: (event: string, fn: () => void) => void }
      changed: number
    }
    w.changed = 0
    w.robot.on("workflows.changed", () => {
      w.changed++
    })
  })
  const changed = () => page.evaluate(() => (window as unknown as { changed: number }).changed)

  await page.getByTestId("workflow-card-delete").first().click()
  await expect(page.getByTestId("workflow-delete-ask")).toContainText("Daily digest")

  // A background check ends and the main process sends "workflows.changed": the list is read
  // again, and the open question stays where it is.
  const before = await changed()
  await page.evaluate(async () => {
    const invoke = (
      window as unknown as {
        robot: { invoke: (m: string, i?: unknown) => Promise<{ ok: boolean; value?: unknown }> }
      }
    ).robot.invoke
    const servers = (await invoke("servers.list")).value as { id: string; kind: string }[]
    const local = servers.find((s) => s.kind === "local")
    const flows = (await invoke("workflows.list", { serverId: local?.id })).value as {
      id: string
    }[]
    for (const flow of flows) await invoke("workflows.check", { id: flow.id })
  })
  await expect
    .poll(changed, { message: "no workflows.changed event arrived" })
    .toBeGreaterThan(before)
  // The list had time to read again: wait for the cards to show the check, then look at the question.
  await expect(page.getByTestId("workflow-check")).toHaveText(["Check: Passed", "Check: Passed"])
  await expect(page.getByTestId("workflow-delete-ask")).toHaveCount(1)
  await expect(page.getByTestId("workflow-delete-ask")).toContainText("Daily digest")
  await shot(page, "w5-07-delete-ask-after-event")
  await page.getByTestId("workflow-delete-keep").click()
  await expect(page.getByTestId("workflow-delete-ask")).toHaveCount(0)
  await expect(page.getByTestId("workflow-row")).toHaveCount(2)
  await app.close()
})
