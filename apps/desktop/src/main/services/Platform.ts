import type { ControlExpect, ControlFacts, ControlPlace } from "@robot/shared"
import { Context } from "effect"
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
 * The browser page of one agent. It shows inside the app window. Cookies and logins stay on this computer, with the browser profile of the agent
 * or with the agent when it has none.
 */
/** One control of the page that the agent can use: a numbered line of the read list. */
export interface BrowserControl {
  /** The number of the control in the list, from 1. */
  index: number
  role: string
  label: string
}

/** One of the controls that fit an unclear target: its line in the candidate list. */
export interface BrowserCandidate {
  /** The number of the control in the read list, from 1. The agent picks it by this number. */
  index: number
  role: string
  label: string
  /** The place of the control on the page, in px from the top left corner of the page. */
  x: number
  y: number
}

/** A dialog of the page that waits for an answer (spec 007, "Page dialogs"). */
export interface BrowserDialog {
  readonly kind: "alert" | "confirm" | "prompt" | "beforeunload"
  readonly text: string
}

/** The short state that an action in the page (click, type) returns. */
export interface BrowserActionState {
  url: string
  title: string
  /** Whether the page still loads. */
  loading: boolean
  /** The control with the keyboard focus, as `role "label"`, or null. */
  focus: string | null
  /** The errors of the page since the last action. Reading them clears them. */
  errors: string[]
  /** A dialog of the page that the action opened and nobody answered yet. */
  dialog?: BrowserDialog | null
  /** True when the action opened a file chooser that the next upload answers. */
  chooser?: boolean
  /** A dialog that nobody answered in 30 seconds, and the page dismissed (spec 007). */
  dismissed?: BrowserDialog
}

/**
 * What a click or a type gives back: the new state, no fit, up to 5 candidates, or that the
 * control is not the one that was asked about (the page changed while a card waited). Nothing was
 * done in the last case.
 */
export type BrowserAct =
  | { ok: true; state: BrowserActionState }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "changed" }
  | { ok: false; reason: "many"; candidates: BrowserCandidate[]; total: number }

/** What the app knows about the one control that a target names, before an action on it. */
export type BrowserInspect =
  | { ok: true; facts: ControlFacts; formHost: string | null }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "many"; candidates: BrowserCandidate[]; total: number }

/**
 * Says if a page may go to an address (spec 007, "Addresses of a web page fetch"). The page asks
 * it for every request of its own: the first load, a redirect, a link, a frame, a script.
 */
export type NavigationPolicy = (url: string) => Promise<boolean>

export interface BrowserPage {
  isOpen(): boolean
  /** Opens the page if needed and loads the address. */
  open(url: string): Promise<{ url: string; title: string }>
  /** Reads the text and the numbered controls of the page, with the count of all controls. */
  read(): Promise<{
    url: string
    title: string
    text: string
    controls: BrowserControl[]
    total: number
  }>
  /**
   * Clicks the control that the target names: a number from the read list, or a CSS selector.
   * A selector that fits more than one control clicks nothing and names candidates instead.
   */
  click(target: string, expect?: ControlExpect): Promise<BrowserAct>
  /** Types into the control that the target names, with the same fit rules as a click. */
  type(target: string, text: string, expect?: ControlExpect): Promise<BrowserAct>
  /** Says what a click on this target would be, with the same fit rules as a click. */
  inspect(target: string): Promise<BrowserInspect>
  /** Chooses an option of a list: the option whose value or text is `value`. */
  select(target: string, value: string, expect?: ControlExpect): Promise<BrowserAct>
  /** A picture of the page as PNG. */
  screenshot(): Promise<Uint8Array>
  /**
   * Where a password, a code or a card field is: in the page itself, or in a frame (spec 007,
   * "Secure fields in frames"). Null when the page shows none.
   */
  securePlace(): Promise<ControlPlace | null>
  /** The dialog of the page that waits now, or null. A dialog nobody answers in 30 seconds is dismissed. */
  dialog(): BrowserDialog | null
  /** Answers the dialog that waits. Fails when none waits. */
  answerDialog(accept: boolean, text?: string): Promise<{ ok: boolean; state?: BrowserActionState }>
  /**
   * Fills the file chooser that an action opened with these files. Fails when no chooser waits.
   * The caller checked the paths.
   */
  upload(paths: string[]): Promise<{ ok: true } | { ok: false; reason: "no_chooser" | "failed" }>
  /** True while an action's file chooser waits for `upload`. */
  chooserOpen(): boolean
  /** Sets the rule for the addresses of this page, or removes it. */
  setPolicy(policy: NavigationPolicy | undefined): void
  /** Takes the hosts that the page was kept from since the last call. */
  drainBlocked(): string[]
  /** True while the page plays sound. */
  audible(): boolean
  /** The address of the page now, or an empty text when no page is open. */
  currentUrl(): string
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
  /** Where to save a workflow file, or undefined when cancelled. */
  pickWorkflowFileSave(defaultName: string): Promise<string | undefined>
  /** A workflow file to open, or undefined when cancelled. */
  pickWorkflowFile(): Promise<string | undefined>
  openPath(path: string): Promise<void>
  /** Opens a file with the program of the system for it. */
  openFile(path: string): Promise<void>
  setStartAtLogin(enabled: boolean): void
  /**
   * Stops the computer from going to sleep while `on` is true (spec 013, "Keep the computer
   * awake"). The screen may still go dark. The hold ends with the app. Calling it again with the
   * same value changes nothing.
   */
  setKeepAwake(on: boolean): void
  /** True while the app holds the computer awake. The system tells it, not the last call. */
  keepAwakeHeld(): boolean
  /** True while the computer runs on its battery. */
  onBattery(): boolean
  /** Calls back when the computer changes between its battery and power. */
  onPowerSource(listener: () => void): void
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
  /** The browser page of a workflow. The same workflow always gets the same page object. */
  browser(workflowId: string): BrowserPage
  /**
   * Sets the browser profile whose saved data the browser of an agent uses, or `undefined` for the
   * own data of the agent. A page that is open for the agent closes when this changes the data it
   * uses. It does not open a page.
   */
  setBrowserProfile(workflowId: string, profileId: string | undefined): void
  /** Deletes the saved data of a browser profile: cookies, sign-ins and the rest. */
  clearBrowserProfile(profileId: string): Promise<void>
  /**
   * Calls back when the system says that memory is low (spec 007, "Idle work"). The app then
   * unloads idle pages at once.
   */
  onLowMemory(listener: () => void): void
  /**
   * The diagnostic report of the whole app: the app screen, the Teams page and the browser pages
   * (sizes, places, counts of clicks), the processes, and the tail of each log. It holds no
   * secret, no text of a page and no message (spec 000). The text also stays in a file of the logs
   * folder, and `path` says where.
   */
  diagnosticReport(): Promise<{ text: string; path: string }>
}

export class Platform extends Context.Service<Platform, PlatformService>()("robot/main/Platform") {}
