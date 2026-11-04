import { mkdirSync, writeFileSync } from "node:fs"
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

// S66: the handbook and the instructions of a channel (spec 002, "Handbook"; spec 004, "Rules";
// spec 013). The model is a stand-in that records each request. The scenario runs once in English
// and once in Korean, at 1100 px wide.

interface Words {
  readonly locale: "en-US" | "ko-KR"
  readonly shots: "en" | "ko"
  readonly section: string
  readonly empty: string
  readonly saved: string
  readonly secret: RegExp
  readonly now: string
  readonly sourcePage: string
  readonly sourceRestore: string
  readonly handbookSwitch: string
}
const EN: Words = {
  locale: "en-US",
  shots: "en",
  section: "Handbook",
  empty: "The handbook is empty. No agent gets a handbook.",
  saved: "Saved. It counts from the next turn.",
  secret: /This text looks like a key or a token\./,
  now: "Now",
  sourcePage: "Settings",
  sourceRestore: "Restore",
  handbookSwitch: "Read the handbook",
}
const KO: Words = {
  locale: "ko-KR",
  shots: "ko",
  section: "핸드북",
  empty: "핸드북이 비어 있어요. 어떤 에이전트도 핸드북을 받지 않아요.",
  saved: "저장했어요. 다음 턴부터 적용돼요.",
  secret: /키나 토큰/,
  now: "현재",
  sourcePage: "설정",
  sourceRestore: "복원",
  handbookSwitch: "핸드북 읽기",
}

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

const openHandbook = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-handbook").click()
  await expect(page.getByTestId("handbook-section")).toBeVisible()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toBeHidden()
}
/** Writes a text in the handbook page and saves it. */
const saveHandbook = async (page: Page, text: string) => {
  await page.getByTestId("handbook-text").fill(text)
  await page.getByTestId("handbook-save").click()
  await expect(page.getByTestId("handbook-saved")).toBeVisible()
}

/** The system text of the newest request that the model got. */
const lastSystem = (mock: Awaited<ReturnType<typeof startMockProvider>>) => {
  const chats = mock.requests.filter((r) => r.path === "/v1/chat/completions")
  const body = chats.at(-1)?.body as { messages?: { role: string; content: unknown }[] } | undefined
  return String(body?.messages?.find((m) => m.role === "system")?.content ?? "")
}

/** Sets the profile of the open agent: the instructions and the switch. */
const editAgent = async (page: Page, edit: { instructions?: string; readHandbook?: boolean }) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  if (edit.instructions !== undefined)
    await page.getByTestId("agent-instructions").fill(edit.instructions)
  if (edit.readHandbook !== undefined) {
    const toggle = page.getByTestId("agent-read-handbook")
    if ((await toggle.getAttribute("aria-checked")) !== String(edit.readHandbook))
      await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", String(edit.readHandbook))
  }
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
}

const scenario = (words: Words) => async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const launched: Launched = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: words.locale })
  const { app, page } = launched
  const report = [`# S66 handbook (${words.shots})`, ""]
  try {
    await resizeWindow(app, 1100, 800)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")

    // ---- the page: empty at the start, with the order of the texts and the note on the provider ----
    await openHandbook(page)
    await expect(page.locator("h1")).toHaveText(words.section)
    await expect(page.getByTestId("handbook-text")).toHaveValue("")
    await expect(page.getByTestId("handbook-empty")).toHaveText(words.empty)
    await expect(page.getByTestId("handbook-order")).toBeVisible()
    await expect(page.getByTestId("handbook-sent")).toBeVisible()
    await expect(page.getByTestId("handbook-save")).toBeDisabled()
    await expect(page.getByTestId("handbook-version")).toHaveCount(0)
    await expect(page.getByTestId("handbook-history-empty")).toBeVisible()
    await shot(page, `s66-01-empty-${words.shots}`)
    report.push("1. The page is empty at the start; Save is off; the history is empty.")

    // ---- a save: the text, the counter, the status and the first version ----
    await page.getByTestId("handbook-text").fill("Answer in Korean.")
    await expect(page.getByTestId("handbook-count")).toContainText("17")
    await expect(page.getByTestId("handbook-save")).toBeEnabled()
    await page.getByTestId("handbook-save").click()
    await expect(page.getByTestId("handbook-saved")).toHaveText(words.saved)
    await expect(page.getByTestId("handbook-save")).toBeDisabled()
    await expect(page.getByTestId("handbook-version")).toHaveCount(1)
    await expect(page.getByTestId("handbook-version").first()).toContainText(words.now)
    await expect(page.getByTestId("handbook-version-source").first()).toHaveText(words.sourcePage)
    await shot(page, `s66-02-saved-${words.shots}`)
    report.push("2. A save gives one version, marked as the current one, from the page.")

    // ---- a text that looks like a secret is refused, with the reason, and nothing changes ----
    await page
      .getByTestId("handbook-text")
      .fill("Use sk-abcdefghijklmnopqrstuvwxyz0123 to call it.")
    await page.getByTestId("handbook-save").click()
    await expect(page.getByTestId("handbook-error")).toContainText(words.secret)
    await expect(page.getByTestId("handbook-version")).toHaveCount(1)
    await shot(page, `s66-03-secret-${words.shots}`)
    report.push(
      "3. A key in the text is refused on save, with the reason; the history is the same.",
    )
    await page.getByTestId("handbook-text").fill("Answer in Korean.")
    await closeSettings(page)

    // ---- the agent: the handbook comes first, then the own instructions ----
    await editAgent(page, { instructions: "Be brief." })
    await send(page, "hello")
    await settled(page)
    const first = lastSystem(mock)
    expect(first).toContain("Answer in Korean.")
    expect(first).toContain("Be brief.")
    expect(first.indexOf("Answer in Korean.")).toBeLessThan(first.indexOf("Be brief."))
    report.push(
      "4. The first turn after the save: the handbook text stands before the instructions.",
    )

    // ---- the switch: off, the next turn does not get the handbook ----
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("agent-profile")).toBeVisible()
    await expect(page.getByTestId("agent-read-handbook")).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("agent-profile")).toContainText(words.handbookSwitch)
    await shot(page, `s66-04-profile-switch-${words.shots}`)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("agent-profile")).toBeHidden()
    await editAgent(page, { readHandbook: false })
    await send(page, "again")
    await settled(page)
    const off = lastSystem(mock)
    expect(off).not.toContain("Answer in Korean.")
    expect(off).toContain("Be brief.")
    await editAgent(page, { readHandbook: true })
    report.push("5. With the switch off the next turn has the instructions and no handbook.")

    // ---- three changes and a restore: the first text is back, and the history has a new version ----
    await openHandbook(page)
    await saveHandbook(page, "Second text.")
    await expect(page.getByTestId("handbook-version")).toHaveCount(2)
    await saveHandbook(page, "Third text.")
    await expect(page.getByTestId("handbook-version")).toHaveCount(3)
    await expect(page.getByTestId("handbook-version-restore")).toHaveCount(2)
    await page.getByTestId("handbook-version").last().getByTestId("handbook-version-open").click()
    await expect(page.getByTestId("handbook-version-text")).toHaveText("Answer in Korean.")
    await shot(page, `s66-05-history-${words.shots}`)
    await page
      .getByTestId("handbook-version")
      .last()
      .getByTestId("handbook-version-restore")
      .click()
    await expect(page.getByTestId("handbook-version")).toHaveCount(4)
    await expect(page.getByTestId("handbook-text")).toHaveValue("Answer in Korean.")
    await expect(page.getByTestId("handbook-version").first()).toHaveAttribute(
      "data-source",
      "restore",
    )
    await expect(page.getByTestId("handbook-version-source").first()).toHaveText(
      words.sourceRestore,
    )
    await shot(page, `s66-06-restored-${words.shots}`)
    report.push(
      "6. A restore of the first version is a new version; the page shows the first text.",
    )

    // ---- an empty handbook gives nothing to any agent ----
    await saveHandbook(page, "")
    await expect(page.getByTestId("handbook-empty")).toBeVisible()
    await closeSettings(page)
    await send(page, "third")
    await settled(page)
    expect(lastSystem(mock)).not.toContain("Answer in Korean.")
    report.push("7. After the text is cleared no agent gets a handbook.")

    // ---- the instructions of a channel: after the instructions of the agent ----
    await openHandbook(page)
    await saveHandbook(page, "Answer in Korean.")
    await closeSettings(page)
    await page.getByTestId("new-channel").click()
    await page.getByTestId("channel-name").fill("Launch")
    await page.getByTestId("channel-member-Ada").check()
    await page.getByTestId("channel-lead").selectOption({ label: "Ada" })
    await page.getByTestId("channel-instructions").fill("Write the answer as a list.")
    await expect(page.getByTestId("channel-instructions-count")).toContainText("27")
    await shot(page, `s66-07-channel-field-${words.shots}`)
    await page.getByTestId("channel-submit").click()
    await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
    await page.getByTestId("channel-input").fill("@Ada write it")
    await page.getByTestId("channel-input").press("Enter")
    await expect
      .poll(() => lastSystem(mock), { timeout: 20_000 })
      .toContain("Write the answer as a list.")
    const inChannel = lastSystem(mock)
    expect(inChannel.indexOf("Answer in Korean.")).toBeGreaterThanOrEqual(0)
    expect(inChannel.indexOf("Answer in Korean.")).toBeLessThan(inChannel.indexOf("Be brief."))
    expect(inChannel.indexOf("Be brief.")).toBeLessThan(
      inChannel.indexOf("Write the answer as a list."),
    )
    report.push(
      "8. In a channel: handbook, then the instructions of the agent, then those of the channel.",
    )
  } finally {
    writeReport(`s66-handbook-${words.shots}`, report)
    await app.close()
    await mock.close()
  }
}

test(
  "handbook: the page, the history, the switch and the channel instructions (English)",
  scenario(EN),
)
test(
  "handbook: the page, the history, the switch and the channel instructions (Korean)",
  scenario(KO),
)
