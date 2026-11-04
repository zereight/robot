import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// S63: read-only marks (spec 018, "Read-only mark", "Trust read-only marks", "Rules"; spec 007,
// "Rules", "Outside content"). The test program is the small MCP server of fakes/mcp-server.mjs: it
// marks the tool "lookup" as read only and no other tool. The model is a stand-in. The scenario
// runs once in English and once in Korean, at 1100 px wide with the activity panel open.

const SERVER = resolve(import.meta.dirname, "fakes/mcp-server.mjs")

interface Words {
  readonly locale: "en-US" | "ko-KR"
  readonly shots: "en" | "ko"
  readonly mark: string
  readonly trust: string
  readonly hint: RegExp
  readonly card: string
  readonly refusedReadOnly: string
}
const EN: Words = {
  locale: "en-US",
  shots: "en",
  mark: "Read-only mark",
  trust: "Trust read-only marks",
  hint: /The connection sets the mark, and the app cannot check it\. The arguments of the agent still go to the connection\./,
  card: "Read only, as the connection says",
  refusedReadOnly: "Refused: read only",
}
const KO: Words = {
  locale: "ko-KR",
  shots: "ko",
  mark: "읽기 전용 표시",
  trust: "읽기 전용 표시 믿기",
  hint: /표시는 연결이 정해요\. 앱은 표시가 맞는지 확인할 수 없어요\. 에이전트가 쓴 인자는 그대로 연결에 전달돼요\./,
  card: "연결이 알린 대로 읽기 전용",
  refusedReadOnly: "거부됨: 읽기 전용",
}

const tool = (name: string, args: unknown) => `TOOL ${name} ${JSON.stringify(args)}`
const lookup = (word: string) => tool("mcp__notes__lookup", { word })
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })
const reports = resolve(shotsDir, "..", "reports")
const writeReport = (name: string, lines: string[]) => {
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, `${name}.md`), `${lines.join("\n")}\n`)
}
/** What the test program got, as the connection called it. */
const callsIn = (file: string): { tool: string; args: { word?: string } }[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

const openConnections = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-connections").click()
  await expect(page.getByTestId("connections-section")).toBeVisible()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toBeHidden()
}
const rowOf = (page: Page, name: string) =>
  page.locator(`[data-testid=connection-row][data-connection="${name}"]`)

/** Picks a permission level in the profile of the agent: "ask_all", "read_only", "ask_risky". */
const setLevel = async (page: Page, level: string) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("agent-permission").locator(`label[data-value="${level}"]`).click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
}

/** Clears the mark "Holds outside content" of the open chat, after its confirm (spec 007). */
const clearOutside = async (page: Page) => {
  await page.getByTestId("place-marks-clear").click()
  await page.getByTestId("place-marks-confirm").click()
  await expect(page.getByTestId("place-mark-outside")).toHaveCount(0)
}

const scenario = (words: Words) => async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-e2e-readonly-"))
  const home = join(work, "home")
  mkdirSync(home)
  const calls = join(work, "calls.jsonl")
  const launched: Launched = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: words.locale,
    ROBOT_TEST_HOME: home,
  })
  const { app, page } = launched
  const report = [`# S63 read-only marks (${words.shots})`, ""]
  try {
    await resizeWindow(app, 1100, 800)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    // The window is as tight as the spec allows: the chat column and the activity panel side by side.
    await expect(page.getByTestId("activity-panel")).toBeVisible()

    // ---- the form: the Test list shows the mark beside the tool that has it ----
    await openConnections(page)
    await page.getByTestId("connection-add").click()
    await page.getByTestId("connection-name").fill("Notes")
    await page.getByTestId("connection-command").fill(process.execPath)
    await page.getByTestId("connection-args").fill(SERVER)
    await page.getByTestId("connection-env-add").click()
    const line = page.getByTestId("connection-env-line").nth(0)
    await line.getByTestId("connection-env-name").fill("MCP_TEST_CALLS")
    await line.getByTestId("connection-env-value").fill(calls)
    await page.getByTestId("connection-test").click()
    await expect(page.getByTestId("connection-test-result")).toContainText("8")
    const tested = page.getByTestId("connection-test-tool-read-only")
    await expect(tested).toHaveCount(1)
    await expect(tested).toHaveText(words.mark)
    await expect(
      page
        .locator('[data-testid=connection-test-tool][data-tool="lookup"]')
        .getByTestId("connection-test-tool-read-only"),
    ).toHaveCount(1)
    await expect(
      page
        .locator('[data-testid=connection-test-tool][data-tool="echo"]')
        .getByTestId("connection-test-tool-read-only"),
    ).toHaveCount(0)
    await page.getByTestId("connection-test-tools").scrollIntoViewIfNeeded()
    await shot(page, `s63-01-test-list-${words.shots}`)
    report.push("1. The Test list of the form shows the mark beside `lookup` only.")
    await page.getByTestId("connection-confirm").check()
    await page.getByTestId("connection-save").click()
    await expect(page.getByTestId("connection-form-dialog")).toBeHidden()

    // ---- the row: the switch is off by default; the text says what it means; the list has the mark ----
    const row = rowOf(page, "Notes")
    await expect(row).toBeVisible()
    const trust = row.getByTestId("connection-trust-switch")
    await expect(trust).toHaveAttribute("aria-checked", "false")
    await expect(row.getByTestId("connection-trust")).toContainText(words.trust)
    await expect(row.getByTestId("connection-trust-hint")).toHaveText(words.hint)
    await row.getByTestId("connection-tools-summary").click()
    await expect(row.getByTestId("connection-tool-read-only")).toHaveCount(1)
    await expect(
      row
        .locator('[data-testid=connection-tool][data-tool="lookup"]')
        .getByTestId("connection-tool-read-only"),
    ).toHaveText(words.mark)
    await shot(page, `s63-02-row-switch-off-${words.shots}`)
    report.push("2. The row has the switch, off, with the text; the tool list shows the mark.")
    await closeSettings(page)

    // ---- the switch is off: a call of the marked tool asks as any tool does ----
    await send(page, lookup("tea"))
    const ask = page.getByTestId("ask-card")
    await expect(ask).toBeVisible({ timeout: 15_000 })
    await expect(ask).toContainText("Notes · lookup")
    await expect(page.getByTestId("tool-read-only-trusted")).toHaveCount(0)
    expect(callsIn(calls)).toHaveLength(0)
    await shot(page, `s63-03-card-switch-off-${words.shots}`)
    await page.getByTestId("ask-deny").click()
    await settled(page)
    // The call did not run, so no outside text reached the agent.
    await expect(page.getByTestId("place-mark-outside")).toHaveCount(0)
    report.push("3. With the switch off the call asked (Notes · lookup). It was denied.")

    // ---- the switch is on: the call runs with no card, and the tool card says why ----
    await openConnections(page)
    await trust.click()
    await expect(trust).toHaveAttribute("aria-checked", "true")
    await shot(page, `s63-04-row-switch-on-${words.shots}`)
    await closeSettings(page)
    await send(page, lookup("tea"))
    await settled(page)
    await expect(page.getByTestId("ask-card")).toHaveCount(0)
    await expect(page.getByTestId("tool-read-only-trusted")).toHaveText(words.card)
    expect(callsIn(calls)).toEqual([{ tool: "lookup", args: { word: "tea" } }])
    await shot(page, `s63-05-card-read-only-${words.shots}`)
    report.push(
      `4. With the switch on the call ran with no card; the tool card says: ${words.card}`,
    )

    // ---- the result is outside content: the place holds it, so the next call is risky again ----
    await expect(page.getByTestId("place-mark-outside")).toBeVisible()
    await send(page, lookup("coffee"))
    await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("ask-card")).toContainText("Notes · lookup")
    expect(callsIn(calls)).toHaveLength(1)
    await shot(page, `s63-06-asks-after-outside-content-${words.shots}`)
    await page.getByTestId("ask-deny").click()
    await settled(page)
    report.push("5. The result held outside content. The next call of the marked tool asked again.")

    // ---- "Clear" ends the mark: the marked tool runs with no card again ----
    await clearOutside(page)
    await send(page, lookup("coffee"))
    await settled(page)
    await expect(page.getByTestId("ask-card")).toHaveCount(0)
    expect(callsIn(calls).map((c) => c.args.word)).toEqual(["tea", "coffee"])
    report.push("6. After Clear the marked tool ran with no card.")

    // ---- other levels: the mark does not count at "Ask for everything" or "Read only" ----
    await clearOutside(page)
    await setLevel(page, "ask_all")
    await send(page, lookup("milk"))
    await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    expect(callsIn(calls)).toHaveLength(2)
    await page.getByTestId("ask-deny").click()
    await settled(page)
    await setLevel(page, "read_only")
    await send(page, lookup("milk"))
    await settled(page)
    await expect(page.getByTestId("tool-state").last()).toHaveText(words.refusedReadOnly)
    expect(callsIn(calls)).toHaveLength(2)
    await shot(page, `s63-07-read-only-refused-${words.shots}`)
    report.push("7. At Ask for everything it asked. At Read only it was refused. No call went out.")

    // ---- turning the switch off counts at once ----
    await setLevel(page, "ask_risky")
    await openConnections(page)
    await trust.click()
    await expect(trust).toHaveAttribute("aria-checked", "false")
    await closeSettings(page)
    await send(page, lookup("milk"))
    await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await page.getByTestId("ask-deny").click()
    await settled(page)
    expect(callsIn(calls)).toHaveLength(2)
    report.push("8. With the switch off again the marked tool asked again.")
    writeReport(`s63-read-only-marks-${words.shots}`, report)
  } finally {
    await app.close()
    await mock.close()
  }
}

test(
  "read-only marks: the mark in the lists, the switch, the card text and the outside content rule",
  scenario(EN),
)
test("read-only marks: the same in Korean", scenario(KO))
