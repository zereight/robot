import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

/** The text of the last message in each chat request that the mock got. */
const lastMessages = (requests: readonly { path: string; body: unknown }[]) =>
  requests
    .filter((r) => r.path.endsWith("/chat/completions"))
    .map((r) => {
      const body = r.body as { model: string; messages: { content: string }[] }
      return { model: body.model, text: body.messages.at(-1)?.content ?? "" }
    })

test("watch routines: folder watch, change text, muted line, confirm, own model, failed checks", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const folder = mkdtempSync(join(tmpdir(), "robot-e2e-watch-"))
  writeFileSync(join(folder, "old.txt"), "old")
  // A "minute" of a watch is one second in this run, so a check every 5 minutes comes every
  // 5 seconds; the loop looks every 300 ms.
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_WATCH_MINUTE_MS: "1000",
    ROBOT_TEST_ROUTINE_TICK_MS: "300",
  })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const report: string[] = ["# S43 watch routines", ""]

  // 1. A watch on a folder, every 5 minutes, with "Post when nothing changed" and its own model.
  await page.getByTestId("page-routines").click()
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Inbox watch")
  await page.getByTestId("routine-prompt").fill("Sort the new files.")
  await page.getByTestId("routine-trigger").selectOption("watch")
  await page.getByTestId("routine-watch-interval").selectOption("5")
  await expect(page.getByTestId("routine-watch-often")).toHaveText(
    "This checks about 288 times a day.",
  )
  await page.getByTestId("routine-watch-kind").selectOption("path")
  await page.getByTestId("routine-watch-path").fill(folder)
  await page.getByTestId("routine-watch-unchanged").click()
  await page.getByTestId("routine-model-mode").selectOption("own")
  await page.getByTestId("model-model").selectOption("o3-mini")
  await shot(page, "s43-01-watch-form")
  // A watch on a path needs no confirm.
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-confirm")).toHaveCount(0)
  const card = page.getByTestId("routine-card")
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("Checks every 5 minutes")
  await expect(page.getByTestId("routine-next-check")).toBeVisible()
  await expect(page.getByTestId("routine-next")).toHaveCount(0)
  const cardText = (await card.allInnerTexts()).join(" ").replace(/\n/g, " | ")
  report.push(`1. Saved a watch on ${folder}: "${cardText}"`)

  // 2. The first check keeps the result and makes no task. Then a new file runs the routine.
  await page.waitForTimeout(1500)
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-empty")).toBeVisible()
  writeFileSync(join(folder, "new-report.txt"), "new")
  await expect(page.getByTestId("tasks-table")).toContainText("Done", { timeout: 20_000 })
  const runs = lastMessages(mock.requests)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.model).toBe("o3-mini")
  expect(runs[0]?.text).toContain("Sort the new files.")
  expect(runs[0]?.text).toContain("Added: new-report.txt")
  expect(runs[0]?.text).toContain("comes from outside")
  report.push(
    `2. First check: no task. New file: one run with model ${runs[0]?.model}; it got:`,
    "",
    "```",
    runs[0]?.text ?? "",
    "```",
    "",
  )
  await shot(page, "s43-02-run-task")

  // 3. The next check sees no change: one muted line in the chat of the agent, no task.
  await page.getByTestId("page-chats").click()
  await page.locator("[data-testid^=place-agent-]").first().click()
  await expect(page.getByTestId("note-line").first()).toContainText(
    "Inbox watch: checked, nothing changed.",
    { timeout: 20_000 },
  )
  expect(lastMessages(mock.requests)).toHaveLength(1)
  await shot(page, "s43-03-muted-line")
  report.push("3. Next check with no change: a muted line, and no new request to the model.")

  // 4. A watch on a command needs the confirm, which shows the full command.
  await page.getByTestId("page-routines").click()
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Missing file")
  await page.getByTestId("routine-prompt").fill("Tell me when it shows.")
  await page.getByTestId("routine-trigger").selectOption("watch")
  await page.getByTestId("routine-watch-kind").selectOption("command")
  await page.getByTestId("routine-watch-command").fill("cat missing.txt")
  await page.getByTestId("routine-save").click()
  const confirm = page.getByTestId("routine-confirm")
  await expect(confirm).toBeVisible()
  await expect(page.getByTestId("routine-confirm-target")).toHaveText("cat missing.txt")
  await expect(confirm).toContainText("with no question")
  await shot(page, "s43-04-confirm")
  await page.getByTestId("routine-confirm-ok").click()
  await expect(card).toHaveCount(2)
  report.push("4. A command watch showed the confirm with the full command, then saved.")

  // 5. A watch on a path that does not exist fails 3 checks and pauses itself.
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Gone folder")
  await page.getByTestId("routine-prompt").fill("Look.")
  await page.getByTestId("routine-trigger").selectOption("watch")
  await page.getByTestId("routine-watch-interval").selectOption("5")
  await page.getByTestId("routine-watch-path").fill(join(folder, "does-not-exist"))
  // The other watches check while the form is open and change the list. The form keeps what the
  // user typed, and Save stays on. (The form was built again at each change and lost its fields.)
  const dialog = page.getByTestId("routine-dialog")
  // A form that is built again is a new element: it loses this mark.
  await dialog.evaluate((el) => el.setAttribute("data-same-form", "yes"))
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const off = window.robot.on("routines.changed", () => {
          off()
          done()
        })
      }),
  )
  await expect(dialog).toHaveAttribute("data-same-form", "yes")
  await expect(page.getByTestId("routine-name")).toHaveValue("Gone folder")
  await expect(page.getByTestId("routine-prompt")).toHaveValue("Look.")
  await expect(page.getByTestId("routine-watch-path")).toHaveValue(join(folder, "does-not-exist"))
  await expect(page.getByTestId("routine-save")).toBeEnabled()
  await page.getByTestId("routine-save").click()
  const gone = card.filter({ hasText: "Gone folder" })
  await expect(gone.getByTestId("routine-paused")).toContainText("Paused after 3 failed runs", {
    timeout: 30_000,
  })
  await expect(gone.getByTestId("routine-paused")).toContainText("The path does not exist")
  await expect(gone).toHaveAttribute("data-enabled", "false")
  // The command watch with an exit code that is not 0 has no failure and stays on.
  await expect(card.filter({ hasText: "Missing file" })).toHaveAttribute("data-enabled", "true")
  await shot(page, "s43-05-paused")
  report.push("5. A missing path failed 3 checks: the routine shows 'Paused after 3 failed runs'.")

  // 6. The calendar shows the run and the failed checks with the reason, and no future runs.
  await page.getByTestId("routine-view").getByText("Week").click()
  await expect(page.locator("[data-testid=calendar-entry][data-state=done]")).toHaveCount(1)
  await expect(page.locator("[data-testid=calendar-entry][data-state=failed]")).toHaveCount(3)
  await expect(page.locator("[data-testid=calendar-entry][data-state=planned]")).toHaveCount(0)
  await expect(page.getByTestId("calendar-reason").first()).toContainText("The path does not exist")
  await shot(page, "s43-06-calendar")
  report.push("6. Calendar: 1 done run, 3 failed checks with the reason, no planned runs.")

  const reports = resolve(shotsDir, "..", "reports")
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, "s43-watch-routines.md"), `${report.join("\n")}\n`)
  await app.close()
  await mock.close()
})
