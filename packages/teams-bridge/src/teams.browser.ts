import { afterAll, describe, expect, test } from "bun:test"
import type { Browser, Page } from "playwright-core"
import { fakeChatHtml } from "./fake-chat.ts"
import { GUESSED } from "./selectors.ts"
import { ChatMismatchError, TeamsPage } from "./teams.ts"
import { launchChrome } from "./test-browser.ts"

const browser: Browser | null = await launchChrome()
const suite = browser ? describe : describe.skip

// One browser for the whole file. It closes after the last test of the file.
afterAll(async () => {
  await browser?.close()
})

suite("TeamsPage on the fake page", () => {
  let page: Page
  let teams: TeamsPage

  const fresh = async () => {
    page = await (browser as Browser).newPage()
    await page.setContent(fakeChatHtml)
    teams = new TeamsPage(page, GUESSED)
  }

  test("reads the chat title", async () => {
    await fresh()
    expect(await teams.chatTitle()).toBe("Fake Person (You)")
  })

  test("reads messages in order, with id, author, text and time", async () => {
    await fresh()
    const msgs = await teams.readMessages()
    expect(msgs.length).toBe(2)
    expect(msgs[0]).toEqual({ id: "1", author: "Me", text: "first", time: "2026-11-03T10:00:00Z" })
    expect(msgs[1]?.text).toBe("line one\nline two")
  })

  test("sends a one-line text when the title matches", async () => {
    await fresh()
    await teams.send("[ROBot] hello", "(You)")
    const msgs = await teams.readMessages()
    expect(msgs.length).toBe(3)
    expect(msgs[2]?.text).toBe("[ROBot] hello")
  })

  test("keeps line breaks of a multi-line text", async () => {
    await fresh()
    await teams.send("[ROBot] a\nb\n\nc", "(You)")
    expect((await teams.readMessages()).at(-1)?.text).toBe("[ROBot] a\nb\n\nc")
  })

  test("refuses to send when the title does not match, and sends nothing", async () => {
    await fresh()
    await expect(teams.send("[ROBot] x", "Someone Else")).rejects.toBeInstanceOf(ChatMismatchError)
    expect((await teams.readMessages()).length).toBe(2)
  })

  test("refuses to send when no title is expected", async () => {
    await fresh()
    await expect(teams.send("[ROBot] x", "")).rejects.toBeInstanceOf(ChatMismatchError)
    expect((await teams.readMessages()).length).toBe(2)
  })

  test("refuses to send when the page has no title element", async () => {
    await fresh()
    await page.evaluate(() => document.querySelector('[data-tid="chat-title"]')?.remove())
    await expect(teams.send("[ROBot] x", "(You)")).rejects.toBeInstanceOf(ChatMismatchError)
    expect((await teams.readMessages()).length).toBe(2)
  })
})
