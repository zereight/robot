import { pickChat, type TeamsChatOpened, type TeamsLook } from "@robot/shared"
import type { PageBounds } from "../services/Platform.ts"
import { TEAMS_PAGE, type TeamsPageSelectors } from "./teamsPageSelectors.ts"

/**
 * The Teams page, as the Teams link sees it (spec 028). The link opens the chat and reads its
 * title and the sign-in, and nothing more in this slice: the surface has no way to read a message
 * and no way to type. Later slices add those methods here.
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
  /** Shows the page in a place of the app window, or hides it with `undefined`. */
  place(bounds: PageBounds | undefined): void
  /** Lets the input of the user reach the page (the user signs in by hand), or keeps it out. */
  allowUserInput(allowed: boolean): void
  /** Closes the page at once. */
  close(): void
}

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
    openTitle: open === "" ? null : open,
    chatTitles: items.map((item) => text(first(sel.chatListItemTitle, item) || item)),
  }
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

// --- What the page shows ----------------------------------------------------------------------

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/** True when the address is a page of the Microsoft sign-in. */
export const isSignInAddress = (url: string, hosts: readonly string[] = TEAMS_PAGE.signInHosts) => {
  const host = hostOf(url)
  return host !== "" && hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * A load failure that means "the page cannot reach Microsoft". Other failures (a redirect that
 * stops the first load, for example) say nothing about the network.
 */
export const isOfflineError = (error: unknown): boolean =>
  /ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT|FAILED)|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/.test(
    String(error instanceof Error ? error.message : error),
  )

/** What the read says about the page. A sign-in form comes before the app. */
export const interpretRead = (raw: RawTeamsRead): TeamsLook => {
  if (!raw.online || raw.url.startsWith("chrome-error:")) return { kind: "offline" }
  if (raw.signInForm || isSignInAddress(raw.url)) return { kind: "signIn" }
  if (raw.shell) return { kind: "teams", openTitle: raw.openTitle }
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

  return {
    isOpen: () => driver.isOpen(),
    look,
    openChat,
    place: (bounds) => driver.place(bounds),
    allowUserInput: (allowed) => driver.allowUserInput(allowed),
    close: () => {
      reload = false
      driver.close()
    },
  }
}
