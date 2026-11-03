import type { PageBounds } from "../services/Platform.ts"
import { createTeamsSurface, type TeamsPageDriver, type TeamsSurface } from "./surface.ts"
import { TEAMS_PAGE } from "./teamsPageSelectors.ts"

// The stand-in Teams ("a fake chat") of spec 028, "Acceptance". It is a page with chats, each with
// a title and a list of messages (sender, text, time). It can show a sign-in form, change the open
// chat, drop the network, show a page that the app cannot read, and fail on request. The shared
// tests use it and never call the real Teams.
//
// The stand-in is a stub of the page, not a copy of the real one. It answers the scripts of the
// app by the selectors of `teamsPageSelectors.ts`, so a test runs the real scripts and the real
// reading code. It shows nothing about the real Teams page.
//
// Later slices extend it: S102 reads the messages of the open chat; S103 accepts a typed message.
// The data for both is here already (`messages`, `typed`).

export interface FakeMessage {
  readonly sender: string
  readonly text: string
  readonly time: number
}

export interface FakeRoom {
  title: string
  messages: FakeMessage[]
}

/** What the stub page shows. */
type Screen = "teams" | "signIn" | "broken"

const HOSTS = {
  teams: "https://teams.cloud.microsoft/",
  signIn: "https://login.microsoftonline.com/",
}

class StubElement {
  constructor(
    readonly text: string,
    private readonly inner: Record<string, StubElement> = {},
    private readonly onClick?: () => void,
  ) {}
  get innerText() {
    return this.text
  }
  get textContent() {
    return this.text
  }
  querySelector(selector: string): StubElement | null {
    return this.inner[selector] ?? null
  }
  click() {
    this.onClick?.()
  }
}

export class FakeChat {
  /** The chats of the stand-in, in the order of its chat list. */
  readonly rooms: FakeRoom[] = []
  /** The index of the chat that is open in the page, or null. */
  openIndex: number | null = null
  /** The computer has a network. */
  networkUp = true
  /** The session of the user: a sign-in form shows while it is false. */
  signedIn = false

  /** The times the app loaded the page. A new profile has none. */
  visits = 0
  /** The addresses the app loaded, in order. */
  readonly loads: string[] = []
  /** The scripts the app ran in the page. */
  evaluations = 0
  /** The texts the app typed into a chat. Empty until the slice that sends. */
  readonly typed: { chat: string; text: string }[] = []
  /** The messages the app read. Empty until the slice that reads. */
  messageReads = 0
  /** Where the page shows now, or undefined while it is hidden. */
  placed: PageBounds | undefined
  /** Whether the input of the user reaches the page. */
  inputAllowed = false
  /** What the user typed in the sign-in form. The stand-in keeps it; the app never sees it. */
  private lastPassword: string | undefined

  private open = false
  private url = ""
  private screen: Screen = "signIn"
  private evaluateFailures = 0

  // --- What a test does as the world ----------------------------------------------------

  /** Adds a chat to the chat list. */
  addChat(title: string, messages: FakeMessage[] = []): FakeRoom {
    const room: FakeRoom = { title, messages }
    this.rooms.push(room)
    return room
  }

  /** A person writes in a chat. */
  say(chat: string, sender: string, text: string, time = 0): FakeMessage {
    const room = this.rooms.find((r) => r.title === chat)
    if (!room) throw new Error(`The stand-in has no chat ${chat}`)
    const message: FakeMessage = { sender, text, time }
    room.messages.push(message)
    return message
  }

  /** The user opens a chat in the page. */
  openByUser(title: string) {
    const index = this.rooms.findIndex((r) => r.title === title)
    if (index < 0) throw new Error(`The stand-in has no chat ${title}`)
    this.openIndex = index
  }

  dropNetwork() {
    this.networkUp = false
    // A page that was open keeps its screen, but the browser knows that it is offline.
  }

  restoreNetwork() {
    this.networkUp = true
  }

  /** The session ends: the page shows a sign-in form. */
  endSession() {
    this.signedIn = false
    if (this.open) this.screen = "signIn"
    this.url = HOSTS.signIn
  }

  /** The user types the password in the sign-in form. The page then shows Teams. */
  signInByHand(password: string) {
    if (!this.open || this.screen !== "signIn")
      throw new Error("The stand-in shows no sign-in form to fill")
    this.lastPassword = password
    this.signedIn = true
    this.screen = "teams"
    this.url = HOSTS.teams
  }

  /** Teams changed its page: it shows neither the app nor a sign-in form. */
  breakPage(broken = true) {
    this.screen = broken ? "broken" : this.signedIn ? "teams" : "signIn"
  }

  /** The next `count` scripts fail, as when the page cannot be read. */
  failScripts(count: number) {
    this.evaluateFailures = count
  }

  /** The user closes the page. */
  closeByUser() {
    this.releasePage()
  }

  /** True while the page is open. */
  get isOpen() {
    return this.open
  }

  /** The password the user typed. It is here so that a test can look for it in files. */
  get password() {
    return this.lastPassword
  }

  // --- The page, as the app sees it -----------------------------------------------------

  private releasePage() {
    if (!this.open) return
    this.open = false
    this.placed = undefined
    this.inputAllowed = false
  }

  private shows(): Screen {
    return this.screen
  }

  private row(index: number): StubElement {
    const room = this.rooms[index] as FakeRoom
    const title = new StubElement(room.title)
    return new StubElement(room.title, { [TEAMS_PAGE.chatListItemTitle]: title }, () => {
      this.openIndex = index
    })
  }

  /** The stub of `document`, `location` and `navigator` that the scripts of the app run on. */
  private world() {
    const screen = this.shows()
    const rows = screen === "teams" ? this.rooms.map((_, i) => this.row(i)) : []
    const elements: Record<string, StubElement | null> = {
      [TEAMS_PAGE.signInForm]: screen === "signIn" ? new StubElement("") : null,
      [TEAMS_PAGE.appShell]: screen === "teams" ? new StubElement("") : null,
      [TEAMS_PAGE.openChatTitle]:
        screen === "teams" && this.openIndex !== null
          ? new StubElement((this.rooms[this.openIndex] as FakeRoom).title)
          : null,
    }
    return {
      document: {
        querySelector: (selector: string) => elements[selector] ?? null,
        querySelectorAll: (selector: string) => (selector === TEAMS_PAGE.chatListItem ? rows : []),
      },
      location: { href: this.networkUp ? this.url : "chrome-error://chromewebdata/" },
      navigator: { onLine: this.networkUp },
    }
  }

  /** The web view that the surface drives. */
  readonly driver: TeamsPageDriver = {
    isOpen: () => this.open,
    open: async (url) => {
      this.visits++
      this.loads.push(url)
      if (!this.networkUp) {
        this.open = true
        this.url = "chrome-error://chromewebdata/"
        throw new Error(`ERR_INTERNET_DISCONNECTED (-106) loading ${url}`)
      }
      this.open = true
      this.screen = this.signedIn ? "teams" : "signIn"
      this.url = this.signedIn ? HOSTS.teams : HOSTS.signIn
    },
    evaluate: async <T>(code: string): Promise<T> => {
      this.evaluations++
      if (!this.open) throw new Error("The stand-in page is not open")
      if (this.evaluateFailures > 0) {
        this.evaluateFailures--
        throw new Error("The stand-in page fails")
      }
      const { document, location, navigator } = this.world()
      return new Function("document", "location", "navigator", `return ${code}`)(
        document,
        location,
        navigator,
      ) as T
    },
    place: (bounds) => {
      this.placed = bounds
    },
    allowUserInput: (allowed) => {
      this.inputAllowed = allowed
    },
    close: () => this.releasePage(),
  }

  /** The surface for the Teams link: the real scripts on the stand-in page. */
  readonly surface: TeamsSurface = createTeamsSurface(this.driver, { wait: async () => {} })
}
