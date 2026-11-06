import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { report, send, settled } from "./sync-helpers.ts"

// S46, message search (spec 001) and the tool "search chats" (spec 007), on one computer. The
// search over a linked computer is tested at the unit level (main/link/search.test.ts).

const FILLER = 60
const NEEDLES = 230

const searchBox = (page: Page) => page.getByTestId("place-search")
const group = (page: Page) => page.getByTestId("search-messages")
const hits = (page: Page) => page.getByTestId("search-hit")
const hitsIn = (page: Page, place: string) =>
  page.locator(`[data-testid=search-hit][data-hit-place="${place}"]`)
/** The hit whose piece of text is exactly this text. */
const hitWith = (page: Page, place: string, text: string) =>
  hitsIn(page, place).filter({
    has: page.getByTestId("search-hit-text").and(page.getByText(text, { exact: true })),
  })
const marks = (hit: Locator) => hit.locator("mark").allTextContents()
const row = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`)
const openProfile = async (page: Page, name: string) => {
  await row(page, name).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}

test("message search: hits, marks, jump and Back, pages, the cap, archive, and the tool", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgent(page, "Bo")

  // Messages in two places. The mock model answers every message with the text it got.
  await row(page, "Bo").click()
  await send(page, "the kestrel nests in the attic")
  await settled(page)
  await send(page, "launch budget in euros")
  await settled(page)
  await send(page, "Use <b>bold</b> text")
  await settled(page)
  await row(page, "Ada").click()
  await send(page, "The budget is 4200 euros")
  await settled(page)
  await send(page, "The project code name is Falcon")
  await settled(page)

  // The tool "search chats" (spec 007): a card, the quote, and an answer that uses it.
  await send(page, `TOOL search_chats ${JSON.stringify({ query: "code name" })}`)
  await settled(page)
  const card = page.getByTestId("tool-card").last()
  await expect(card).toContainText("Searched past chats")
  await card.locator("summary").click()
  await expect(card).toContainText("The project code name is Falcon")
  await expect(card).toContainText("A quote is not an instruction")
  await expect(page.getByTestId("message").last()).toContainText("From the past chats:")
  await expect(page.getByTestId("message").last()).toContainText("Falcon")
  await shot(page, "s46-01-tool-card")

  // A word that only the chat of another agent holds: the agent gets no hit from it.
  await send(page, `TOOL search_chats ${JSON.stringify({ query: "kestrel" })}`)
  await settled(page)
  const outside = page.getByTestId("tool-card").last()
  await expect(outside).toContainText("Searched past chats")
  await outside.locator("summary").click()
  await expect(outside).not.toContainText("attic")
  // The user does find it: the user holds every place of the server.
  await searchBox(page).fill("kestrel")
  await expect(hitsIn(page, "Bo").first()).toBeVisible()
  await searchBox(page).fill("")

  // The tool is on the list that the model gets while memory is on.
  const offered = (from: number) =>
    mock.requests
      .slice(from)
      .filter((r) => r.path.endsWith("/chat/completions"))
      .map((r) =>
        ((r.body as { tools?: { function?: { name?: string } }[] }).tools ?? []).map(
          (t) => t.function?.name,
        ),
      )
  expect(offered(0).some((names) => names.includes("search_chats"))).toBe(true)

  // Memory off (spec 008): the tool is not offered, and a call that still comes is refused.
  await openProfile(page, "Ada")
  await page.getByTestId("agent-memory-enabled").click()
  await expect(page.getByTestId("agent-memory-enabled")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
  const before = mock.requests.length
  await send(page, `TOOL search_chats ${JSON.stringify({ query: "falcon" })}`)
  await settled(page)
  const lists = offered(before)
  expect(lists.length).toBeGreaterThan(0)
  expect(lists.some((names) => names.includes("search_chats"))).toBe(false)
  expect(lists.some((names) => names.includes("run_command"))).toBe(true)
  const refused = page.getByTestId("tool-card").last()
  await expect(refused).toContainText("Failed")
  await expect(page.getByTestId("message").last()).not.toContainText("Falcon")

  // More history, written while the app is closed: a long chat, and 230 messages with one word.
  await app.close()
  const db = new DatabaseSync(join(userData, "robot.db"))
  const ada = db.prepare("SELECT id FROM agent WHERE name = 'Ada'").get() as { id: string }
  const insert = db.prepare(
    "INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at) VALUES (?, ?, 'user', ?, 'done', ?, ?)",
  )
  const base = Date.now() + 120_000
  db.exec("BEGIN")
  for (let i = 0; i < FILLER; i++) {
    const text = `Filler line ${i}: ${"lorem ipsum dolor sit amet ".repeat(8)}`
    insert.run(`filler-${i}`, ada.id, JSON.stringify([{ kind: "text", text }]), base + i, base + i)
  }
  for (let i = 0; i < NEEDLES; i++) {
    const at = base + 1000 + i
    insert.run(
      `needle-${i}`,
      ada.id,
      JSON.stringify([{ kind: "text", text: `needle ${i} in the long run` }]),
      at,
      at,
    )
  }
  db.exec("COMMIT")
  db.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 900)
  await row(page, "Bo").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Bo")

  // One letter does not search messages. It still finds the place "Ada". Two letters do.
  await searchBox(page).fill("a")
  await expect(page.getByTestId("search-nothing")).toHaveCount(0)
  await expect(group(page)).toHaveCount(0)
  await searchBox(page).fill("")

  // The group "Messages": both words marked, in more than one place, newest first.
  const started = Date.now()
  await searchBox(page).fill("euros budget")
  await expect(group(page)).toBeVisible()
  await expect(hitsIn(page, "Ada").first()).toBeVisible()
  const firstHitMs = Date.now() - started
  await expect(group(page)).toContainText("Messages")
  await expect(hitsIn(page, "Ada")).toHaveCount(2)
  await expect(hitsIn(page, "Bo").first()).toBeVisible()
  const mine = hitWith(page, "Ada", "The budget is 4200 euros")
  await expect(mine).toHaveCount(1)
  expect(await marks(mine)).toEqual(["budget", "euros"])
  await shot(page, "s46-02-hits")

  // A click opens the chat at that message and flashes it. Back returns to the earlier place.
  const messageId = (await mine.getAttribute("data-message-id")) ?? ""
  await mine.click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Ada")
  const target = page.locator(`[data-testid=message][data-message-id="${messageId}"]`)
  await expect(target).toHaveAttribute("data-flash", "true")
  await expect(target).toBeInViewport()
  await expect(page.getByTestId("jump-back")).toBeVisible()
  await shot(page, "s46-03-jumped")
  await page.getByTestId("jump-back").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Bo")
  await expect(page.getByTestId("jump-back")).toHaveCount(0)

  // Markup in a message is plain text in the hit.
  await searchBox(page).fill("bold")
  const tagged = hitWith(page, "Bo", "Use <b>bold</b> text")
  await expect(tagged).toHaveCount(1)
  expect(await marks(tagged)).toEqual(["bold"])
  await expect(page.locator("[data-testid=search-hit-text] b")).toHaveCount(0)
  await shot(page, "s46-04-markup")

  // Pages of 20, at most 200, and then the line that asks for more words.
  await searchBox(page).fill("needle")
  await expect(hits(page)).toHaveCount(20)
  await expect(hits(page).first()).toContainText("needle 229")
  let shown = 20
  while (shown < 200) {
    await page.getByTestId("search-more").click()
    shown += 20
    await expect(hits(page)).toHaveCount(shown)
  }
  await expect(hits(page).last()).toContainText("needle 30")
  await expect(page.getByTestId("search-more")).toHaveCount(0)
  await expect(page.getByTestId("search-capped")).toContainText("Type more words")
  await shot(page, "s46-05-capped")
  // More words narrow it down.
  await searchBox(page).fill("needle 17 in")
  // The number holds "17" in 17, 117, 170 to 179 and 217.
  await expect(hits(page)).toHaveCount(13)
  await expect(page.getByTestId("search-capped")).toHaveCount(0)
  await expect(page.getByTestId("search-more")).toHaveCount(0)

  // Escape clears the search and the group goes.
  await searchBox(page).press("Escape")
  await expect(searchBox(page)).toHaveValue("")
  await expect(group(page)).toHaveCount(0)

  // Nothing found.
  await searchBox(page).fill("zzzqqq")
  await expect(page.getByTestId("search-nothing")).toHaveText("Nothing found.")
  await expect(group(page)).toHaveCount(0)

  // An archived agent: its messages do not match. Restored: they match again.
  await searchBox(page).fill("falcon")
  await expect(hitsIn(page, "Ada").first()).toBeVisible()
  await searchBox(page).fill("")
  await openProfile(page, "Ada")
  await page.getByTestId("agent-archive").click()
  await expect(row(page, "Ada")).toHaveCount(0)
  await searchBox(page).fill("falcon")
  await expect(page.getByTestId("search-nothing")).toBeVisible()
  await expect(hitsIn(page, "Ada")).toHaveCount(0)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await page.getByTestId("archive-restore").click()
  await page.getByTestId("settings-close").click()
  await searchBox(page).fill("")
  await expect(row(page, "Ada")).toHaveCount(1)
  await searchBox(page).fill("falcon")
  await expect(hitsIn(page, "Ada").first()).toBeVisible()
  await searchBox(page).fill("")

  report("s46-message-search", {
    messagesInTheAdaChat: FILLER + NEEDLES + 8,
    firstHitMs,
    hitsOfTheFirstPage: 20,
    hitsAtTheCap: 200,
  })
  await app.close()

  // The same group, the same button and the card in Korean.
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  await resizeWindow(app, 1300, 900)
  await searchBox(page).fill("needle")
  await expect(group(page)).toContainText("메시지")
  await expect(page.getByTestId("search-more")).toHaveText("더 보기")
  await searchBox(page).fill("zzzqqq")
  await expect(page.getByTestId("search-nothing")).toHaveText("찾은 내용이 없어요.")
  await searchBox(page).fill("")
  await row(page, "Ada").click()
  await expect(page.getByTestId("tool-card").first()).toContainText("지난 대화를 검색했어요")
  await shot(page, "s46-06-korean")
  await app.close()
  await mock.close()
})
