import type { Page } from "playwright-core"
import type { ChatMessage } from "./core.ts"
import type { Selectors } from "./selectors.ts"

/**
 * The open chat is not the expected chat. Another try does not help, so the answer is dropped
 * (`final`). A missing title can be a page that still loads, so that case is not final.
 */
export class ChatMismatchError extends Error {
  readonly final: boolean
  constructor(expected: string, actual: string | null, final = actual !== null) {
    super(
      actual === null
        ? `Refusing to send: the chat title was not found on the page (expected "${expected}").`
        : `Refusing to send: the open chat is "${actual}", expected a title with "${expected}".`,
    )
    this.final = final
  }
  override name = "ChatMismatchError"
}

/** Reads and writes the chat that is open in the page. Knows nothing about ROBot. */
export class TeamsPage {
  constructor(
    private readonly page: Page,
    private readonly sel: Selectors,
  ) {}

  async chatTitle(): Promise<string | null> {
    const el = this.page.locator(this.sel.chatTitle).first()
    if ((await el.count()) === 0) return null
    // biome-ignore lint/performance/useDomNodeTextContent: this is the Playwright method, which gives the text as the user sees it
    const text = (await el.innerText()).trim()
    return text === "" ? null : text
  }

  /** Messages that the page has rendered now, oldest first. A long chat renders only part. */
  async readMessages(): Promise<ChatMessage[]> {
    return this.page.$$eval(
      this.sel.message,
      // This callback runs in the browser. It can use only its own arguments, not outer variables.
      (els, s) =>
        els.map((el) => ({
          id: el.getAttribute(s.messageIdAttr) ?? "",
          // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps the line breaks of the text as the user sees it; textContent does not
          author: (el.querySelector(s.messageAuthor) as HTMLElement | null)?.innerText.trim() ?? "",
          // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps the line breaks of the text as the user sees it; textContent does not
          text: (el.querySelector(s.messageBody) as HTMLElement | null)?.innerText.trim() ?? "",
          time: el.querySelector(s.messageTime)?.getAttribute("datetime") ?? "",
        })),
      this.sel,
    )
  }

  /**
   * Types `text` in the box and presses Enter.
   * Fails closed: it checks the chat title first and throws when it does not match.
   */
  async send(text: string, expectTitle: string): Promise<void> {
    if (expectTitle === "") throw new ChatMismatchError("(no EXPECT_TITLE set)", null, true)
    const title = await this.chatTitle()
    if (title === null || !title.includes(expectTitle)) {
      throw new ChatMismatchError(expectTitle, title)
    }
    const box = this.page.locator(this.sel.compose).first()
    await box.click()
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await this.page.keyboard.press("Shift+Enter")
      const line = lines[i] as string
      if (line !== "") await this.page.keyboard.insertText(line)
    }
    await this.page.keyboard.press("Enter")
  }
}
