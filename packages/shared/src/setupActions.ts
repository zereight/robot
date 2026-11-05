/**
 * Setup actions (spec 035). A repository names commands in `robot.json`. The app runs one when
 * the user picks it, runs the ones marked for a turn at the start of a turn, and runs the ones
 * marked for an own copy on the first turn in a linked worktree.
 */

/** The file name. It stays in English in every language. */
export const SETUP_FILE_NAME = "robot.json"

/** At most this many actions. A further one is ignored. */
export const SETUP_ACTIONS_MAX = 20

/** The longest name, in characters. */
export const SETUP_NAME_MAX = 80

/** The longest command, in characters. */
export const SETUP_COMMAND_MAX = 4000

/** The actions of one turn share this time, in milliseconds. */
export const SETUP_TIMEOUT_MS = 120_000

/** A file larger than this is unreadable. */
export const SETUP_FILE_MAX_BYTES = 65_536

/** One command the file names. */
export interface SetupAction {
  readonly name: string
  readonly command: string
  readonly onOwnCopy: boolean
  readonly onTurnStart: boolean
}

/** What the chat menu shows. The command is the title of the row, so the user can read it. */
export interface SetupActionInfo {
  readonly name: string
  readonly command: string
  readonly onOwnCopy: boolean
  readonly onTurnStart: boolean
}

/** The list for the chat header. */
export interface SetupList {
  readonly actions: readonly SetupActionInfo[]
  readonly allowed: boolean
  readonly unreadable: boolean
}

/** Why a command did not succeed. The chat shows a line for each one. */
export type SetupFailCode = "exit" | "timeout" | "spawn"

/** What a run from the menu ends as. */
export type SetupRunResult =
  | { readonly status: "ran" }
  | { readonly status: "failed"; readonly code: SetupFailCode }
  | { readonly status: "missing" }

/** A command that failed during a turn. */
export interface SetupFailure {
  readonly name: string
  readonly code: SetupFailCode
}

/** The file parsed, or a file that is not a setup list. */
export type SetupFile =
  | { readonly ok: true; readonly actions: readonly SetupAction[] }
  | { readonly ok: false }

const readField = (item: object, key: string): unknown =>
  Object.getOwnPropertyDescriptor(item, key)?.value

/** True, false, or absent. Any other value is not a mark. */
const mark = (item: object, key: string): boolean | undefined => {
  if (!Object.hasOwn(item, key)) return false
  const value = readField(item, key)
  if (value === true || value === false) return value
  return undefined
}

const parseAction = (item: unknown): SetupAction | undefined => {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined
  const name = readField(item, "name")
  const command = readField(item, "command")
  if (typeof name !== "string" || typeof command !== "string") return undefined
  const trimmedName = name.trim()
  const trimmedCommand = command.trim()
  if (trimmedName.length < 1 || trimmedName.length > SETUP_NAME_MAX) return undefined
  if (trimmedCommand.length < 1 || trimmedCommand.length > SETUP_COMMAND_MAX) return undefined
  const onOwnCopy = mark(item, "onOwnCopy")
  const onTurnStart = mark(item, "onTurnStart")
  if (onOwnCopy === undefined || onTurnStart === undefined) return undefined
  return { name: trimmedName, command: trimmedCommand, onOwnCopy, onTurnStart }
}

/**
 * Reads the text of `robot.json`. A file with no `setupActions` has an empty list. A file that is
 * not an object, or whose `setupActions` is not a list, is unreadable. A bad item is ignored.
 * Items after the first 20 are ignored.
 */
export function parseSetupFile(text: string): SetupFile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false }
  if (!Object.hasOwn(value, "setupActions")) return { ok: true, actions: [] }
  const raw = readField(value, "setupActions")
  if (!Array.isArray(raw)) return { ok: false }
  const actions: SetupAction[] = []
  for (const item of raw) {
    if (actions.length >= SETUP_ACTIONS_MAX) break
    const action = parseAction(item)
    if (action) actions.push(action)
  }
  return { ok: true, actions }
}

/** The text the allow follows. The same actions in the same order give the same text. */
export function setupCanon(actions: readonly SetupAction[]): string {
  return JSON.stringify(
    actions.map((action) => ({
      name: action.name,
      command: action.command,
      onOwnCopy: action.onOwnCopy,
      onTurnStart: action.onTurnStart,
    })),
  )
}

/** The name and the marks, for the menu. */
export function setupInfo(actions: readonly SetupAction[]): readonly SetupActionInfo[] {
  return actions.map((action) => ({
    name: action.name,
    command: action.command,
    onOwnCopy: action.onOwnCopy,
    onTurnStart: action.onTurnStart,
  }))
}
