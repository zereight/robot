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
// S102 grew it: the messages of the open chat (sender, text, time, an identity, an own marker),
// an edit, a delete, a reload of the page, and a clock that a test moves. S103 grew it again: a
// message box that takes typed text and a send button that posts it, a send that the page refuses,
// and a header that shows a wrong chat title. The selectors are guesses, as all selectors.

export interface FakeMessage {
  /** The identity that the page gives to the message. It stays after an edit and a reload. */
  readonly id: string
  readonly sender: string
  text: string
  readonly time: number
  /** The page marks it as written by the user of this account. */
  readonly own: boolean
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
    private readonly attributes: Record<string, string> = {},
  ) {}
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }
  focus() {}
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

/** The message box of the stand-in page: its text is the text that waits to be sent. */
class StubComposer extends StubElement {
  constructor(
    private readonly read: () => string,
    private readonly onFocus: () => void,
  ) {
    super("")
  }
  override get innerText() {
    return this.read()
  }
  override get textContent() {
    return this.read()
  }
  override focus() {
    this.onFocus()
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
  /** The texts that were typed into a chat and accepted (a typed message becomes a message). */
  readonly typed: { chat: string; text: string }[] = []
  /** The times the send button was pressed. A refused press counts too. */
  sendTries = 0
  /** Each press of the send button, with the time of the stand-in and whether the page refused. */
  readonly presses: { at: number; refused: boolean; text: string }[] = []
  /**
   * The header of the page shows this title, whatever chat is open, until it is set to null. A
   * test uses it to show a wrong chat title.
   */
  headerTitle: string | null = null
  /** The text in the message box now. The page clears it when it takes the message. */
  composerText = ""
  /** The times the page was asked for the messages of the open chat. */
  messageReads = 0
  /**
   * The page gives an identity to each message. Set it to false to test a page that gives none:
   * the app then keys a message by sender and time.
   */
  identities = true
  /** The name that the page shows for the user of this account, on typed messages. */
  selfName = "Marta Kim"
  /** Where the page shows now, or undefined while it is hidden. */
  placed: PageBounds | undefined
  /** Whether the input of the user reaches the page. */
  inputAllowed = false
  /** What the user typed in the sign-in form. The stand-in keeps it; the app never sees it. */
  private lastPassword: string | undefined

  private open = false
  private composerFocused = false
  private sendRefusals = 0
  private url = ""
  private nextId = 1
  private clockNow: (() => number) | undefined
  private ownClock = 1_000_000
  private screen: Screen = "signIn"
  private evaluateFailures = 0

  // --- What a test does as the world ----------------------------------------------------

  /** Gives the stand-in the clock of a test, so that its messages carry the time of the test. */
  useClock(now: () => number) {
    this.clockNow = now
  }

  /** The time of the stand-in now, in ms. A test moves it with `advance`. */
  now(): number {
    return this.clockNow ? this.clockNow() : this.ownClock
  }

  /** Moves the own clock on. It has no effect when a test gave the stand-in its clock. */
  advance(ms: number) {
    this.ownClock += ms
  }

  /** Adds a chat to the chat list. */
  addChat(title: string, messages: Omit<FakeMessage, "id" | "own">[] = []): FakeRoom {
    const room: FakeRoom = { title, messages: [] }
    this.rooms.push(room)
    for (const m of messages) this.say(title, m.sender, m.text, m.time)
    return room
  }

  /** A person writes in a chat. The time is the time of the stand-in now, if none is given. */
  say(chat: string, sender: string, text: string, time = this.now(), own = false): FakeMessage {
    const room = this.rooms.find((r) => r.title === chat)
    if (!room) throw new Error(`The stand-in has no chat ${chat}`)
    const message: FakeMessage = { id: `m${this.nextId++}`, sender, text, time, own }
    room.messages.push(message)
    return message
  }

  /** A person edits a message. It keeps its identity and its place. */
  edit(message: FakeMessage, text: string) {
    message.text = text
  }

  /** A person deletes a message. */
  remove(message: FakeMessage) {
    for (const room of this.rooms) {
      const index = room.messages.indexOf(message)
      if (index >= 0) room.messages.splice(index, 1)
    }
  }

  /**
   * The Teams page reloads. The chats and their messages stay with the same identities, and the
   * page shows no open chat until a chat is opened.
   */
  reload() {
    this.loads.push(this.url)
    this.openIndex = null
  }

  /**
   * Accepts a text typed into the open chat, as the composer does: the text becomes a message of
   * the user of this account. It throws when no chat is open, as a composer that is not there.
   */
  type(text: string): FakeMessage {
    const room = this.openIndex === null ? undefined : this.rooms[this.openIndex]
    if (!room) throw new Error("The stand-in has no open chat to type in")
    this.typed.push({ chat: room.title, text })
    return this.say(room.title, this.selfName, text, this.now(), true)
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

  /**
   * The next `count` presses of the send button are refused: the page keeps the text in the
   * message box and posts nothing, as a page that does not take the message.
   */
  refuseSends(count: number) {
    this.sendRefusals = count
  }

  /**
   * The page refuses every press of the send button for which this returns true, whatever the
   * count of `refuseSends`. A test uses it to refuse one text and take the others.
   */
  refuseWhen: ((text: string) => boolean) | undefined

  /** The next `count` scripts fail, as when the page cannot be read. */
  failScripts(count: number) {
    this.evaluateFailures = count
  }

  /** The user closes the page. */
  closeByUser() {
    this.releasePage()
  }

  /** The user closes the window of the page: the page closes, and the link hears it. */
  dismissByUser() {
    if (!this.open) return
    this.releasePage()
    for (const dismissed of this.dismissers) dismissed()
  }

  private dismissers: (() => void)[] = []

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

  /** The elements of the messages of the open chat. */
  private messageElements(): StubElement[] {
    const room = this.openIndex === null ? undefined : this.rooms[this.openIndex]
    if (!room) return []
    return room.messages.map((m) => {
      const inner: Record<string, StubElement> = {
        [TEAMS_PAGE.messageText]: new StubElement(m.text),
        [TEAMS_PAGE.messageTime]: new StubElement("", {}, undefined, {
          datetime: new Date(m.time).toISOString(),
        }),
      }
      // A message with no sender shows no name element, as a page that hides the name.
      if (m.sender !== "") inner[TEAMS_PAGE.messageSender] = new StubElement(m.sender)
      if (m.own) inner[TEAMS_PAGE.messageOwn] = new StubElement("")
      return new StubElement(
        m.text,
        inner,
        undefined,
        this.identities ? { [TEAMS_PAGE.messageIdAttribute]: m.id } : {},
      )
    })
  }

  private row(index: number): StubElement {
    const room = this.rooms[index] as FakeRoom
    const title = new StubElement(room.title)
    return new StubElement(room.title, { [TEAMS_PAGE.chatListItemTitle]: title }, () => {
      this.openIndex = index
    })
  }

  /** The send button is pressed: the page posts the text of the message box, or refuses. */
  private pressSend() {
    this.sendTries++
    const byCount = this.sendRefusals > 0
    const refused = byCount || this.refuseWhen?.(this.composerText) === true
    this.presses.push({ at: this.now(), refused, text: this.composerText })
    if (refused) {
      if (byCount) this.sendRefusals--
      return
    }
    const text = this.composerText
    this.composerText = ""
    this.composerFocused = false
    if (text.trim() !== "") this.type(text)
  }

  /** The stub of `document`, `location` and `navigator` that the scripts of the app run on. */
  private world() {
    const screen = this.shows()
    const rows = screen === "teams" ? this.rooms.map((_, i) => this.row(i)) : []
    const chatOpen = screen === "teams" && this.openIndex !== null
    const headerTitle =
      screen !== "teams"
        ? null
        : (this.headerTitle ??
          (this.openIndex !== null ? (this.rooms[this.openIndex] as FakeRoom).title : null))
    const elements: Record<string, StubElement | null> = {
      [TEAMS_PAGE.signInForm]: screen === "signIn" ? new StubElement("") : null,
      [TEAMS_PAGE.appShell]: screen === "teams" ? new StubElement("") : null,
      [TEAMS_PAGE.openChatTitle]: headerTitle === null ? null : new StubElement(headerTitle),
      [TEAMS_PAGE.messageBox]: chatOpen
        ? new StubComposer(
            () => this.composerText,
            () => {
              this.composerFocused = true
            },
          )
        : null,
      [TEAMS_PAGE.sendButton]: chatOpen ? new StubElement("", {}, () => this.pressSend()) : null,
    }
    return {
      document: {
        querySelector: (selector: string) => elements[selector] ?? null,
        // The editing commands of the page, as far as the app uses them on the message box.
        execCommand: (name: string, _ui?: boolean, value?: string) => {
          if (name === "selectAll") return true
          if (name === "delete") {
            if (this.composerFocused) this.composerText = ""
            return true
          }
          if (name === "insertText") {
            if (!this.composerFocused) return false
            this.composerText += value ?? ""
            return true
          }
          return false
        },
        querySelectorAll: (selector: string) => {
          if (selector === TEAMS_PAGE.chatListItem) return rows
          if (selector === TEAMS_PAGE.messageItem && screen === "teams") {
            this.messageReads++
            return this.messageElements()
          }
          return []
        },
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
    onDismissed: (listener) => {
      this.dismissers.push(listener)
    },
  }

  /** The surface for the Teams link: the real scripts on the stand-in page. */
  readonly surface: TeamsSurface = createTeamsSurface(this.driver, { wait: async () => {} })
}
