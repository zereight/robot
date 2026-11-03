import { afterAll, describe, expect, test } from "bun:test"
import type { Browser, Page } from "playwright-core"
import { keyOf, Outbox, RateLimiter, SeenKeys } from "./core.ts"
import { fakeChatHtml } from "./fake-chat.ts"
import { describePage } from "./inspect.ts"
import { type LoopOptions, processNew } from "./loop.ts"
import { GUESSED } from "./selectors.ts"
import { TeamsPage } from "./teams.ts"
import { launchChrome } from "./test-browser.ts"

const browser: Browser | null = await launchChrome()
const suite = browser ? describe : describe.skip

// One browser for the whole file. It closes after the last test of the file.
afterAll(async () => {
  await browser?.close()
})

suite("polling loop on the fake page", () => {
  let page: Page

  /** A new page, with the 2 messages that are already there taken as seen (the baseline). */
  const start = async (mode: "watch" | "echo", expectTitle = "(You)") => {
    page = await (browser as Browser).newPage()
    await page.setContent(fakeChatHtml)
    const teams = new TeamsPage(page, GUESSED)
    const seen = new SeenKeys()
    for (const m of await teams.readMessages()) seen.add(keyOf(m))
    const lines: string[] = []
    const opts: LoopOptions = {
      teams,
      seen,
      limiter: new RateLimiter(20, 60_000),
      outbox: new Outbox(),
      admission: { allow: ["Me"], bots: [], call: "" },
      mode,
      marker: "[ROBot]",
      chunkMax: 4000,
      expectTitle,
      log: (l) => lines.push(l),
    }
    return { teams, opts, lines }
  }

  /** Adds a message to the fake chat as if the user typed it on the phone. */
  const userSays = (id: string, text: string) =>
    page.evaluate(
      ([mid, body]) => {
        const el = document.createElement("div")
        el.setAttribute("data-tid", "chat-pane-message")
        el.setAttribute("data-mid", mid as string)
        el.innerHTML =
          '<span data-tid="message-author-name">Me</span><time datetime="2026-11-03T11:00:00Z"></time><div data-tid="message-body"></div>'
        const bodyEl = el.querySelector('[data-tid="message-body"]') as HTMLElement
        // biome-ignore lint/performance/useDomNodeTextContent: innerText turns line breaks into <br>
        bodyEl.innerText = body as string
        document.getElementById("list")?.appendChild(el)
      },
      [id, text],
    )

  test("ignores the old messages", async () => {
    const { opts, lines } = await start("echo")
    expect(await processNew(opts)).toBe(0)
    expect(lines).toEqual([])
  })

  test("echoes a new message once, and does not echo its own echo", async () => {
    const { teams, opts, lines } = await start("echo")
    await userSays("10", "ping")
    expect(await processNew(opts)).toBe(1)
    expect((await teams.readMessages()).at(-1)?.text).toBe("[ROBot] echo: ping")
    // The echo is now in the chat. More passes must do nothing.
    expect(await processNew(opts)).toBe(0)
    expect(await processNew(opts)).toBe(0)
    expect((await teams.readMessages()).length).toBe(4)
    expect(lines.filter((l) => l === "> echoed").length).toBe(1)
  })

  test("watch mode reads and prints but never sends", async () => {
    const { teams, opts, lines } = await start("watch")
    await userSays("10", "ping")
    expect(await processNew(opts)).toBe(0)
    expect((await teams.readMessages()).length).toBe(3)
    expect(lines).toEqual(["< Me: ping"])
  })

  test("does not send into a chat with the wrong title", async () => {
    const { teams, opts, lines } = await start("echo", "Someone Else")
    await userSays("10", "ping")
    expect(await processNew(opts)).toBe(0)
    expect((await teams.readMessages()).length).toBe(3)
    expect(lines.some((l) => l.startsWith("dropped: the answer for id:10: Refusing to send"))).toBe(
      true,
    )
    // The dropped answer is never sent again.
    expect(await processNew(opts)).toBe(0)
    expect(opts.outbox.waiting).toEqual([])
  })

  test("does not answer a sender who is not on the list", async () => {
    const { teams, opts, lines } = await start("echo")
    opts.admission = { allow: ["Someone Else"], bots: [], call: "" }
    await userSays("10", "ping")
    expect(await processNew(opts)).toBe(0)
    expect((await teams.readMessages()).length).toBe(3)
    expect(lines).toContain("not answered: the sender is not on the list")
  })

  test("stops echoing at the rate limit", async () => {
    const { opts, lines } = await start("echo")
    opts.limiter = new RateLimiter(1, 60_000)
    await userSays("10", "one")
    await userSays("11", "two")
    expect(await processNew(opts)).toBe(1)
    expect(lines.some((l) => l.startsWith("Rate limit"))).toBe(true)
  })
})

suite("describePage", () => {
  test("lists data-tid values, editable boxes and message elements, and no message text", async () => {
    const page = await (browser as Browser).newPage()
    await page.setContent(fakeChatHtml)
    const shape = await describePage(page)
    expect(shape.dataTidCounts["chat-pane-message"]).toBe(2)
    expect(shape.editable[0]?.dataTid).toBe("ckeditor")
    expect(shape.elementsWithDataMid.length).toBe(2)
    expect(shape.titleLike.some((t) => t.dataTid === "chat-title")).toBe(true)
    expect(JSON.stringify(shape)).not.toContain("line one")
  })
})
