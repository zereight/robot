import { expect, test } from "@playwright/test"
import { freshUserData, launch, shot } from "./harness.ts"

// Spec 002: the editor of the responsible document, its limits, and its history.

test("document: edit and save, the limits, the history, restore", async () => {
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("Weekly")
  await page.getByTestId("new-workflow-name").press("Enter")
  await page.getByTestId("tab-document").click()
  const text = page.getByTestId("document-text")
  await expect(text).toHaveValue(/You answer for this workflow/)
  const original = await text.inputValue()

  // No change: nothing to save, and no version yet.
  await expect(page.getByTestId("document-save")).toBeDisabled()
  await expect(page.getByTestId("document-history-empty")).toBeVisible()

  // Edit and save. The old text becomes a version.
  await text.fill("Answer in Korean. Keep to the weekly report.")
  await expect(page.getByTestId("document-count")).toHaveText("44 of 20000 characters")
  await page.getByTestId("document-save").click()
  await expect(page.getByTestId("document-saved")).toBeVisible()
  await expect(page.getByTestId("document-version")).toHaveCount(1)
  await expect(page.getByTestId("document-history-count")).toHaveText("1 of 50 versions kept")
  await shot(page, "w5-10-document-saved")

  // The version holds the old text; open it and look.
  await page.getByTestId("document-version-open").click()
  await expect(page.getByTestId("document-version-text")).toHaveText(original)
  await shot(page, "w5-11-document-version")

  // Restore: the old text is back, and the text before the restore is a new version.
  await page.getByTestId("document-version-restore").click()
  await expect(text).toHaveValue(original)
  await expect(page.getByTestId("document-version")).toHaveCount(2)
  await expect(page.getByTestId("document-restored")).toBeVisible()

  // A text over 20000 characters is refused with the reason, and the typed text stays.
  const long = "x".repeat(20_001)
  await text.fill(long)
  await expect(page.getByTestId("document-count")).toHaveAttribute("data-over", "true")
  await page.getByTestId("document-save").click()
  await expect(page.getByTestId("document-error")).toBeVisible()
  await expect(text).toHaveValue(long)
  await shot(page, "w5-12-document-too-long")

  // A text that looks like a secret is refused, with the reason.
  await text.fill("My key is sk-ant-api03-abcdefghijklmnop1234")
  await page.getByTestId("document-save").click()
  await expect(page.getByTestId("document-error")).toBeVisible()
  await expect(page.getByTestId("document-version")).toHaveCount(2)

  // An empty document is valid. The page says what that means.
  await text.fill("")
  await page.getByTestId("document-save").click()
  await expect(page.getByTestId("document-saved")).toBeVisible()
  await expect(page.getByTestId("document-empty-note")).toBeVisible()
  await shot(page, "w5-13-document-empty")
  await text.fill("Last text.")
  await page.getByTestId("document-save").click()
  await expect(page.getByTestId("document-version")).toHaveCount(4)
  await app.close()

  // The text stays after a restart.
  // The app opens the workflow that was open (spec 001).
  ;({ app, page } = await launch(userData, env))
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-text")).toHaveValue("Last text.")
  await expect(page.getByTestId("document-version")).toHaveCount(4)
  await app.close()
})

test("document: the editor is read-only while a run works", async () => {
  const userData = freshUserData()
  let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill("Weekly")
  await page.getByTestId("new-workflow-name").press("Enter")
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-text")).toBeVisible()
  await app.close()

  // A run that works is a row in the database. The test writes it while no app has the file open.
  const { DatabaseSync } = await import("node:sqlite")
  const { join } = await import("node:path")
  const db = new DatabaseSync(join(userData, "robot.db"))
  const flow = db.prepare("SELECT id FROM workflow").get() as { id: string }
  db.prepare(
    "INSERT INTO run (id, workflow_id, state, source, started_at) VALUES ('r1', ?, 'running', 'hand', ?)",
  ).run(flow.id, Date.now())
  db.close()

  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" }))
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-readonly")).toBeVisible()
  await expect(page.getByTestId("document-text")).toHaveAttribute("readonly", "")
  await expect(page.getByTestId("document-save")).toBeDisabled()
  await shot(page, "w5-14-document-readonly")
  await page.getByTestId("workflow-back").click()
  await expect(page.getByTestId("workflow-last-run")).toHaveText("Last run: Running")
  await app.close()
})
