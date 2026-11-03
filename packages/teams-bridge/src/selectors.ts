// Every Teams-specific string lives here, in one place.
//
// STATUS: these are GUESSES for the new Teams web client. They are not checked
// against the real page. Run `bun run inspect` with a chat open, then fix this
// file. A value may be a comma list; the first match wins.

export interface Selectors {
  /** Header text of the open chat. Used as a guard before every send. */
  chatTitle: string
  /** One element for each message in the open chat. */
  message: string
  /** Attribute of a message element that holds a stable message id. */
  messageIdAttr: string
  messageAuthor: string
  messageBody: string
  /** Element with a `datetime` attribute. */
  messageTime: string
  /** The editable box where the user types. */
  compose: string
}

export const GUESSED: Selectors = {
  chatTitle: '[data-tid="chat-title"], [data-tid="chat-header-title"]',
  message: '[data-tid="chat-pane-message"]',
  messageIdAttr: "data-mid",
  messageAuthor: '[data-tid="message-author-name"]',
  messageBody: '[data-tid="message-body"], [id^="content-"]',
  messageTime: "time[datetime]",
  compose:
    '[data-tid="ckeditor"][contenteditable="true"], div[role="textbox"][contenteditable="true"]',
}
