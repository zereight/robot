import {
  pickChat,
  type TeamsChatOpened,
  type TeamsChatRead,
  type TeamsLook,
  type TeamsMessage,
  teamsNameKey,
} from "@robot/shared"
import type { PageBounds } from "../services/Platform.ts"
import { TEAMS_PAGE, type TeamsPageSelectors } from "./teamsPageSelectors.ts"

/**
 * The Teams page, as the Teams link sees it (spec 028). The link opens the chat, reads its title
 * and the sign-in, reads the messages of the open chat (S102), and types an answer into the message
 * box and sends it (S103).
 *
 * The real one runs scripts in a web view. A test gives the stand-in Teams (`fakeChat.testing.ts`).
 */
export interface TeamsSurface {
  /** True while the page is open. */
  isOpen(): boolean
  /** Opens the page when it is closed (this loads Teams), then says what the page shows. */
  look(): Promise<TeamsLook>
  /**
   * Opens the chat whose title holds `title`. It fails to open when no chat, or more than one
   * chat, holds the text. It types nothing and sends nothing.
   */
  openChat(title: string): Promise<TeamsChatOpened>
  /**
   * Reads the messages that the open chat shows, in the order that the chat shows them, and the
   * title of the open chat. It changes nothing in the page. It rejects when the page cannot be
   * read.
   */
  readMessages(): Promise<TeamsChatRead>
  /**
   * One try to write a message in the linked chat. It opens the chat when no chat is open. It reads
   * the title of the open chat in the same script that types: when the title does not hold
   * `chatTitle`, nothing is typed (`wrongChat`). Any other trouble, such as a page that does not
   * take the message, is `failed`. It never rejects.
   */
  send(text: string, chatTitle: string): Promise<TeamsSendResult>
  /** Shows the page in a place of the app window, or hides it with `undefined`. */
  place(bounds: PageBounds | undefined): void
  /** Lets the input of the user reach the page (the user signs in by hand), or keeps it out. */
  allowUserInput(allowed: boolean): void
  /** Closes the page at once. */
  close(): void
}

/** The result of one try to send a message. */
export type TeamsSendResult =
  | { readonly kind: "sent" }
  /** The open chat has another title. Nothing was typed. */
  | { readonly kind: "wrongChat" }
  | { readonly kind: "failed" }

/** What the surface needs from a web view. The real one is the browser page of the platform. */
export interface TeamsPageDriver {
  isOpen(): boolean
  /** Loads the address. It rejects when the page cannot load. */
  open(url: string): Promise<unknown>
  /** Runs a script in the page and gives back its result. */
  evaluate<T>(code: string): Promise<T>
  place(bounds: PageBounds | undefined): void
  allowUserInput(allowed: boolean): void
  close(): void
}

/**
 * The key of the Teams page among the pages of the platform. It is not the id of an agent, so no
 * agent reaches it.
 */
export const TEAMS_PAGE_KEY = "robot:teams-link"

// --- The scripts that run in the page ---------------------------------------------------------

/** What the read script gives back. Plain data, so it crosses the process boundary. */
export interface RawTeamsRead {
  readonly url: string
  /** The browser says that the computer has a network. */
  readonly online: boolean
  readonly signInForm: boolean
  readonly shell: boolean
  /** The page holds the standard regions of a loaded app (`appLandmarks`). */
  readonly landmarks: boolean
  readonly openTitle: string | null
  readonly chatTitles: readonly string[]
}

/** The script that reads the page. It changes nothing in the page. */
export const readScript = (sel: TeamsPageSelectors = TEAMS_PAGE): string => `(() => {
  const sel = ${JSON.stringify(sel)}
  const first = (selector, root) => (root || document).querySelector(selector)
  const text = (el) => (el ? String(el.innerText || el.textContent || "").trim() : "")
  const items = Array.from(document.querySelectorAll(sel.chatListItem))
  const open = text(first(sel.openChatTitle))
  return {
    url: String(location.href),
    online: navigator.onLine !== false,
    signInForm: first(sel.signInForm) !== null,
    shell: first(sel.appShell) !== null,
    landmarks: first(sel.appLandmarks) !== null,
    openTitle: open === "" ? null : open,
    chatTitles: items.map((item) => text(first(sel.chatListItemTitle, item) || item)),
  }
})()`

/** What the script that reads the messages gives back. Plain data. */
export interface RawMessagesRead {
  readonly openTitle: string | null
  readonly items: readonly {
    readonly id: string | null
    readonly sender: string
    readonly text: string
    readonly time: number | null
    readonly own: boolean
  }[]
}

/** The script that reads the messages of the open chat. It changes nothing in the page. */
export const readMessagesScript = (sel: TeamsPageSelectors = TEAMS_PAGE): string => `(() => {
  const sel = ${JSON.stringify(sel)}
  const first = (selector, root) => (root || document).querySelector(selector)
  const text = (el) => (el ? String(el.innerText || el.textContent || "").trim() : "")
  const open = text(first(sel.openChatTitle))
  const items = Array.from(document.querySelectorAll(sel.messageItem)).map((item) => {
    const stamp = first(sel.messageTime, item)
    const parsed = stamp ? Date.parse(String(stamp.getAttribute("datetime") || "")) : NaN
    const id = item.getAttribute(sel.messageIdAttribute)
    return {
      id: id ? String(id) : null,
      sender: text(first(sel.messageSender, item)),
      text: text(first(sel.messageText, item)),
      time: Number.isNaN(parsed) ? null : parsed,
      own: first(sel.messageOwn, item) !== null,
    }
  })
  return { openTitle: open === "" ? null : open, items }
})()`

/** The script that clicks a row of the chat list. It gives back false when the row is gone. */
export const clickChatScript = (
  index: number,
  sel: TeamsPageSelectors = TEAMS_PAGE,
): string => `(() => {
  const sel = ${JSON.stringify(sel)}
  const items = Array.from(document.querySelectorAll(sel.chatListItem))
  const item = items[${Math.trunc(index)}]
  if (!item) return false
  item.click()
  return true
})()`

/** What the script that sends gives back. Plain data. */
export type RawSend =
  | { readonly kind: "sent" }
  | { readonly kind: "wrongChat"; readonly title: string }
  | {
      readonly kind: "noTitle" | "noBox" | "noSend" | "notTyped" | "offline"
    }

/**
 * The script that types a message and sends it. It reads the title of the open chat first, in the
 * same run, and types nothing when the title does not hold the wanted text. `wanted` is the key of
 * the title of the link (`teamsNameKey`): the compare is the one of `holdsChatTitle`.
 */
export const sendScript = (
  text: string,
  wanted: string,
  sel: TeamsPageSelectors = TEAMS_PAGE,
): string => `(() => {
  const sel = ${JSON.stringify(sel)}
  const body = ${JSON.stringify(text)}
  const wanted = ${JSON.stringify(wanted)}
  const first = (selector) => document.querySelector(selector)
  const text = (el) => (el ? String(el.innerText || el.textContent || "").trim() : "")
  const key = (value) => String(value).normalize("NFC").trim().replace(/\\s+/g, " ").toLocaleLowerCase()
  if (navigator.onLine === false) return { kind: "offline" }
  const title = text(first(sel.openChatTitle))
  if (title === "") return { kind: "noTitle" }
  if (wanted === "" || !key(title).includes(wanted)) return { kind: "wrongChat", title }
  const box = first(sel.messageBox)
  if (!box) return { kind: "noBox" }
  box.focus()
  // The box is empty before the text goes in, so that a text of an earlier try is never sent twice.
  document.execCommand("selectAll", false)
  document.execCommand("delete", false)
  if (!document.execCommand("insertText", false, body)) return { kind: "notTyped" }
  const send = first(sel.sendButton)
  if (!send) return { kind: "noSend" }
  send.click()
  return { kind: "sent" }
})()`

/**
 * The script that looks at the message box after the send. A box that still holds text means that
 * the page did not take the message: the script clears the box, so that the next try starts clean.
 */
export const settleScript = (sel: TeamsPageSelectors = TEAMS_PAGE): string => `(() => {
  const sel = ${JSON.stringify(sel)}
  const box = document.querySelector(sel.messageBox)
  const left = box ? String(box.innerText || box.textContent || "").trim() : ""
  if (box && left !== "") {
    box.focus()
    document.execCommand("selectAll", false)
    document.execCommand("delete", false)
  }
  return { left: left !== "" }
})()`

// --- What the page shows ----------------------------------------------------------------------

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

const onHost = (url: string, hosts: readonly string[]) => {
  const host = hostOf(url)
  return host !== "" && hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

/** True when the address is a page of the Teams app. */
export const isTeamsAddress = (url: string, hosts: readonly string[] = TEAMS_PAGE.appHosts) =>
  onHost(url, hosts)

/** True when the address is a page of the Microsoft sign-in. */
export const isSignInAddress = (url: string, hosts: readonly string[] = TEAMS_PAGE.signInHosts) =>
  onHost(url, hosts)

/**
 * A load failure that means "the page cannot reach Microsoft". Other failures (a redirect that
 * stops the first load, for example) say nothing about the network.
 */
export const isOfflineError = (error: unknown): boolean =>
  /ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|FAILED)|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/.test(
    String(error instanceof Error ? error.message : error),
  )

/**
 * What the read says about the page. A sign-in form comes before the app. The app shows when the
 * page holds its shell, or when a page of the Teams host holds the regions of a loaded app: the
 * selector of the shell is a guess, and a user who is signed in must not see "not signed in".
 */
export const interpretRead = (raw: RawTeamsRead): TeamsLook => {
  if (!raw.online || raw.url.startsWith("chrome-error:")) return { kind: "offline" }
  if (raw.signInForm || isSignInAddress(raw.url)) return { kind: "signIn" }
  if (raw.shell || (raw.landmarks && isTeamsAddress(raw.url)))
    return { kind: "teams", openTitle: raw.openTitle }
  return { kind: "unreadable" }
}

// --- The surface ------------------------------------------------------------------------------

export interface TeamsSurfaceOptions {
  /** Waits between two reads while a click on a chat takes effect. A test gives a quick one. */
  readonly wait?: (ms: number) => Promise<void>
  readonly selectors?: TeamsPageSelectors
  /** Where the page loads. Only a test run sets it, to a stand-in site on this computer. */
  readonly url?: string
}

/** How long a click on a chat may take to show in the header: 12 reads, 250 ms apart. */
const OPEN_READS = 12
const OPEN_WAIT_MS = 250
/** How long the page may take to clear the message box after the send button was pressed. */
const SEND_SETTLE_MS = 600

/** Builds the surface on a web view. All the knowledge of the page is in the selectors module. */
export const createTeamsSurface = (
  driver: TeamsPageDriver,
  options: TeamsSurfaceOptions = {},
): TeamsSurface => {
  const sel = options.selectors ?? TEAMS_PAGE
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  /** The last load failed or the page shows an error page: the next look loads Teams again. */
  let reload = false

  const read = async (): Promise<RawTeamsRead | undefined> => {
    try {
      return await driver.evaluate<RawTeamsRead>(readScript(sel))
    } catch {
      return undefined
    }
  }

  const look = async (): Promise<TeamsLook> => {
    if (!driver.isOpen() || reload) {
      try {
        await driver.open(options.url ?? sel.url)
        reload = false
      } catch (error) {
        if (isOfflineError(error)) {
          reload = true
          return { kind: "offline" }
        }
        // A load that stops for another reason (a redirect) leaves a page that can be read.
        if (!driver.isOpen()) return { kind: "unreadable" }
        reload = false
      }
    }
    const raw = await read()
    if (!raw) return { kind: "unreadable" }
    const seen = interpretRead(raw)
    if (seen.kind === "offline") reload = true
    return seen
  }

  const openChat = async (title: string): Promise<TeamsChatOpened> => {
    const raw = await read()
    if (!raw) throw new Error("The Teams page cannot be read.")
    const pick = pickChat(raw.chatTitles, raw.openTitle, title)
    if (pick.kind !== "one") return { kind: pick.kind }
    // The open chat is the one: nothing to click.
    if (pick.index === null) return { kind: "opened", title: pick.title }
    if (raw.openTitle !== null && raw.openTitle === pick.title)
      return { kind: "opened", title: pick.title }
    const clicked = await driver.evaluate<boolean>(clickChatScript(pick.index, sel))
    if (!clicked) throw new Error("The chat row is gone.")
    // The header shows the new chat after a short time. It must show a title that holds the text.
    for (let i = 0; i < OPEN_READS; i++) {
      await wait(OPEN_WAIT_MS)
      const after = await read()
      if (after?.openTitle && pickChat([], after.openTitle, title).kind === "one")
        return { kind: "opened", title: after.openTitle }
    }
    throw new Error("The chat did not open.")
  }

  const readMessages = async (): Promise<TeamsChatRead> => {
    const raw = await driver.evaluate<RawMessagesRead>(readMessagesScript(sel))
    if (!raw || !Array.isArray(raw.items)) throw new Error("The Teams page cannot be read.")
    const messages: TeamsMessage[] = raw.items.map((item) => ({
      id: item.id,
      sender: item.sender,
      text: item.text,
      time: item.time,
      own: item.own,
    }))
    return { openTitle: raw.openTitle, messages }
  }

  const send = async (text: string, chatTitle: string): Promise<TeamsSendResult> => {
    const failed = { kind: "failed" } as const
    try {
      const raw = await read()
      if (!raw?.online) return failed
      // The link opens its chat when no chat is open (after a reload of the page, for example). A
      // chat that is open with another title is not changed: the script below refuses it.
      if (raw.openTitle === null) {
        const opened = await openChat(chatTitle)
        if (opened.kind !== "opened") return failed
      }
      const result = await driver.evaluate<RawSend>(sendScript(text, teamsNameKey(chatTitle), sel))
      if (!result) return failed
      if (result.kind === "wrongChat") return { kind: "wrongChat" }
      if (result.kind !== "sent") return failed
      await wait(SEND_SETTLE_MS)
      const after = await driver.evaluate<{ left: boolean }>(settleScript(sel))
      return after && !after.left ? { kind: "sent" } : failed
    } catch {
      return failed
    }
  }

  return {
    isOpen: () => driver.isOpen(),
    look,
    openChat,
    readMessages,
    send,
    place: (bounds) => driver.place(bounds),
    allowUserInput: (allowed) => driver.allowUserInput(allowed),
    close: () => {
      reload = false
      driver.close()
    },
  }
}
