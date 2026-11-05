import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { deflateSync } from "node:zlib"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// S88, spec 004: what a member reads in a turn of a channel, and the picture of a channel. The
// window is 1100 px wide with the activity panel open (it is the smallest the spec allows). The
// stand-in model has a context of 8000 tokens (the model "mock-fast"), or tells no size (the
// model "o3-mini"). Long histories are written to the data folder while the app is closed.

interface Words {
  readonly locale: string
  readonly upload: string
  readonly remove: string
  readonly tooSmall: string
}

const WORDS: Record<"en" | "ko", Words> = {
  en: {
    locale: "en-US",
    upload: "Upload picture",
    remove: "Remove picture",
    tooSmall: "larger than the context of the model",
  },
  ko: {
    locale: "ko-KR",
    upload: "사진 올리기",
    remove: "사진 지우기",
    tooSmall: "모델의 컨텍스트보다 길어요",
  },
}

const SIZE = 8000
/** A quarter of the context, in characters of plain ASCII text (a quarter of a token each). */
const QUARTER_CHARS = (SIZE / 4) * 4

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const noStreaming = (page: Page) =>
  expect(page.locator("[data-status=streaming]")).toHaveCount(0, { timeout: 30_000 })

/** Makes an agent on a model of the stand-in provider, with instructions when given. */
const makeAgent = async (page: Page, name: string, model: string, instructions = "") => {
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill(name)
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("model-model").selectOption(model)
  if (instructions) await page.getByTestId("agent-instructions").fill(instructions)
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: name }).waitFor()
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
}

const makeChannel = async (
  page: Page,
  name: string,
  members: readonly string[],
  instructions = "",
) => {
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill(name)
  for (const member of members) await page.getByTestId(`channel-member-${member}`).check()
  if (instructions) await page.getByTestId("channel-instructions").fill(instructions)
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText(name)
}
const openChannel = async (page: Page, name: string) => {
  await page.locator("[data-testid^=place-channel-]", { hasText: name }).click()
  await expect(page.getByTestId("channel-header-name")).toHaveText(name)
}

interface Chat {
  messages: { role: string; content: string }[]
}
/** The requests of the stand-in model, as the app sent them. */
const chatRequests = (mock: Awaited<ReturnType<typeof startMockProvider>>) =>
  mock.requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => (r.body as Chat).messages)
const isSummary = (messages: Chat["messages"]) =>
  String(messages[0]?.content ?? "").startsWith("You summarise the older messages")
const isMember = (messages: Chat["messages"]) =>
  String(messages[0]?.content ?? "").startsWith("Your assignment, which this reply does:")
/** The text of the user turns of a request, as one text: the provider joins turns in a row. */
const userText = (messages: Chat["messages"]) =>
  messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n")
const memberRequests = (mock: Awaited<ReturnType<typeof startMockProvider>>) =>
  chatRequests(mock).filter(isMember)
const lastMemberRequest = (mock: Awaited<ReturnType<typeof startMockProvider>>) =>
  memberRequests(mock).at(-1) as Chat["messages"]

/** A PNG of a size, with two colours side by side, made without a library. */
const png = (width: number, height: number) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(body))
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1)
    for (let x = 0; x < width; x++) {
      // Left: teal. Right: orange. A light bar across the middle.
      const bar = Math.abs(y - height / 2) < height / 10
      const colour = bar ? [250, 250, 250] : x < width / 2 ? [20, 150, 140] : [230, 130, 40]
      rows.set([...colour, 255], at + 1 + x * 4)
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** The history of the channels, written while the app is closed. */
const seed = (userData: string) => {
  const db = new DatabaseSync(join(userData, "robot.db"))
  const idOf = (table: string, name: string) =>
    (db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name) as { id: string }).id
  const cy = idOf("agent", "Cy")
  const insert = db.prepare(
    `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, created_at, finished_at)
     VALUES (?, ?, ?, ?, 'text', ?, 'done', ?, ?)`,
  )
  const base = Date.now() - 3_600_000
  let n = 0
  const add = (channel: string, author: "user" | "agent", text: string) => {
    const at = base + n++
    insert.run(
      `seed-${n}`,
      idOf("channel", channel),
      author,
      author === "agent" ? cy : null,
      JSON.stringify([{ kind: "text", text }]),
      at,
      at,
    )
  }
  db.exec("BEGIN")
  // Launch: 200 messages. One asks Bo with a long text. A reply of Cy sits between the messages.
  add("Launch", "user", `@Bo please read this carefully ${"a".repeat(3000)}`)
  for (let i = 2; i <= 200; i++) {
    if (i % 2 === 0) add("Launch", "user", `message ${i} ${"w".repeat(120)}`)
    else add("Launch", "agent", `reply ${i} ${"v".repeat(120)}`)
  }
  // Broken: the same, and a message that makes the stand-in summary call fail.
  add("Broken", "user", "summary fails here")
  for (let i = 2; i <= 120; i++) add("Broken", "user", `broken ${i} ${"w".repeat(120)}`)
  // Plain: 29 messages, for a model that tells no size of context. Short: 5 messages.
  for (let i = 1; i <= 29; i++) add("Plain", "user", `plain ${i}`)
  for (let i = 1; i <= 5; i++) add("Short", "user", `short ${i}`)
  db.exec("COMMIT")
  db.close()
}

const scenario = async (language: "en" | "ko") => {
  const w = WORDS[language]
  const tag = `s88-${language}`
  test.setTimeout(420_000)
  const mock = await startMockProvider({ contextSize: SIZE })
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: w.locale }
  let { app, page } = await launch(userData, env)
  // The smallest window of the spec, with the activity panel open (it is open at the start).
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Bo")
  await createAgent(page, "Cy")
  await makeAgent(page, "Dee", "o3-mini")
  // Eve has instructions of about 10,000 tokens: with them alone the context of 8000 is full.
  await makeAgent(page, "Eve", "mock-fast", "e".repeat(40_000))
  await makeChannel(page, "Launch", ["Bo", "Cy"], "Write the answer as a list.")
  await makeChannel(page, "Broken", ["Bo"])
  await makeChannel(page, "Plain", ["Dee"])
  await makeChannel(page, "Short", ["Dee"])
  await makeChannel(page, "Tiny", ["Eve"])
  await app.close()
  seed(userData)
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1100, 800)
  await expect(page.getByTestId("activity-panel")).toBeVisible()

  // ---- A long history and a small context: summary, newest messages, asking messages.
  await openChannel(page, "Launch")
  await post(page, "@Bo what now")
  await noStreaming(page)
  await expect(page.getByTestId("channel-message").last()).toContainText("You said: @Bo what now")
  const requests = chatRequests(mock)
  expect(requests.filter(isSummary)).toHaveLength(1)
  // The call that writes the summary reads older messages, oldest first, never the newest.
  const summaryAsk = userText(requests.filter(isSummary)[0] as Chat["messages"])
  expect(summaryAsk).toContain("[User]: @Bo please read this carefully")
  expect(summaryAsk).not.toContain("message 200 ")
  const member = lastMemberRequest(mock)
  const system = String(member[0]?.content)
  // The assignment comes first, then the instructions of the channel.
  expect(system.startsWith("Your assignment, which this reply does:\n@Bo what now\n")).toBe(true)
  expect(system.indexOf("@Bo what now")).toBeLessThan(system.indexOf("Write the answer as a list."))
  const text = userText(member)
  // The messages that asked Bo come first, each cut to 2000 characters.
  expect(text.startsWith("Messages that asked you")).toBe(true)
  const asking = text.split("\n\n")[0] as string
  expect(asking).toContain("[User]: @Bo please read this carefully")
  for (const row of asking.split("\n").slice(1)) expect(row.length).toBeLessThanOrEqual(2000 + 20)
  // Then the summary, which the stand-in model wrote from the older messages.
  const blocks = text.split("\n\n")
  const at = blocks.findIndex((b) => b.startsWith("Summary of the older messages of this channel:"))
  expect(at).toBeGreaterThan(0)
  expect(blocks[at]).toMatch(/\nChannel summary of \d+ older messages$/)
  // The newest messages follow, under a quarter of the context, and the reminder is the last.
  const newest = blocks.slice(at + 1, -1)
  expect(newest.length).toBeGreaterThan(10)
  expect(newest.at(-1)).toBe("@Bo what now")
  expect(newest.join("\n\n").length).toBeLessThanOrEqual(QUARTER_CHARS)
  expect(blocks.at(-1)).toBe("Reminder of your assignment:\n@Bo what now")
  await shot(page, `${tag}-01-launch-answered`)

  // ---- A summary that cannot be written: the part does not fail.
  await openChannel(page, "Broken")
  const summariesBefore = chatRequests(mock).filter(isSummary).length
  await post(page, "@Bo what now")
  await noStreaming(page)
  await expect(page.getByTestId("channel-message").last()).toContainText("You said: @Bo what now")
  expect(chatRequests(mock).filter(isSummary).length).toBe(summariesBefore + 1)
  expect(userText(lastMemberRequest(mock))).not.toContain("Summary of the older messages")
  expect(userText(lastMemberRequest(mock))).toContain("broken 120 ")
  await expect(page.locator("[data-status=failed]")).toHaveCount(0)
  await shot(page, `${tag}-02-broken-no-summary`)

  // ---- A model that tells no size: the last 20 messages, a reminder, and no summary.
  await openChannel(page, "Plain")
  const summariesBeforePlain = chatRequests(mock).filter(isSummary).length
  await post(page, "@Dee what is up")
  await noStreaming(page)
  await expect(page.getByTestId("channel-message").last()).toContainText(
    "You said: @Dee what is up",
  )
  expect(chatRequests(mock).filter(isSummary).length).toBe(summariesBeforePlain)
  const plain = userText(lastMemberRequest(mock))
  // 30 messages in the channel: the 19 newest of 29, and the job. "plain 10" is the first left out.
  expect(plain).toContain("plain 11\n")
  expect(plain).not.toMatch(/plain 10\b/)
  expect(plain.endsWith("Reminder of your assignment:\n@Dee what is up")).toBe(true)

  // ---- Ten messages or fewer: no reminder.
  await openChannel(page, "Short")
  await post(page, "@Dee hi there")
  await noStreaming(page)
  await expect(page.getByTestId("channel-message").last()).toContainText("You said: @Dee hi there")
  const short = userText(lastMemberRequest(mock))
  expect(short).not.toContain("Reminder of your assignment")
  expect(short.endsWith("@Dee hi there")).toBe(true)

  // ---- The assignment and the instructions do not fit in the context: the part fails.
  await openChannel(page, "Tiny")
  const before = memberRequests(mock).length
  await post(page, "@Eve hello")
  await expect(page.locator("[data-status=failed]")).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId("channel-message").last()).toContainText(w.tooSmall)
  expect(memberRequests(mock).length).toBe(before)
  await shot(page, `${tag}-03-too-small`)

  // ---- The picture of a channel.
  await openChannel(page, "Launch")
  const row = page.locator("[data-testid^=place-channel-]", { hasText: "Launch" })
  await expect(row.getByTestId("channel-mark")).toBeVisible()
  await expect(row.locator("[data-channel-picture]")).toHaveCount(0)
  await expect(page.getByTestId("channel-header-picture")).toHaveCount(0)
  await shot(page, `${tag}-04-no-picture`)

  const dir = mkdtempSync(join(tmpdir(), "robot-s88-"))
  const file = join(dir, "picture.png")
  // A wide image: the window cuts it to a square of 256 px.
  writeFileSync(file, png(300, 200))
  await page.getByTestId("channel-settings").click()
  await expect(page.getByTestId("channel-dialog")).toBeVisible()
  await expect(page.getByTestId("channel-picture-upload")).toHaveText(w.upload)
  await expect(page.getByTestId("channel-picture-remove")).toHaveCount(0)
  await page.getByTestId("channel-picture-file").setInputFiles(file)
  await expect(page.getByTestId("channel-picture-remove")).toHaveText(w.remove)
  await expect(page.getByTestId("channel-picture-preview")).toHaveAttribute(
    "data-channel-picture",
    "true",
  )
  await shot(page, `${tag}-05-settings-with-picture`)
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("channel-dialog")).toHaveCount(0)

  // The picture is a square of 256 px, and the place row and the header show it.
  const stored = await rpc<{ id: string; name: string; picture: string | null }[]>(
    page,
    "channels.list",
    {
      serverId: (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string,
    },
  )
  const picture = stored.find((c) => c.name === "Launch")?.picture ?? ""
  expect(picture.startsWith("data:image/png;base64,")).toBe(true)
  const bytes = Buffer.from(picture.split(",")[1] as string, "base64")
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([256, 256])
  expect(bytes.length).toBeLessThanOrEqual(1024 * 1024)
  const markInRow = row.locator("[data-channel-picture]")
  await expect(markInRow).toBeVisible()
  await expect(row.getByTestId("channel-mark")).toHaveAttribute("data-channel-picture", "true")
  const header = page.getByTestId("channel-header-picture")
  await expect(header).toBeVisible()
  await expect(header).toHaveCSS("border-top-left-radius", "50%")
  await expect(header).toHaveCSS("outline-width", "1.5px")
  // The name next to it stays whole in the narrow header (1100 px wide, panel open).
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
  const box = await page.getByTestId("channel-header-name").boundingBox()
  expect(box?.width ?? 0).toBeGreaterThan(30)
  await shot(page, `${tag}-06-picture-in-row-and-header`)

  // The search shows the picture in the row of a hit of this channel.
  await page.getByTestId("place-search").fill("message 1")
  await expect(
    page.locator("[data-testid=search-hit][data-hit-place=Launch]").first(),
  ).toBeVisible()
  await expect(
    page
      .locator("[data-testid=search-hit][data-hit-place=Launch]")
      .first()
      .locator("[data-channel-picture]"),
  ).toBeVisible()
  await shot(page, `${tag}-07-picture-in-search`)
  await page.getByTestId("place-search").fill("")

  // The org chart draws organizations, not channels: it has no node and no picture for the
  // channel (spec 029, "Out of scope").
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
  await expect(page.getByTestId("org-unit").filter({ hasText: "Launch" })).toHaveCount(0)
  await expect(page.getByTestId("org-page").locator("[data-channel-picture]")).toHaveCount(0)

  // The picture is still there after a restart.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1100, 800)
  await expect(
    page
      .locator("[data-testid^=place-channel-]", { hasText: "Launch" })
      .locator("[data-channel-picture]"),
  ).toBeVisible()

  // Remove: the mark with the # comes back in the row and in the header.
  await openChannel(page, "Launch")
  await page.getByTestId("channel-settings").click()
  await page.getByTestId("channel-picture-remove").click()
  await expect(page.getByTestId("channel-picture-remove")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(
    page
      .locator("[data-testid^=place-channel-]", { hasText: "Launch" })
      .getByTestId("channel-mark"),
  ).not.toHaveAttribute("data-channel-picture", "true")
  await expect(page.getByTestId("channel-header-picture")).toHaveCount(0)
  await shot(page, `${tag}-09-picture-removed`)
  await app.close()
  await mock.close()
}

test("S88 (English): what a member reads, and the picture of a channel", async () => {
  await scenario("en")
})

test("S88 (Korean): what a member reads, and the picture of a channel", async () => {
  await scenario("ko")
})
