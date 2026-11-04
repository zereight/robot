import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 008, "Channel notes", as one computer shows it, at the smallest window that the spec
// allows: 1100 px wide with the activity panel open. The agent saves a note for a channel with
// the memory tool. The page of the memory of the agent shows the channel of the note, a filter,
// "Not a member", and a move. A turn reads the notes of its own channel only. The delete of a
// channel deletes its notes, and History has a row by "the delete of a channel".

interface Words {
  readonly locale: string
  readonly all: string
  readonly general: string
  readonly itemsTab: string
  readonly historyTab: string
  readonly noteFor: (name: string) => string
  readonly notMember: string
  readonly moved: string
  readonly byDelete: string
}

const WORDS: Record<"en" | "ko", Words> = {
  en: {
    locale: "en-US",
    all: "All",
    general: "General",
    itemsTab: "Items",
    historyTab: "History",
    noteFor: (name) => `Note for ${name}`,
    notMember: "Not a member",
    moved: "Moved",
    byDelete: "The delete of a channel",
  },
  ko: {
    locale: "ko-KR",
    all: "전체",
    general: "일반",
    itemsTab: "항목",
    historyTab: "기록",
    noteFor: (name) => `${name} 채널 메모`,
    notMember: "멤버 아님",
    moved: "이동",
    byDelete: "채널 삭제",
  },
}

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const channelMessages = (page: Page) => page.getByTestId("channel-message")
const noStreaming = (page: Page) =>
  expect(page.locator("[data-status=streaming]")).toHaveCount(0, { timeout: 20_000 })

/** A channel with the given members and no lead: a message with a mention goes to that member. */
const makeChannel = async (page: Page, name: string, members: readonly string[]) => {
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill(name)
  for (const member of members) await page.getByTestId(`channel-member-${member}`).check()
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText(name)
}
const openChannel = async (page: Page, name: string) => {
  await page.locator("[data-testid^=place-channel-]", { hasText: name }).click()
  await expect(page.getByTestId("channel-header-name")).toHaveText(name)
}
const openMemoryOf = async (page: Page, agent: string) => {
  await page.locator("[data-testid^=place-agent-]", { hasText: new RegExp(`^${agent}`) }).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("memory-panel")).toBeVisible()
}
const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}
const item = (page: Page, text: string) => page.getByTestId("memory-item").filter({ hasText: text })
/** The memory page lies low in the profile: scroll its title to the top, then take the picture. */
const scrollMemory = (page: Page) =>
  page.getByTestId("memory-panel").evaluate((el) => el.scrollIntoView({ block: "start" }))
const shotMemory = async (page: Page, name: string) => {
  await scrollMemory(page)
  await shot(page, name)
}

const scenario = async (language: "en" | "ko") => {
  const w = WORDS[language]
  const tag = `s65-${language}`
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: w.locale })
  // The smallest window of the spec, with the activity panel open (it is open at the start).
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Bo", "Cy"]) await createAgent(page, name)
  await makeChannel(page, "Launch", ["Bo", "Cy"])
  await makeChannel(page, "Design", ["Bo"])
  await expect(page.getByTestId("activity-panel")).toBeVisible()

  /** The system text of the last request that the model got. */
  const lastSystem = () => {
    const chat = mock.requests.filter((r) => r.path === "/v1/chat/completions")
    const body = chat.at(-1)?.body as { messages: { role: string; content: string }[] }
    return String(body.messages[0]?.content ?? "")
  }

  // ---- Bo saves a note for Launch, and a general item, in the channel Launch.
  await openChannel(page, "Launch")
  await post(
    page,
    `@Bo TOOL save_memory ${JSON.stringify({ text: "Launch is on Friday", for_channel: true })}`,
  )
  await expect(page.getByTestId("memory-saved-line")).toHaveCount(1, { timeout: 20_000 })
  await noStreaming(page)
  await post(page, `@Bo TOOL save_memory ${JSON.stringify({ text: "Bo likes short replies" })}`)
  await expect(page.getByTestId("memory-saved-line")).toHaveCount(2, { timeout: 20_000 })
  await noStreaming(page)
  await shot(page, `${tag}-01-channel-saved`)

  // ---- The page of the memory: the note names its channel, and the filter has an entry for it.
  await openMemoryOf(page, "Bo")
  const filter = page.getByTestId("memory-filter")
  await expect(page.getByTestId("memory-item")).toHaveCount(2)
  await expect(item(page, "Launch is on Friday").getByTestId("memory-note-channel")).toHaveText(
    w.noteFor("Launch"),
  )
  await expect(item(page, "Bo likes short replies").getByTestId("memory-note-meta")).toHaveCount(0)
  await expect(filter.locator("option")).toHaveText([w.all, w.general, "Launch (1)"])
  await shotMemory(page, `${tag}-02-items-with-note`)

  // The filter: General keeps the general item, the entry of the channel keeps the note.
  await filter.selectOption({ label: w.general })
  await expect(page.getByTestId("memory-item")).toHaveCount(1)
  await expect(page.getByTestId("memory-item")).toContainText("Bo likes short replies")
  await filter.selectOption({ label: "Launch (1)" })
  await expect(page.getByTestId("memory-item")).toHaveCount(1)
  await expect(page.getByTestId("memory-item")).toContainText("Launch is on Friday")
  await shotMemory(page, `${tag}-03-filter-channel`)
  await filter.selectOption({ label: w.all })
  await expect(page.getByTestId("memory-item")).toHaveCount(2)
  await closeProfile(page)

  // ---- What a turn reads. In the direct chat of Bo the note is not read; in the channel it is.
  await page.locator("[data-testid^=place-agent-]", { hasText: /^Bo/ }).click()
  await page.getByTestId("composer-input").fill("What do you remember?")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.locator("[data-testid=message][data-author=agent]")).toHaveCount(1, {
    timeout: 20_000,
  })
  await noStreaming(page)
  expect(lastSystem()).toContain("Bo likes short replies")
  expect(lastSystem()).not.toContain("Launch is on Friday")
  await openChannel(page, "Launch")
  const before = await channelMessages(page).count()
  await post(page, "@Bo What do you remember here?")
  await expect(channelMessages(page)).toHaveCount(before + 2, { timeout: 20_000 })
  await noStreaming(page)
  expect(lastSystem()).toContain("Launch is on Friday")
  expect(lastSystem()).toContain("Bo likes short replies")
  // The other channel, with the same member, does not read the note of Launch.
  await openChannel(page, "Design")
  const design = await channelMessages(page).count()
  await post(page, "@Bo And here?")
  await expect(channelMessages(page)).toHaveCount(design + 2, { timeout: 20_000 })
  await noStreaming(page)
  expect(lastSystem()).not.toContain("Launch is on Friday")
  expect(lastSystem()).toContain("Bo likes short replies")

  // ---- The move: to Design, to General, and back to Launch. Each one is a change with a row.
  await openMemoryOf(page, "Bo")
  const note = item(page, "Launch is on Friday")
  await scrollMemory(page)
  await note.getByTestId("memory-item-menu").click()
  await expect(page.getByTestId("memory-move-general")).toBeVisible()
  await shot(page, `${tag}-04-move-menu`)
  await page.getByTestId("memory-move-channel").filter({ hasText: "Design" }).click()
  await expect(note.getByTestId("memory-note-channel")).toHaveText(w.noteFor("Design"))
  await note.getByTestId("memory-item-menu").click()
  await page.getByTestId("memory-move-general").click()
  await expect(note.getByTestId("memory-note-meta")).toHaveCount(0)
  await note.getByTestId("memory-item-menu").click()
  await page.getByTestId("memory-move-channel").filter({ hasText: "Launch" }).click()
  await expect(note.getByTestId("memory-note-channel")).toHaveText(w.noteFor("Launch"))
  await page.getByTestId("memory-tabs").getByText(w.historyTab).click()
  const moves = page.locator("[data-testid=memory-history-row][data-kind=moved]")
  await expect(moves).toHaveCount(3)
  await expect(moves.first().getByTestId("memory-history-channel")).toContainText("Launch")
  await expect(moves.first()).toContainText(w.moved)
  await expect(moves.first().getByTestId("memory-history-undo")).toBeEnabled()
  await shotMemory(page, `${tag}-05-history-moves`)
  // Undo of the last move puts the note back in General.
  await moves.first().getByTestId("memory-history-undo").click()
  await page.getByTestId("memory-tabs").getByText(w.itemsTab).click()
  await expect(note.getByTestId("memory-note-meta")).toHaveCount(0)
  await note.getByTestId("memory-item-menu").click()
  await page.getByTestId("memory-move-channel").filter({ hasText: "Launch" }).click()
  await expect(note.getByTestId("memory-note-channel")).toHaveText(w.noteFor("Launch"))
  await closeProfile(page)

  // ---- "Not a member": Bo leaves Launch; the note stays, is marked, and is not read.
  await openChannel(page, "Launch")
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-member-Bo").uncheck()
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-dialog")).toBeHidden()
  await openMemoryOf(page, "Bo")
  await expect(note.getByTestId("memory-not-member")).toHaveText(w.notMember)
  await scrollMemory(page)
  await note.getByTestId("memory-item-menu").click()
  // The channel that Bo left is the current place, and not a target; General and Design are.
  await expect(page.getByTestId("memory-move-current")).toBeDisabled()
  await expect(page.getByTestId("memory-move-channel")).toHaveCount(1)
  await expect(page.getByTestId("memory-move-channel")).toContainText("Design")
  await shot(page, `${tag}-06-not-a-member`)
  await page.keyboard.press("Escape")
  await closeProfile(page)
  // Added again: the mark goes, and the note is read again.
  await openChannel(page, "Launch")
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-member-Bo").check()
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-dialog")).toBeHidden()
  const again = await channelMessages(page).count()
  await post(page, "@Bo Back again?")
  await expect(channelMessages(page)).toHaveCount(again + 2, { timeout: 20_000 })
  await noStreaming(page)
  expect(lastSystem()).toContain("Launch is on Friday")
  await openMemoryOf(page, "Bo")
  await expect(note.getByTestId("memory-note-channel")).toHaveText(w.noteFor("Launch"))
  await expect(note.getByTestId("memory-not-member")).toHaveCount(0)
  await closeProfile(page)

  // ---- The delete of the channel: the note is gone, and History has a row for it.
  await openChannel(page, "Launch")
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-delete").click()
  await page.getByTestId("channel-delete-confirm").click()
  await expect(page.locator("[data-testid^=place-channel-]", { hasText: "Launch" })).toHaveCount(0)
  await openMemoryOf(page, "Bo")
  await expect(page.getByTestId("memory-item")).toHaveCount(1)
  await expect(page.getByTestId("memory-item")).toContainText("Bo likes short replies")
  await expect(filter.locator("option")).toHaveText([w.all, w.general])
  await page.getByTestId("memory-tabs").getByText(w.historyTab).click()
  const deleted = page.locator("[data-testid=memory-history-row][data-actor=channel_deleted]")
  await expect(deleted).toHaveCount(1)
  await expect(deleted).toContainText(w.byDelete)
  await expect(deleted).toContainText("Launch is on Friday")
  await expect(deleted.getByTestId("memory-history-channel")).toContainText("Launch")
  await shotMemory(page, `${tag}-07-history-channel-deleted`)
  // Undo of that row makes a general item: it has no channel.
  await deleted.getByTestId("memory-history-undo").click()
  await page.getByTestId("memory-tabs").getByText(w.itemsTab).click()
  await expect(page.getByTestId("memory-item")).toHaveCount(2)
  await expect(note.getByTestId("memory-note-meta")).toHaveCount(0)
  await filter.selectOption({ label: w.general })
  await expect(page.getByTestId("memory-item")).toHaveCount(2)
  await shotMemory(page, `${tag}-08-restored-general`)

  await app.close()
  await mock.close()
}

test("channel notes (English): save, filter, read only in the channel, move, not a member, delete", async () => {
  await scenario("en")
})

test("channel notes (Korean): save, filter, read only in the channel, move, not a member, delete", async () => {
  await scenario("ko")
})
