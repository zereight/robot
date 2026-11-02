import { Context } from "effect"

/** One browser window of one agent. Cookies and logins stay with the agent, on this computer. */
export interface BrowserPage {
  isOpen(): boolean
  /** Opens the window if needed and loads the address. */
  open(url: string): Promise<{ url: string; title: string }>
  read(): Promise<{ url: string; title: string; text: string }>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  /** Closes the window at once. */
  close(): void
  /** Calls back when the window is closed, by the agent, by Stop or by the user. */
  onClosed(listener: () => void): void
}

/** Things that need the operating system. The real one uses Electron; tests use a fake. */
export interface PlatformService {
  readonly appName: string
  readonly appVersion: string
  readonly platform: string
  readonly dataDir: string
  readonly defaultWorkspaceRoot: string
  systemLocale(): string
  pickFolder(defaultPath: string): Promise<string | undefined>
  /** Full paths of files that the user picks. Empty when cancelled. */
  pickFiles(): Promise<string[]>
  /** Where to save an archive, or undefined when cancelled. */
  pickSavePath(defaultName: string): Promise<string | undefined>
  /** An archive to open, or undefined when cancelled. */
  pickArchive(): Promise<string | undefined>
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
  setIslandShape(shape: "hidden" | "bar" | "attention"): void
  /** The browser window of an agent. The same agent always gets the same page object. */
  browser(agentId: string): BrowserPage
}

export class Platform extends Context.Service<Platform, PlatformService>()("robot/main/Platform") {}
