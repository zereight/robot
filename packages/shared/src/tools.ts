export const PERMISSION_LEVELS = ["read_only", "ask_all", "ask_risky", "full"] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
export const DEFAULT_PERMISSION: PermissionLevel = "ask_risky"

/**
 * True when `next` lets the agent do more without asking than `current` does. The order of
 * `PERMISSION_LEVELS` is the order of care, strictest first: Read only, Ask for everything, Ask for
 * risky steps, Full access (spec 007, 012).
 */
export const isLooser = (next: PermissionLevel, current: PermissionLevel) =>
  PERMISSION_LEVELS.indexOf(next) > PERMISSION_LEVELS.indexOf(current)

/** What the user answers to an approval card. */
export type ApprovalAnswer = "allow" | "always" | "deny"

export type RiskReason = "sudo" | "install" | "network" | "shell_pipe" | "delete_outside"

const INSTALL =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|global)|pip3?\s+install|brew\s+install|apt(?:-get)?\s+install|gem\s+install|cargo\s+install|go\s+install|choco\s+install|winget\s+install)\b/i
const NETWORK_SEND =
  /\b(?:curl|wget|http)\b[^|;&\n]*?\s(?:-d|--data\S*|-F|--form\S*|-T|--upload-file|--post\S*|-X\s*(?:POST|PUT|PATCH|DELETE))(?=\s|=|$)/i
const NETWORK_TOOLS = /(?:^|[\s;&|(])(?:scp|rsync|nc|ncat|netcat|ftp|sftp|telnet)\s/i
const SHELL_PIPE = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node)\b/i
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "del", "rd", "trash"])

/** Splits a command into words. Quotes group a word and are dropped. */
const tokenize = (text: string) =>
  [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "")

/** Words that run the next word as a command. */
const WRAPPERS = new Set(["xargs", "command", "env", "nohup", "time", "exec"])

/** Folds `.` and `..` away and returns the path as a list of names. */
const segments = (path: string) => {
  const out: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out
}

// This file also runs in the window, so it cannot use the path module of Node.
const isInside = (path: string, workspace: string) => {
  const target = path.replace(/\\/g, "/")
  const absolute = target.startsWith("/") || /^[a-zA-Z]:\//.test(target)
  const root = segments(workspace)
  const full = segments(absolute ? target : `${workspace}/${target}`)
  const fold = (x: string) => (/^[a-zA-Z]:$/.test(root[0] ?? "") ? x.toLowerCase() : x)
  return root.every((part, i) => fold(full[i] ?? "\0") === fold(part))
}

/** True when `path`, read from `workspace`, stays inside it. */
export const insideWorkspace = isInside

/**
 * Why a shell command is risky, or null. Risky: `sudo`, installing software, sending data over
 * the network, piping into a shell, and deleting outside the workspace.
 */
export const riskyReason = (command: string, workspace: string): RiskReason | null => {
  if (/(?:^|[\s;&|(])sudo\b/.test(command)) return "sudo"
  if (INSTALL.test(command)) return "install"
  if (NETWORK_SEND.test(command) || NETWORK_TOOLS.test(command)) return "network"
  if (SHELL_PIPE.test(command)) return "shell_pipe"
  // Each simple command of the line, split at ; & | and line ends.
  for (const part of command.split(/[;&|\n]+/)) {
    const tokens = tokenize(part.trim())
    let head = 0
    while (WRAPPERS.has(tokens[head] ?? "")) head++
    const name = (tokens[head] ?? "").split(/[\\/]/).pop() ?? ""
    if (!DELETERS.has(name)) {
      if (name === "find" && tokens.includes("-delete")) {
        const where = tokens.slice(head + 1).find((t) => !t.startsWith("-")) ?? "."
        if (!isInside(where, workspace)) return "delete_outside"
      }
      continue
    }
    for (const arg of tokens.slice(head + 1)) {
      if (arg.startsWith("-") && !arg.startsWith("-/")) continue
      // Variables and home paths cannot be checked, so they count as outside.
      if (/^[~$%]/.test(arg) || arg.includes("$(") || arg.includes("`")) return "delete_outside"
      if (!isInside(arg, workspace)) return "delete_outside"
    }
  }
  return null
}

/**
 * Whether a step waits for the user, by the permission level and the risk of the step. A step that
 * "Read only" lets run is asked about as at "Ask for risky steps": a read outside the workspace
 * asks. Which steps "Read only" lets run is `readOnlyRefuses` (spec 007).
 */
export const needsApproval = (level: PermissionLevel, risky: boolean) =>
  level === "ask_all" ? true : level === "full" ? false : risky

/** "Full access" asks the user to confirm when the user picks it. No other level asks (spec 007). */
export const levelNeedsConfirm = (level: PermissionLevel) => level === "full"

/**
 * The tools of the app that "Read only" lets run: read, list and search files, fetch a web page,
 * ask the user a question, save memory, read an article of knowledge, and list agents. Every other
 * tool is refused, also a tool that the app gets later (spec 007).
 */
export const READ_ONLY_TOOLS: readonly string[] = [
  "list_files",
  "read_file",
  "search_files",
  "fetch_url",
  "ask_user",
  "save_memory",
  "read_article",
  "list_agents",
]

/**
 * The tools that "Read only" hands to the guard of spec 007 ("Outside content"). The guard decides:
 * it refuses a request for a new secret and a request with a saved secret that uses a method other
 * than GET, and a change of the agent's own settings, and it writes the entry of the action log
 * with the level as the one who decided. A request with a saved secret that uses GET runs, and so
 * does a call of the settings tool that only reads.
 */
export const READ_ONLY_GUARDED_TOOLS: readonly string[] = [
  "ask_secret",
  "secret_request",
  "settings",
]

/** True when the level is "Read only" and the tool of the app is not one that it lets run. */
export const readOnlyRefuses = (level: PermissionLevel, tool: string) =>
  level === "read_only" &&
  !READ_ONLY_TOOLS.includes(tool) &&
  !READ_ONLY_GUARDED_TOOLS.includes(tool)

/**
 * The same rule for a step that a vendor program asks about, by the key of its card. The steps
 * that read files or fetch a page pass. A write, a command and any tool that the app does not know
 * are refused.
 */
export const readOnlyRefusesKey = (level: PermissionLevel, key: string) =>
  level === "read_only" &&
  !/^(?:read_file|list_files|fetch_url|web_search|network)(?::|$)/.test(key)

/** Why a step did not run. Only "read_only" exists now; rules come with their own reasons. */
export type RefusalReason = "read_only"
