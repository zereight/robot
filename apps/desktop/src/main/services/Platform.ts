import type { IslandShape, TeachEvent } from "@robot/shared"
import { Context } from "effect"
import type { TeamsSurface } from "../teams/surface.ts"
import type { Resolver } from "../web/fetch.ts"

/**
 * A place in the app window, in px from the top left corner of the window content. The page of an
 * agent browser fits into its place: it keeps its own size and ratio and is drawn smaller or
 * larger, so the place does not change the layout of the page.
 */
export interface PageBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The browser page of one agent. It shows inside the app window, in the place that the chat
 * screen gives it. Cookies and logins stay on this computer, with the browser profile of the agent
 * or with the agent when it has none.
 */
export interface BrowserPage {
  isOpen(): boolean
  /** Opens the page if needed and loads the address. */
  open(url: string): Promise<{ url: string; title: string }>
  read(): Promise<{ url: string; title: string; text: string }>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  /**
   * Runs a script in the page and gives back its result. Only the app's own pages use it (the
   * Teams page, spec 028). No tool of an agent passes text of a model to it.
   */
  evaluate<T>(code: string): Promise<T>
  /**
   * Shows the page in a place of the app window, or hides it when the place is `undefined`.
   * A hidden page keeps running, so the agent can go on with it. The size of the page does not
   * depend on the place, shown or hidden: only the scale of the picture does.
   */
  place(bounds: PageBounds | undefined): void
  /**
   * Lets the input of the user (clicks, keys) reach the page, or keeps it out. The steps of the
   * agent are not input of the user and do not depend on this. While the user does not hold the
   * page, the page never keeps the keyboard focus: if a load, an address or a link takes it from
   * the chat, it goes back (spec 007).
   */
  allowUserInput(allowed: boolean): void
  /** Closes the page at once. */
  close(): void
  /** Calls back when the page is closed, by the agent, by Stop or by the user. */
  onClosed(listener: () => void): void
  /**
   * Starts the recorder of "Teach a task" (spec 017), or stops it with `undefined`. While it runs,
   * the listener gets each page that opens and each step of the user. It goes on when the page
   * is closed and opened again.
   */
  record(listener: ((event: TeachEvent) => void) | undefined): void
}

/** Things that need the operating system. The real one uses Electron; tests use a fake. */
export interface PlatformService {
  readonly appName: string
  readonly appVersion: string
  readonly platform: string
  readonly dataDir: string
  readonly defaultWorkspaceRoot: string
  /**
   * The home folder of the user. The lists of sensitive places (spec 007) start here, so a test
   * gives a folder of its own and never reads a real place of the user.
   */
  readonly homeDir: string
  /** Looks up a host name for a web page fetch. A test gives a table of its own. */
  readonly resolveHost: Resolver
  systemLocale(): string
  pickFolder(defaultPath: string): Promise<string | undefined>
  /** Full paths of files that the user picks. Empty when cancelled. */
  pickFiles(): Promise<string[]>
  /** Where to save an archive, or undefined when cancelled. */
  pickSavePath(defaultName: string): Promise<string | undefined>
  /** An archive to open, or undefined when cancelled. */
  pickArchive(): Promise<string | undefined>
  /** Where to save an agent file, or undefined when cancelled. */
  pickAgentFileSave(defaultName: string): Promise<string | undefined>
  /** An agent file to open, or undefined when cancelled. */
  pickAgentFile(): Promise<string | undefined>
  /** Where to save a workflow file, or undefined when cancelled. */
  pickWorkflowFileSave(defaultName: string): Promise<string | undefined>
  /** A workflow file to open, or undefined when cancelled. */
  pickWorkflowFile(): Promise<string | undefined>
  openPath(path: string): Promise<void>
  /** Opens a file with the program of the system for it. */
  openFile(path: string): Promise<void>
  setStartAtLogin(enabled: boolean): void
  setThemeSource(theme: "system" | "dark" | "light"): void
  copyText(text: string): void
  openExternal(url: string): Promise<void>
  /** Moves a file or folder to the system trash. */
  trash(path: string): Promise<void>
  /** True while a window of the app has the focus. */
  isFocused(): boolean
  /** Shows a system notification. `onClick` runs when the user clicks it. */
  notify(notice: { title: string; body: string }, onClick: () => void): void
  /** Brings the main window to the front. */
  showWindow(): void
  /** The shape of the status island on macOS. Other systems ignore it. */
  setIslandShape(shape: IslandShape): void
  /** The island window takes the size of its content, in px. It stays at the top centre. */
  fitIsland(size: { width: number; height: number }): void
  /** The browser page of an agent. The same agent always gets the same page object. */
  browser(agentId: string): BrowserPage
  /**
   * Sets the browser profile whose saved data the browser of an agent uses, or `undefined` for the
   * own data of the agent. A page that is open for the agent closes when this changes the data it
   * uses. It does not open a page.
   */
  setBrowserProfile(agentId: string, profileId: string | undefined): void
  /** Deletes the saved data of a browser profile: cookies, sign-ins and the rest. */
  clearBrowserProfile(profileId: string): Promise<void>
  /**
   * The Teams page of the Teams link (spec 028). It is hidden until the user shows it. The same
   * call always gives the same surface.
   */
  teams(): TeamsSurface
  /**
   * Sets the browser profile that holds the sign-in of the Teams page, or `undefined` for none. An
   * open Teams page closes when this changes the data it uses.
   */
  setTeamsProfile(profileId: string | undefined): void
}

export class Platform extends Context.Service<Platform, PlatformService>()("robot/main/Platform") {}
