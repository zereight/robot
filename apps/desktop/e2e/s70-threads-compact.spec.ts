import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, type RecordedRequest, startMockProvider } from "./mock-provider.ts"

// Spec 003: threads, fork, the context meter, Compact and the automatic compact (S20, S70).

const messages = (page: Page) => page.getByTestId("message")
const agentMessages = (page: Page) => page.locator("[data-testid=message][data-author=agent]")
const compactedRows = (page: Page) => page.getByTestId("message-compacted")
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
/** Sends a message and waits until the reply has ended. */
const turn = async (page: Page, text: string) => {
  const before = await agentMessages(page).count()
  await send(page, text)
  await expect(agentMessages(page)).toHaveCount(before + 1)
  await expect(agentMessages(page).last()).toContainText(`You said: ${text}`)
  await settled(page)
}
const openThreads = async (page: Page) => {
  await page.getByTestId("thread-list").click()
  await expect(page.getByTestId("thread-menu")).toBeVisible()
}
const closeMenu = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.locator("[role=menu]")).toHaveCount(0)
}
const chatRequests = (requests: readonly RecordedRequest[]) =>
  requests.filter((r) => r.path === "/v1/chat/completions")
const isSummary = (r: RecordedRequest) => JSON.stringify(r.body).includes("You write the summary")

const start = async (contextSize?: number) => {
  const mock = await startMockProvider(contextSize ? { contextSize } : {})
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  return { mock, app, page }
}

test("threads: start a thread, its title, fork, and delete", async () => {
  test.setTimeout(120_000)
  const { mock, app, page } = await start()
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")

  // A chat of eight messages.
  for (const text of ["m one", "m two", "m three", "m four"]) await turn(page, text)
  await expect(messages(page)).toHaveCount(8)

  // Fork at the third message: the new thread has three messages, the original has eight.
  const third = messages(page).nth(2)
  await third.hover()
  await third.getByTestId("action-fork").click()
  await expect(page.getByTestId("thread-current")).not.toHaveText("Main thread")
  await expect(messages(page)).toHaveCount(3)
  await expect(messages(page).nth(2)).toContainText("m two")
  await openThreads(page)
  await page.getByTestId("thread-main").click()
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")
  await expect(messages(page)).toHaveCount(8)

  // Start a thread and send a message in it: the list shows the main thread and the new thread,
  // titled with the first line of the message.
  await openThreads(page)
  await page.getByTestId("thread-create").click()
  await expect(page.getByTestId("thread-current")).toHaveText("New thread")
  await expect(messages(page)).toHaveCount(0)
  await turn(page, "Plan the trip")
  await expect(page.getByTestId("thread-current")).toHaveText("Plan the trip")
  await openThreads(page)
  await expect(page.getByTestId("thread-main")).toBeVisible()
  await expect(page.getByTestId("thread-item").filter({ hasText: "Plan the trip" })).toBeVisible()
  await shot(page, "s70-01-threads")
  await closeMenu(page)

  // Delete a thread that has a running turn: the control is off, and the menu says why.
  await send(page, "please go slow")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await openThreads(page)
  await expect(page.getByTestId("thread-delete")).toBeDisabled()
  await expect(page.getByTestId("thread-busy")).toHaveText("The agent works in this thread now.")
  await closeMenu(page)
  await settled(page)
  await expect(page.getByTestId("composer-send")).toBeVisible()

  // When the turn has ended, Delete asks first, then the main thread shows.
  await openThreads(page)
  await expect(page.getByTestId("thread-delete")).toBeEnabled()
  await page.getByTestId("thread-delete").click()
  await expect(page.getByTestId("thread-delete-dialog")).toBeVisible()
  await page.getByTestId("thread-delete-confirm").click()
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")
  await openThreads(page)
  await expect(page.getByTestId("thread-item").filter({ hasText: "Plan the trip" })).toHaveCount(0)
  await closeMenu(page)

  await app.close()
  await mock.close()
})

test("compact: the line Compacted, its summary, the reason when off, and the automatic compact", async () => {
  test.setTimeout(150_000)
  const { mock, app, page } = await start()
  const meter = page.getByTestId("context-meter")

  // Compact in a chat of 2 turns is off, with a reason.
  await turn(page, "turn one")
  await turn(page, "turn two")
  await meter.click()
  await expect(page.getByTestId("compact")).toBeDisabled()
  await expect(page.getByTestId("compact-off")).toHaveText(
    "Compact is off: the conversation has 2 turns or fewer.",
  )
  await closeMenu(page)

  // Compact in a chat of six turns: the line "Compacted" shows between turn 4 and turn 5, and the
  // chat still shows all six turns.
  for (const text of ["turn three", "turn four", "turn five", "turn six"]) await turn(page, text)
  await meter.click()
  await page.getByTestId("compact").click()
  await expect(compactedRows(page)).toHaveCount(1)
  await expect(messages(page)).toHaveCount(12)
  const rows = page.locator("[data-testid=message], [data-testid=message-compacted]")
  await expect(rows.nth(8)).toHaveAttribute("data-testid", "message-compacted")
  await expect(rows.nth(9)).toContainText("turn five")
  await expect(compactedRows(page).locator("summary")).toHaveText("Compacted")
  await expect(compactedRows(page).getByTestId("compacted-summary")).toBeHidden()

  // Open the line: the summary shows.
  await compactedRows(page).locator("summary").click()
  await expect(compactedRows(page).getByTestId("compacted-summary")).toBeVisible()
  await expect(compactedRows(page).getByTestId("compacted-summary")).toHaveText(
    "Summary of 8 messages",
  )
  await shot(page, "s70-02-compacted")

  // The ring is empty until the next reply. The model then gets the summary and the newest 2 turns.
  await expect(meter).toHaveAttribute("data-used", "")
  const sentBefore = chatRequests(mock.requests).length
  await turn(page, "turn seven long summary")
  await expect(meter).toHaveAttribute("data-used", "30")
  const next = chatRequests(mock.requests)
    .slice(sentBefore)
    .find((r) => !isSummary(r))
  const body = JSON.stringify(next?.body)
  expect(body).toContain("Summary of 8 messages")
  expect(body).toContain("turn five")
  expect(body).toContain("turn six")
  expect(body).not.toContain("turn four")

  // Automatic compact: the provider reports 91 percent after a reply. The next message shows
  // "Compacting…" first, with an empty ring, then the turn goes on.
  await turn(page, "fill context")
  await expect(meter).toHaveAttribute("data-level", "high")
  await send(page, "after the compact")
  await expect(page.getByTestId("working-line")).toContainText("Compacting…")
  await expect(meter).toHaveAttribute("data-used", "")
  await shot(page, "s70-03-compacting")
  await expect(agentMessages(page).last()).toContainText("You said: after the compact")
  await settled(page)
  await expect(compactedRows(page)).toHaveCount(2)
  await expect(compactedRows(page).last().locator("summary")).toHaveText("Compacted automatically")

  // Turn the setting off: the same message starts the turn at once.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-auto-compact").click()
  await expect(page.getByTestId("setting-auto-compact")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()
  await turn(page, "fill context")
  await expect(meter).toHaveAttribute("data-level", "high")
  const summaries = chatRequests(mock.requests).filter(isSummary).length
  await turn(page, "after the compact")
  await expect(compactedRows(page)).toHaveCount(2)
  expect(chatRequests(mock.requests).filter(isSummary).length).toBe(summaries)

  await app.close()
  await mock.close()
})

test("compact: a failed summary leaves a muted line, and no new try for 5 turns", async () => {
  test.setTimeout(120_000)
  const { mock, app, page } = await start()
  await turn(page, "summary fails here")
  await turn(page, "fill context")
  await turn(page, "go on")

  // The turn went on, and a muted line gives the reason.
  await expect(page.getByTestId("compact-failed")).toHaveCount(1)
  await expect(page.getByTestId("compact-failed")).toContainText("The compact failed")
  await expect(compactedRows(page)).toHaveCount(0)
  await shot(page, "s70-04-compact-failed")

  // The next turns start with no new try.
  const summaries = chatRequests(mock.requests).filter(isSummary).length
  expect(summaries).toBe(1)
  await turn(page, "fill context")
  await turn(page, "and on")
  expect(chatRequests(mock.requests).filter(isSummary).length).toBe(1)
  await expect(page.getByTestId("compact-failed")).toHaveCount(1)

  await app.close()
  await mock.close()
})

test("automatic compact at 400000 tokens of a large context, or at 85 percent of a smaller one", async () => {
  test.setTimeout(120_000)
  // A stand-in model of 1000000 tokens.
  const large = await start(1_000_000)
  const meter = large.page.getByTestId("context-meter")
  // "long summary" in an older turn makes the stand-in summary take 2 seconds, so "Compacting…" shows.
  for (const text of ["one long summary", "two"]) await turn(large.page, text)
  // 399999 tokens (40 percent): the next message starts the turn with no compact.
  await turn(large.page, "use 399999")
  await expect(meter).toHaveAttribute("data-used", "399999")
  await expect(meter).not.toHaveAttribute("data-level", "high")
  await turn(large.page, "use 400000")
  await expect(compactedRows(large.page)).toHaveCount(0)
  expect(chatRequests(large.mock.requests).filter(isSummary)).toHaveLength(0)
  // 400000 tokens: the next message shows "Compacting…" first.
  await expect(meter).toHaveAttribute("data-used", "400000")
  await expect(meter).toHaveAttribute("data-level", "high")
  await send(large.page, "after 400000 tokens")
  await expect(large.page.getByTestId("working-line")).toContainText("Compacting…")
  await expect(agentMessages(large.page).last()).toContainText("You said: after 400000 tokens")
  await settled(large.page)
  await expect(compactedRows(large.page)).toHaveCount(1)
  await shot(large.page, "s70-05-compact-at-400000")
  await large.app.close()
  await large.mock.close()

  // A stand-in model of 200000 tokens that reports 170000 tokens (85 percent) compacts first too.
  const mid = await start(200_000)
  for (const text of ["one", "two", "use 170000"]) await turn(mid.page, text)
  await expect(mid.page.getByTestId("context-meter")).toHaveAttribute("data-level", "high")
  await turn(mid.page, "after 85 percent")
  await expect(compactedRows(mid.page)).toHaveCount(1)
  await mid.app.close()
  await mid.mock.close()
})
