import type { RuntimeKind } from "@robot/shared"
import { runtimeEnv } from "./env.ts"
import { execute } from "./proc.ts"

/**
 * Whether a program has a mode in which it blocks changes to files and commands itself (spec 007,
 * "Permission levels"). The app does not guess. It asks the program for its help text, with no
 * model turn, and the program has the mode when that text names the controls that the app sets at
 * "Read only". A program that does not answer, or whose text lacks one of them, has no such mode.
 *
 * What the app sets, and where this was found (the help text of the program on the computer of the
 * author, and the public documentation of each vendor):
 * - Claude Code: `--tools` limits the built-in tools to Read, Grep, Glob, WebFetch and WebSearch.
 *   The program has no tool left that writes a file or runs a command.
 * - Codex: `--sandbox read-only`. The sandbox of the system blocks every write and delete.
 * - Muse Code: `--disable-write` and `--disable-shell`. The program removes the tools.
 * - pi: `--tools read,grep,find,ls`. The help text of the program names this as its read-only mode.
 * - Pi-Bolt: none. It was not on the computer, so no help text could show a mode.
 * - opencode: none. Its help text names no mode that blocks changes. It blocks tools by rules in
 *   its settings, and a rule is not a mode that the help text names. The app uses those rules for
 *   "Ask for everything" and below, but "Read only" does not start (spec 007).
 * - Cursor: `--mode ask`. The help text calls that mode read-only. Plan mode does not count.
 */
export interface HelpCheck {
  /** The arguments that print a help text. */
  readonly args: readonly string[]
  /** Each of these has to be in the text. */
  readonly needs: readonly RegExp[]
}

export const READ_ONLY_HELP: Record<RuntimeKind, readonly HelpCheck[]> = {
  claude_code: [{ args: ["--help"], needs: [/(^|\s)--tools\b/m] }],
  codex: [{ args: ["exec", "--help"], needs: [/--sandbox\b/, /\bread-only\b/] }],
  // The headless run and the session host are two programs in one: both have to name the controls.
  muse: [
    { args: ["exec", "--help"], needs: [/--disable-write\b/, /--disable-shell\b/] },
    { args: ["serve", "--help"], needs: [/--disable-write\b/, /--disable-shell\b/] },
  ],
  pi: [{ args: ["--help"], needs: [/(^|\s)--tools\b/m] }],
  // No check: a program with no check has no mode.
  opencode: [],
  cursor: [{ args: ["--help"], needs: [/(^|\s)--mode\b/, /\bask\b/, /\bread-only\b/] }],
}

const HELP_MS = 15_000

/** True when the help text of the program at `bin` names every control for its read-only mode. */
export const hasReadOnlyMode = async (kind: RuntimeKind, bin: string): Promise<boolean> => {
  const env = runtimeEnv(process.env, undefined, kind)
  if (READ_ONLY_HELP[kind].length === 0) return false
  for (const check of READ_ONLY_HELP[kind]) {
    const done = await execute(bin, check.args, { env, timeoutMs: HELP_MS })
    if (done.failure !== undefined || done.code !== 0) return false
    const text = `${done.stdout}\n${done.stderr}`
    if (!check.needs.every((need) => need.test(text))) return false
  }
  return true
}
