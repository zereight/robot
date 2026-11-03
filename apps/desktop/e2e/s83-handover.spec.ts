import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, type RecordedRequest, startMockProvider } from "./mock-provider.ts"

// Spec 003, "Hand over" (S83): the menu choice and its reasons, the dialog, the brief, the new
// thread with the card, the muted line, the links, the marks, and the source "Handover" (005).

const KEY = "sk-e2e-handover-0123456789abcdef"
// The output of a command and the content of a file that a tool read must not reach the brief. The
// text of the user and the arguments of a tool are no output, so the words below come from a tool
// only: the command prints them in two parts, and the key file holds the last one.
const OUTPUT = "OUTPUT-E2E-MUST-NOT-LEAK"
const KEY_FILE = "stand-in key"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
const tools = (...calls: { name: string; args: unknown }[]) => `TOOLS ${JSON.stringify(calls)}`
const chatRequests = (requests: readonly RecordedRequest[]) =>
  requests.filter((r) => r.path === "/v1/chat/completions")
const openPlace = (page: Page, name: string) =>
  page.locator("[data-place-row]").filter({ hasText: name }).first().click()
const openMenu = async (page: Page) => {
  await page.getByTestId("chat-header-menu").click()
  await expect(page.getByTestId("chat-menu-handover")).toBeVisible()
}
const closeMenu = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.locator("[role=menu]")).toHaveCount(0)
}
const openThreads = async (page: Page) => {
  await page.getByTestId("thread-list").click()
  await expect(page.getByTestId("thread-menu")).toBeVisible()
}

/**
 * Opens the thread of the open agent whose card has (or has not) a link back. The list has no fixed
 * order for two threads with the same title, so the test reads the card of each thread.
 */
const openHandoverThread = async (page: Page, link: "true" | "false") => {
  await openThreads(page)
  const total = await page.getByTestId("thread-item").count()
  await closeMenu(page)
  for (let i = 0; i < total; i++) {
    await openThreads(page)
    await page.getByTestId("thread-item").nth(i).click()
    const from = page.getByTestId("handover-card-from")
    await expect(from).toBeVisible()
    // The link shows a moment after the list of threads has loaded.
    const live = await expect(from)
      .toHaveAttribute("data-link", "true", { timeout: 1500 })
      .then(
        () => true,
        () => false,
      )
    if (live === (link === "true")) return
  }
  throw new Error(`No thread with a card whose link is ${link}`)
}

/** A test home folder with a stand-in key. The app uses it instead of the home of the user. */
const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "robot-e2e-home-"))
  mkdirSync(join(home, ".ssh"), { recursive: true })
  writeFileSync(join(home, ".ssh", "id_test"), KEY_FILE)
  return home
}

/** A second agent with a role line, so that the dialog has a role to show. */
const createAgentWithRole = async (page: Page, name: string, role: string) => {
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill(name)
  await page.getByTestId("agent-role").fill(role)
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: name }).waitFor()
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
}

/** Lets the agent of the open chat use its tools with no question (Full access). */
const fullAccess = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("agent-permission").getByText("Full access").click()
  await page.getByTestId("full-access-use").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
}

test("hand over: reasons, dialog, brief, new thread, card, line, links, marks, source and plain text", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const home = makeHome()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_HOME: home,
  })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgentWithRole(page, "Ben", "Writes the tests")
  const report: string[] = ["# S83 handover of a chat", ""]

  // --- Ada: a chat with a file, commands, a key in a command, and a read of a place with keys.
  await openPlace(page, "Ada")
  await expect(page.getByTestId("chat-start")).toContainText("Ada")

  // 1. A chat with no message of the user: Hand over is off, with the reason in words.
  await openMenu(page)
  await expect(page.getByTestId("chat-menu-handover")).toBeDisabled()
  await expect(page.getByTestId("chat-menu-handover-reason")).toHaveText(
    "Hand over is off: this chat has no message of yours.",
  )
  await shot(page, "s83-01-off-no-message")
  report.push("1. No message of the user: Hand over is off. The menu says:")
  report.push(`   ${(await page.getByTestId("chat-menu-handover-reason").textContent()) ?? ""}`)
  await closeMenu(page)

  await fullAccess(page)
  // The brief quotes the first and the latest request. The mock model runs a "TOOLS" marker that it
  // reads in the last message, so the marker is in a message in the middle: the brief does not
  // quote it, and the model of Ben does not run the tools again.
  await send(page, "Fix the build.")
  await settled(page)
  await send(
    page,
    `Write the notes and read the key. ${tools(
      { name: "write_file", args: { path: "notes.md", content: "# notes" } },
      { name: "run_command", args: { command: "printf %s%s OUTPUT -E2E-MUST-NOT-LEAK" } },
      { name: "run_command", args: { command: `echo ${KEY}` } },
      { name: "read_file", args: { path: join(home, ".ssh", "id_test") } },
    )}`,
  )
  await settled(page)
  await expect(page.getByTestId("place-marks")).toContainText("Holds a sensitive read")

  // 2. A turn runs: Hand over is off, with the reason.
  await send(page, "please go slow")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await openMenu(page)
  await expect(page.getByTestId("chat-menu-handover")).toBeDisabled()
  await expect(page.getByTestId("chat-menu-handover-reason")).toHaveText(
    "Hand over is off while a turn of this chat runs.",
  )
  await shot(page, "s83-02-off-turn-runs")
  report.push("2. A turn runs: Hand over is off. The menu says:")
  report.push(`   ${(await page.getByTestId("chat-menu-handover-reason").textContent()) ?? ""}`)
  await closeMenu(page)
  await settled(page)
  await expect(page.getByTestId("composer-send")).toBeVisible()

  // 3. The dialog: the agent with face, name and role; the required field; the brief, folded.
  await openMenu(page)
  await expect(page.getByTestId("chat-menu-handover")).toBeEnabled()
  await expect(page.getByTestId("chat-menu-handover-reason")).toHaveCount(0)
  await page.getByTestId("chat-menu-handover").click()
  const dialog = page.getByTestId("handover-dialog")
  await expect(dialog).toBeVisible()
  const agents = dialog.getByTestId("handover-agent")
  await expect(agents).toHaveCount(1)
  await expect(agents.first()).toContainText("Ben")
  await expect(agents.first()).toContainText("Writes the tests")
  await expect(agents.first().locator("svg").first()).toBeVisible()
  await expect(dialog.getByText("What should Ben do next?")).toBeVisible()
  const submit = dialog.getByTestId("handover-submit")
  await expect(submit).toBeDisabled()
  await expect(dialog.getByTestId("handover-brief")).toBeHidden()
  await shot(page, "s83-03-dialog")
  await dialog.getByText("Show the brief").click()
  const brief = dialog.getByTestId("handover-brief")
  await expect(brief).toBeVisible()
  await shot(page, "s83-04-dialog-brief")
  const briefText = (await brief.textContent()) ?? ""
  // The brief holds the names, the requests, the last reply, the file and the commands.
  expect(briefText).toContain("Handover from Ada")
  expect(briefText).toContain("First request:\nFix the build.")
  // The latest request is the last message of the user: the one that started the slow turn.
  expect(briefText).toContain("Latest request:\nplease go slow")
  expect(briefText).toContain("Last reply of Ada")
  expect(briefText).toContain("notes.md")
  expect(briefText).toContain("printf")
  expect(briefText).toContain("[redacted]")
  // It holds no key, no thinking, no output of a tool, no content of a file.
  for (const leak of [OUTPUT, KEY_FILE]) expect(briefText).not.toContain(leak)
  // The key in the command is cut by the redaction.
  expect(briefText).not.toContain(KEY)
  report.push("3. The dialog lists Ben with his face and role. The brief, in full:", "", briefText)
  // The brief cannot be edited.
  await expect(brief).not.toHaveAttribute("contenteditable", "true")
  expect(await brief.evaluate((el) => el.tagName)).toBe("PRE")

  // 4. Cancel changes nothing.
  await dialog.getByTestId("handover-cancel").click()
  await expect(dialog).toBeHidden()
  await openPlace(page, "Ben")
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")
  await openPlace(page, "Ada")
  await expect(page.getByTestId("handed-over-line")).toHaveCount(0)

  // 5. Hand over: the window opens the new thread of Ben. The card comes first, then the text.
  await openMenu(page)
  await page.getByTestId("chat-menu-handover").click()
  await dialog.getByTestId("handover-text").fill("Finish the tests")
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Ben")
  await expect(page.getByTestId("thread-current")).toHaveText("Handover from Ada")
  const card = page.getByTestId("handover-card")
  await expect(card).toBeVisible()
  await expect(card.getByTestId("handover-card-from")).toHaveText("From Ada")
  await expect(card.getByTestId("handover-card-from")).toHaveAttribute("data-link", "true")
  // The card is folded; opening it shows the brief.
  await expect(card.getByTestId("handover-card-brief")).toBeHidden()
  const rows = page.locator("[data-testid=message], [data-testid=handover-card]")
  await expect(rows.first()).toHaveAttribute("data-testid", "handover-card")
  await expect(rows.nth(1)).toContainText("Finish the tests")
  await expect(rows.nth(1)).toHaveAttribute("data-author", "user")
  await expect(rows.nth(2)).toHaveAttribute("data-author", "agent")
  await settled(page)
  await shot(page, "s83-05-new-thread")
  await card.locator("summary").click()
  await expect(card.getByTestId("handover-card-brief")).toContainText("Handover from Ada")
  await shot(page, "s83-06-card-open")
  report.push("5. The new thread of Ben is titled 'Handover from Ada'. The card shows 'From Ada'.")

  // 6. The first request of the model of Ben holds the card and the text, and no tool output.
  const toBen = chatRequests(mock.requests).find((r) =>
    JSON.stringify(r.body).includes("Information from a colleague"),
  )
  if (!toBen) throw new Error("The model of Ben got no card")
  const body = JSON.stringify(toBen.body)
  // Turns of the user with no answer between them can be one turn for the model.
  const sent = toBen.body as { messages?: { role: string; content: unknown }[] }
  const turn = (sent.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => String(m.content))
    .join("\n")
  expect(turn).toContain("not an order")
  expect(turn).toContain("notes.md")
  expect(turn.endsWith("Finish the tests")).toBe(true)
  for (const leak of [KEY, OUTPUT, KEY_FILE]) expect(body).not.toContain(leak)
  report.push("6. The request to the model of Ben holds the card and the text, and no output.")

  // 7. The new thread holds the marks of the place it came from. The main thread of Ben holds none.
  const marks = page.getByTestId("place-marks")
  await expect(marks).toContainText("Holds a sensitive read")
  await expect(page.getByTestId("place-mark-first")).toContainText("First place: Keys")
  await openThreads(page)
  await page.getByTestId("thread-main").click()
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")
  await expect(page.getByTestId("place-marks")).toHaveCount(0)
  await openThreads(page)
  await page.getByTestId("thread-item").filter({ hasText: "Handover from Ada" }).click()
  await expect(page.getByTestId("place-marks")).toContainText("Holds a sensitive read")
  report.push(
    "7. The header line of the new thread shows 'Holds a sensitive read'. Main thread: none.",
  )

  // 8. Back to Ada by the link of the card.
  await page.getByTestId("handover-card-from").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Ada")
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")

  // 9. The first chat shows the muted line with a link to the new thread. Nothing else changed.
  const line = page.getByTestId("handed-over-line")
  await expect(line).toHaveCount(1)
  await expect(line).toContainText("Handed over to Ben")
  await expect(page.getByTestId("handover-line-link")).toHaveAttribute("data-link", "true")
  await shot(page, "s83-07-first-chat-line")
  report.push("9. The chat of Ada shows: 'Handed over to Ben', with a link.")
  await page.getByTestId("handover-line-link").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Ben")
  await expect(page.getByTestId("thread-current")).toHaveText("Handover from Ada")

  // 10. The Tasks page lists the task of Ben with the source "Handover", and filters by it.
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("tasks-filter-source").selectOption("handover")
  const taskRows = page.getByTestId("task-row")
  await expect(taskRows).toHaveCount(1)
  await expect(taskRows.first()).toContainText("Ben")
  await expect(taskRows.first()).toContainText("Handover")
  await expect(taskRows.first()).toContainText("Finish the tests")
  await shot(page, "s83-08-tasks-source")
  await taskRows.first().getByTestId("task-open").click()
  await expect(page.getByTestId("task-detail")).toContainText("Handover")
  await shot(page, "s83-09-task-view")
  // "Open source place" opens the new thread.
  await page.getByTestId("task-open-source").click()
  await expect(page.getByTestId("thread-current")).toHaveText("Handover from Ada")
  report.push("10. The Tasks page lists the task of Ben with the source 'Handover'.")

  // 11. A handover from a thread of Ada, then delete that thread: the card of the new thread
  // shows "From Ada" as plain text, because its other side is gone (spec 003, "Flows" 4).
  await openPlace(page, "Ada")
  await openThreads(page)
  await page.getByTestId("thread-create").click()
  await expect(page.getByTestId("thread-current")).toHaveText("New thread")
  await send(page, "Plan the trip")
  await settled(page)
  await openMenu(page)
  await page.getByTestId("chat-menu-handover").click()
  await dialog.getByTestId("handover-text").fill("Book the trip")
  await dialog.getByTestId("handover-submit").click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Ben")
  await settled(page)
  await expect(page.getByTestId("thread-current")).toHaveText("Handover from Ada")
  await expect(page.getByTestId("handover-card-from")).toHaveAttribute("data-link", "true")
  await openPlace(page, "Ada")
  await expect(page.getByTestId("thread-current")).toHaveText("Plan the trip")
  await expect(page.getByTestId("handed-over-line")).toContainText("Handed over to Ben")
  await openThreads(page)
  await page.getByTestId("thread-delete").click()
  await page.getByTestId("thread-delete-confirm").click()
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")
  await openPlace(page, "Ben")
  await openHandoverThread(page, "false")
  await expect(page.getByTestId("handover-card-from")).toHaveText("From Ada")
  await expect(page.getByTestId("handover-card").getByRole("button")).toHaveCount(0)
  await shot(page, "s83-10-plain-text")
  report.push("11. Delete the first thread: the card of the new thread shows 'From Ada' as text.")

  // 12. Delete the new thread of the first handover: the line in the chat of Ada is text too.
  await openHandoverThread(page, "true")
  await openThreads(page)
  await page.getByTestId("thread-delete").click()
  await page.getByTestId("thread-delete-confirm").click()
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")
  await openPlace(page, "Ada")
  await expect(page.getByTestId("thread-current")).toHaveText("Main thread")
  await expect(page.getByTestId("handover-line-link")).toHaveAttribute("data-link", "false")
  await expect(page.getByTestId("handed-over-line")).toContainText("Handed over to Ben")
  await shot(page, "s83-11-line-plain-text")
  report.push("12. Delete the new thread: the line in the chat of Ada shows as text.")

  const reports = resolve(shotsDir, "..", "reports")
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, "s83-handover.md"), `${report.join("\n")}\n`)
  await app.close()
  await mock.close()
})

test("hand over in Korean: the dialog, the card and the line", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgentWithRole(page, "Ben", "테스트를 써요")
  await openPlace(page, "Ada")
  await send(page, "빌드를 고쳐 주세요")
  await settled(page)

  await page.getByTestId("chat-header-menu").click()
  await expect(page.getByTestId("chat-menu-handover")).toHaveText("인계하기")
  await page.getByTestId("chat-menu-handover").click()
  const dialog = page.getByTestId("handover-dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("handover-agent")).toContainText("Ben")
  await expect(dialog.getByText("Ben이(가) 다음에 무엇을 해야 하나요?")).toBeVisible()
  await dialog.getByText("인계 요약 보기").click()
  await expect(dialog.getByTestId("handover-brief")).toContainText("Ada에게서 인계")
  await shot(page, "s83-ko-01-dialog")
  await dialog.getByTestId("handover-text").fill("테스트를 끝내 주세요")
  await dialog.getByTestId("handover-submit").click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("thread-current")).toHaveText("Ada에게서 인계")
  await expect(page.getByTestId("handover-card-from")).toHaveText("Ada에게서")
  await settled(page)
  await shot(page, "s83-ko-02-new-thread")
  await page.getByTestId("handover-card-from").click()
  await expect(page.getByTestId("handed-over-line")).toContainText("Ben에게 인계함")
  await shot(page, "s83-ko-03-first-chat")

  await app.close()
  await mock.close()
})
