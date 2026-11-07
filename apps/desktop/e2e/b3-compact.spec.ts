import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  freshUserData,
  launch,
  resizeWindow,
  shot,
  startHangingRun,
} from "./harness.ts"
import { GOOD_KEY, type RecordedRequest, startMockProvider } from "./mock-provider.ts"

// Spec 003: the context meter, Compact and the automatic compact (the old s70, for workflows). The
// model is a stand-in. A message with "use <n>" makes it report n tokens of use.

const en = { ROBOT_SYSTEM_LOCALE: "en-US" }

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

const messages = (page: Page) => page.getByTestId("message")
const replies = (page: Page) => page.locator("[data-testid=message][data-author=assistant]")
const compactedRows = (page: Page) => page.getByTestId("message-compacted")
const meter = (page: Page) => page.getByTestId("context-meter")
const send = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text)
  await page.getByTestId("chat-input").press("Enter")
}
/** Sends a message and waits until its reply has ended. */
const turn = async (page: Page, text: string) => {
  const before = await replies(page).count()
  await send(page, text)
  await expect(replies(page)).toHaveCount(before + 1)
  await expect(replies(page).last()).toContainText(`You said: ${text}`)
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect(page.getByTestId("chat-send")).toBeVisible()
}
const isSummary = (r: RecordedRequest) =>
  JSON.stringify(r.body.messages[0]).includes("You write the summary")
const answerRequests = (requests: readonly RecordedRequest[]) =>
  requests.filter((r) => !isSummary(r))
const summaryRequests = (requests: readonly RecordedRequest[]) => requests.filter(isSummary)

const start = async (contextSize?: number, env: Record<string, string> = en) => {
  const mock = await startMockProvider(contextSize === undefined ? {} : { contextSize })
  const { app, page } = await launch(freshUserData(), env)
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  return { mock, app, page }
}

test("compact by the user: the line Compacted, its summary, the reason when off, /compact", async () => {
  test.setTimeout(150_000)
  const { mock, app, page } = await start(1_000_000)

  // Compact in a chat of 2 turns is off, with a reason.
  await turn(page, "turn one")
  await turn(page, "turn two")
  await meter(page).click()
  await expect(page.getByTestId("compact")).toBeDisabled()
  await expect(page.getByTestId("compact-reason")).toHaveText(
    "Compact is off: the conversation has 2 turns or fewer.",
  )
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("meter-menu")).toHaveCount(0)

  // The same reason shows in the command list, and picking the command does nothing.
  await page.getByTestId("chat-input").fill("/")
  await expect(page.getByTestId("command-option")).toContainText("Compact is off")
  await page.getByTestId("chat-input").press("Enter")
  await expect(compactedRows(page)).toHaveCount(0)
  await page.getByTestId("chat-input").fill("")

  // A chat of six turns: Compact makes the line "Compacted" between turn 4 and turn 5. The chat
  // still shows all six turns.
  for (const text of ["turn three", "turn four", "turn five", "turn six"]) await turn(page, text)
  await expect(messages(page)).toHaveCount(12)
  await meter(page).click()
  await expect(page.getByTestId("compact")).toBeEnabled()
  await shot(page, "b3-01-meter-menu")
  await page.getByTestId("compact").click()
  await expect(compactedRows(page)).toHaveCount(1)
  await expect(messages(page)).toHaveCount(12)
  const rows = page.locator("[data-testid=message], [data-testid=message-compacted]")
  await expect(rows.nth(8)).toHaveAttribute("data-testid", "message-compacted")
  await expect(rows.nth(7)).toContainText("You said: turn four")
  await expect(rows.nth(9)).toContainText("turn five")
  await expect(compactedRows(page).locator("summary")).toHaveText("Compacted")
  await expect(page.getByTestId("compacted-summary")).toBeHidden()

  // Open the line: the summary shows.
  await compactedRows(page).locator("summary").click()
  await expect(page.getByTestId("compacted-summary")).toHaveText("Summary of 8 messages")
  await shot(page, "b3-02-compacted")

  // The ring is empty until the next reply. The model then gets the summary and the newest 2 turns.
  await expect(meter(page)).toHaveAttribute("data-used", "")
  await turn(page, "turn seven")
  await expect(meter(page)).toHaveAttribute("data-used", "15")
  const body = JSON.stringify(answerRequests(mock.requests).at(-1)?.body.messages)
  expect(body).toContain("Summary of 8 messages")
  expect(body).toContain("turn five")
  expect(body).toContain("turn six")
  expect(body).not.toContain("turn four")

  // The command: "/compact" runs Compact at once and the slash text leaves the box.
  await turn(page, "turn eight")
  await page.getByTestId("chat-input").fill("/comp")
  await expect(page.getByTestId("command-option")).toContainText("/compact")
  await expect(page.getByTestId("command-option")).toHaveAttribute("data-off", "false")
  await shot(page, "b3-03-command")
  await page.getByTestId("chat-input").press("Enter")
  await expect(page.getByTestId("chat-input")).toHaveValue("")
  await expect(compactedRows(page)).toHaveCount(2)
  // A word that fits no command opens no command: "/we" lists skills only.
  await page.getByTestId("chat-input").fill("/we")
  await expect(page.getByTestId("command-option")).toHaveCount(0)

  await app.close()
  await mock.close()
})

test("compact during a turn and during a run: off while the turn works, a message waits while it compacts", async () => {
  test.setTimeout(120_000)
  const { mock, app, page } = await start(1_000_000)
  // "long summary" in an older turn makes the stand-in take 2 seconds to write the summary.
  await turn(page, "turn one long summary")
  await turn(page, "turn two")
  await turn(page, "turn three")

  // While a turn of the chat works, Compact is off.
  await send(page, "slow please")
  await expect(page.getByTestId("chat-stop")).toBeVisible()
  await meter(page).click()
  await expect(page.getByTestId("compact")).toBeDisabled()
  await expect(page.getByTestId("compact-reason")).toContainText("Compact is off")
  await page.keyboard.press("Escape")
  await page.getByTestId("chat-stop").click()
  await expect(page.getByTestId("chat-send")).toBeVisible()

  // A run of the workflow works. Compact runs, and the run goes on.
  await startHangingRun(page, { openaiUrl: mock.openaiUrl, key: GOOD_KEY })
  await expect(page.getByTestId("chat-spinner")).toBeVisible()

  // Compact: the working line reads "Compacting…" and Stop shows. A message waits in the queue and
  // goes when the compact ends.
  await meter(page).click()
  await page.getByTestId("compact").click()
  await expect(page.getByTestId("working-line")).toContainText("Compacting…")
  await expect(page.getByTestId("chat-stop")).toBeVisible()
  await expect(meter(page)).toHaveAttribute("data-used", "")
  await shot(page, "b3-04-compacting")
  await send(page, "after the compact")
  await expect(page.getByTestId("queued-message")).toContainText("after the compact")
  await expect(page.getByTestId("queued-now")).toBeVisible()
  await expect(compactedRows(page)).toHaveCount(1)
  await expect(replies(page).last()).toContainText("You said: after the compact")
  await expect(page.getByTestId("queued-message")).toHaveCount(0)
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect(page.getByTestId("chat-spinner")).toBeVisible()

  // Stop ends a compact: it changes nothing and gives no error. Two turns more make a second compact.
  await turn(page, "turn six long summary")
  await turn(page, "turn seven")
  await turn(page, "turn eight")
  await meter(page).click()
  await page.getByTestId("compact").click()
  await expect(page.getByTestId("working-line")).toContainText("Compacting…")
  await page.getByTestId("chat-stop").click()
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect(compactedRows(page)).toHaveCount(1)
  await expect(page.getByTestId("composer-error")).toHaveCount(0)
  expect(summaryRequests(mock.requests).length).toBeGreaterThanOrEqual(2)

  await app.close()
  await mock.close()
})

test("automatic compact: 90 percent shows Compacting… first, and the setting turns it off", async () => {
  test.setTimeout(150_000)
  const { mock, app, page } = await start(1_000_000)
  await turn(page, "turn one long summary")
  await turn(page, "turn two")
  // 400000 tokens: the next message shows "Compacting…" first, with an empty ring.
  await turn(page, "turn three use 400000")
  await expect(meter(page)).toHaveAttribute("data-used", "400000")
  await expect(meter(page)).toHaveAttribute("data-level", "high")
  await send(page, "after the limit")
  await expect(page.getByTestId("working-line")).toContainText("Compacting…")
  await expect(meter(page)).toHaveAttribute("data-used", "")
  await shot(page, "b3-05-auto-compacting")
  await expect(replies(page).last()).toContainText("You said: after the limit")
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect(compactedRows(page)).toHaveCount(1)
  await expect(compactedRows(page)).toHaveAttribute("data-auto", "true")
  await compactedRows(page).locator("summary").click()
  await expect(page.getByTestId("compacted-auto")).toHaveText(
    "The app compacted this chat by itself.",
  )
  // The ring stays empty until the reply, then shows its use.
  await expect(meter(page)).toHaveAttribute("data-used", "15")
  await shot(page, "b3-06-auto-compacted")

  // Turn the setting off: the same kind of message starts the turn at once.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-general").click()
  await page.getByTestId("setting-auto-compact").click()
  await expect(page.getByTestId("setting-auto-compact")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()
  await turn(page, "fill the context use 900000")
  await expect(meter(page)).toHaveAttribute("data-level", "high")
  const summaries = summaryRequests(mock.requests).length
  await turn(page, "after the setting")
  await expect(compactedRows(page)).toHaveCount(1)
  expect(summaryRequests(mock.requests)).toHaveLength(summaries)

  await app.close()
  await mock.close()
})

test("automatic compact: 399999 tokens do not compact, 85 percent of a smaller model does", async () => {
  test.setTimeout(150_000)
  const large = await start(1_000_000)
  await turn(large.page, "turn one")
  await turn(large.page, "turn two")
  await turn(large.page, "turn three use 399999")
  await expect(meter(large.page)).toHaveAttribute("data-used", "399999")
  await expect(meter(large.page)).not.toHaveAttribute("data-level", "high")
  await turn(large.page, "turn four use 400000")
  await expect(compactedRows(large.page)).toHaveCount(0)
  expect(summaryRequests(large.mock.requests)).toHaveLength(0)
  await expect(meter(large.page)).toHaveAttribute("data-level", "high")
  await turn(large.page, "turn five")
  await expect(compactedRows(large.page)).toHaveCount(1)
  await large.app.close()
  await large.mock.close()

  const mid = await start(200_000)
  for (const text of ["turn one", "turn two", "turn three use 170000"]) await turn(mid.page, text)
  await expect(meter(mid.page)).toHaveAttribute("data-level", "high")
  await turn(mid.page, "turn four")
  await expect(compactedRows(mid.page)).toHaveCount(1)
  await mid.app.close()
  await mid.mock.close()
})

test("automatic compact: a failed summary leaves a muted line and no new try for 5 turns", async () => {
  test.setTimeout(150_000)
  const { mock, app, page } = await start(1_000_000)
  await turn(page, "turn one summary fails here use 400000")
  await turn(page, "turn two use 400000")
  // The turn goes on, and a muted line gives the reason.
  await turn(page, "turn three use 400000")
  await expect(page.getByTestId("note-compact_failed")).toHaveCount(1)
  await expect(page.getByTestId("note-compact_failed")).toContainText(
    "The compact failed, and the chat went on without it. The provider returned an error.",
  )
  await expect(page.getByTestId("note-compact_failed")).not.toContainText("{")
  await expect(compactedRows(page)).toHaveCount(0)
  await shot(page, "b3-07-compact-failed")
  expect(summaryRequests(mock.requests)).toHaveLength(1)
  // The next turns start with no new try.
  await turn(page, "turn four use 400000")
  await turn(page, "turn five use 400000")
  expect(summaryRequests(mock.requests)).toHaveLength(1)
  await expect(page.getByTestId("note-compact_failed")).toHaveCount(1)

  await app.close()
  await mock.close()
})

test("stop an automatic compact: the turn ends as stopped, the message stays, the old conversation goes on", async () => {
  test.setTimeout(120_000)
  const { mock, app, page } = await start(1_000_000)
  await turn(page, "turn one long summary")
  await turn(page, "turn two")
  await turn(page, "turn three use 400000")
  await send(page, "turn four")
  await expect(page.getByTestId("working-line")).toContainText("Compacting…")
  await page.getByTestId("chat-stop").click()
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect(page.getByTestId("message-stopped")).toBeVisible()
  await expect(page.getByText("turn four", { exact: true })).toBeVisible()
  await expect(compactedRows(page)).toHaveCount(0)
  await expect(page.getByTestId("note-compact_failed")).toContainText("The compact was stopped.")
  // The stopped turn has no reply, so the model reads its message and the next one together.
  await send(page, "turn five")
  await expect(replies(page).last()).toContainText("You said: turn four")
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  const body = JSON.stringify(answerRequests(mock.requests).at(-1)?.body.messages)
  expect(body).toContain("turn one long summary")
  expect(body).not.toContain("Summary of")
  expect(summaryRequests(mock.requests)).toHaveLength(1)
  await app.close()
  await mock.close()
})

test("the size of the context is not known: the ring says so and Compact is off with a reason", async () => {
  test.setTimeout(90_000)
  // The stand-in lists no context size.
  const { mock, app, page } = await start()
  await turn(page, "turn one")
  await turn(page, "turn two")
  await turn(page, "turn three")
  await expect(meter(page)).toHaveAttribute("data-off", "size_unknown")
  await meter(page).click()
  await expect(page.getByTestId("compact")).toBeDisabled()
  await expect(page.getByTestId("compact-reason")).toHaveText(
    "Compact is off: the size of the context is not known.",
  )
  await page.keyboard.press("Escape")
  await app.close()
  await mock.close()
})

test("Korean: the meter, the line and the working line", async () => {
  test.setTimeout(120_000)
  const { mock, app, page } = await start(1_000_000, { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await turn(page, "하나 long summary")
  await turn(page, "둘")
  await turn(page, "셋 use 400000")
  await meter(page).click()
  await expect(page.getByTestId("compact")).toHaveText("압축")
  await page.keyboard.press("Escape")
  await send(page, "넷")
  await expect(page.getByTestId("working-line")).toContainText("압축하는 중…")
  await shot(page, "b3-08-ko-compacting")
  await expect(compactedRows(page)).toHaveCount(1)
  await expect(compactedRows(page).locator("summary")).toHaveText("압축됨")
  await compactedRows(page).locator("summary").click()
  await expect(page.getByTestId("compacted-auto")).toHaveText("앱이 이 채팅을 자동으로 압축했어요.")
  await shot(page, "b3-09-ko-compacted")
  await app.close()
  await mock.close()
})
