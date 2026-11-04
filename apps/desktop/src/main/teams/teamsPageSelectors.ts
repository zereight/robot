// EVERY fact about the Teams web page is in this file, and only here: the address, the hosts of
// the sign-in, and the selectors of the elements that the app reads. A person who sees that the
// real page differs fixes this file and nothing else.
//
// STATUS: GUESSES. No one checked these values against the real Teams page. The values come from
// the public look of the Teams web client and from the first-step prototype of this repository,
// which is also unchecked. The shared tests use a stand-in page and show nothing about the real
// one (spec 028, "Acceptance"). If a value is wrong, the link shows "Teams cannot be reached", or
// "No chat found with this title", or "Sign in to Teams to go on" when the user is signed in. Fix
// the value, not the code around it.
//
// A selector may be a comma list. The first element that matches counts.

export const TEAMS_PAGE = {
  /** Where the Teams page loads. */
  url: "https://teams.cloud.microsoft/",

  /**
   * Hosts of the Microsoft sign-in. A page on one of these hosts is a sign-in form, whatever it
   * holds. A host matches when it is equal to one of these or ends with a dot and one of these.
   */
  signInHosts: ["login.microsoftonline.com", "login.live.com", "login.microsoft.com"],

  /** An element that only a sign-in form holds (the field for the name or the password). */
  signInForm: 'input[type="password"], input[name="loginfmt"], input[name="passwd"]',

  /** An element that only the signed-in Teams app holds: its chat list or its app bar. */
  appShell: '[data-tid="app-bar"], [data-tid="chat-list"], [data-tid="chat-pane-list"]',

  /** The title in the header of the open chat. */
  openChatTitle: '[data-tid="chat-title"], [data-tid="chat-header-title"]',

  /** One row of the chat list on the left. */
  chatListItem: '[data-tid="chat-list-item"], [data-tid="chat-list"] [role="treeitem"]',
  /** The element inside a row that holds the title of the chat. The row itself when none. */
  chatListItemTitle: '[data-tid="chat-list-item-title"], [data-tid="chat-title"]',

  // --- The messages of the open chat (S102) ----------------------------------------------------
  // STATUS: GUESSES, as all values in this file. They come from the public look of the Teams web
  // client, not from a check on the real page. Row 554 of `docs/spec-questions.md` lists the four
  // points that the spec relies on: a sender name on the messages of the user, a stable identity of
  // each message across reloads, the text of the message as plain text, and a time on each message.
  // If the real page differs, the link reads no message or reads wrong data: fix these values.

  /** One message of the open chat. The messages come in the order that the chat shows them. */
  messageItem: '[data-tid="message-pane-list-viewport"] [data-mid], [data-tid="chat-pane-message"]',
  /**
   * The attribute of a message that holds its identity. The identity must be the same after a
   * reload and after an edit. A message with no such attribute is keyed by sender and time.
   */
  messageIdAttribute: "data-mid",
  /** The element inside a message that holds the name of the sender. */
  messageSender: '[data-tid="message-author-name"]',
  /** The element inside a message that holds its text. */
  messageText: '[data-tid="chat-pane-message-body"], [data-tid="message-body-content"]',
  /** The element inside a message that holds its time. Its `datetime` attribute is read. */
  messageTime: "time[datetime]",
  /** An element inside a message that only a message of the signed-in user holds. */
  messageOwn: '[data-tid="my-message-marker"]',

  // --- Typing and sending (S103) ---------------------------------------------------------------
  // STATUS: GUESSES, as all values in this file. No one checked them on the real page. The app types
  // the text into the message box with the editing commands of the page (`insertText`) and presses
  // the send button. It does not press a key. If the real page ignores a typed text of a script, the
  // box keeps the text after the send: the app sees that, clears the box, and counts a failed try.
  // Then no answer reaches Teams. Fix these values first.

  /** The message box of the open chat: the element that takes the typed text. */
  messageBox:
    '[data-tid="ckeditor"][contenteditable="true"], [role="textbox"][contenteditable="true"]',
  /** The button that sends the typed message. */
  sendButton: '[data-tid="newMessageCommands-send"], [data-tid="send-message-button"]',
} as const

export type TeamsPageSelectors = typeof TEAMS_PAGE
