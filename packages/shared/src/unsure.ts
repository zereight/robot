import { DECISION_WAIT_MS } from "./decision.ts"
import { redactSecrets } from "./redact.ts"
import { lexCommand, simpleCommands } from "./sensitive.ts"
import type { PermissionLevel, RiskReason } from "./tools.ts"

// ---------------------------------------------------------------------------------------------
// The level "Ask when unsure" (spec 007). The decision model checks a risky step against the
// words of the user. When the check is not sure, slow, off or failed, the step asks the user: it
// never runs by default.
// ---------------------------------------------------------------------------------------------

/** The step runs with no card when "The user asked for this" has at least this probability. */
export const CHECK_MIN = 0.9
/** The app waits at most this long for the check. After it, the step asks the user. */
export const PERMISSION_CHECK_WAIT_MS = DECISION_WAIT_MS
/** The words of the user that go to the check: the last 2000 characters. */
export const CHECK_WORDS_MAX = 2000
/** A command of more than this many characters is not checked. */
export const CHECK_COMMAND_MAX = 500

/**
 * How a risky step meets the level (spec 007, "Ask when unsure"):
 * - `hard`: it follows "Ask for risky steps" and never goes to the check,
 * - `checked`: it may go to the check, when the rules of `noCheckReason` let it,
 * - `plain`: it is not risky and runs with no question.
 */
export type StepClass = "hard" | "checked" | "plain"

/**
 * The target of a checked step: a command that installs software or uses the network to send
 * data, or a call of a tool of a connection. The check gets the full command, or the name of the
 * connection and the name of the tool, and never the arguments of a tool.
 */
export type CheckTarget =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "connection"; readonly connection: string; readonly tool: string }

/**
 * The class of a step. Only the steps that spec 007 names as checked can be `checked`: an
 * install command, a command that sends data over the network, and a call of a connection tool.
 * Every other risky step is hard, so a step that the spec does not name never goes to the check.
 * `target` is null for a step that cannot be checked.
 */
export const stepClass = (risky: boolean, target: CheckTarget | null): StepClass =>
  !risky ? "plain" : target ? "checked" : "hard"

/**
 * The target of a risky shell command, or null when the command is a hard step: `sudo`, a delete
 * outside the workspace, a pipe into a shell, and a change to a control place never go to the
 * check. An install command and a command that sends data can.
 */
export const commandTarget = (
  command: string,
  reason: RiskReason | null,
  changesControl: boolean,
): CheckTarget | null =>
  !changesControl && (reason === "install" || reason === "network")
    ? { kind: "command", command }
    : null

// ---------------------------------------------------------------------------------------------
// What never goes to the check.
// ---------------------------------------------------------------------------------------------

/** Why a checked step did not go to the check. The step asks the user with the normal card. */
export type NoCheckReason = "outside" | "sensitive" | "no_words" | "long_command" | "script"

/** Programs that read a file as a script when they get a file name. */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "node",
  "nodejs",
  "deno",
  "tsx",
  "ts-node",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "swift",
  "Rscript",
  "python",
  "python2",
  "python3",
])

/** Flags that give the code in the command itself, so no file runs. */
const INLINE_FLAGS = new Set(["-c", "-e", "-p", "--eval", "--print", "-E"])

/** Task runners that read their commands from a file of the folder. */
const TASK_RUNNERS = new Set([
  "make",
  "gmake",
  "just",
  "rake",
  "ninja",
  "gradle",
  "mvn",
  "ant",
  "task",
  "npx",
  "bunx",
  "pnpx",
])

/** The subcommands of a package manager that run a script of the project. */
const PACKAGE_RUNS = new Set([
  "run",
  "run-script",
  "start",
  "stop",
  "restart",
  "test",
  "t",
  "tst",
  "exec",
  "x",
  "dlx",
  "create",
])

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])
const INSTALLERS = new Set(["pip", "pip3"])
const BUILDERS = new Set(["cargo", "go"])
const BUILD_RUNS = new Set(["run", "build", "test", "bench", "r", "b", "t", "generate", "xtask"])

/** Words that run the next word as a command, and words that set a variable. */
const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "nohup",
  "time",
  "exec",
  "xargs",
  "nice",
  "doas",
])

const SCRIPT_FILE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|tsx|rb|pl|php|lua|command)$/i

const isPath = (word: string) => word.includes("/") || word.startsWith("~") || word.startsWith(".")

/** The program (as written) and the arguments of a simple command, or null. */
const headOf = (
  words: readonly string[],
): { written: string; name: string; args: string[] } | null => {
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word) || /^-/.test(word)) i++
    else break
  }
  const written = words[i]
  if (written === undefined) return null
  return { written, name: written.split("/").pop() ?? written, args: words.slice(i + 1) }
}

/**
 * True when a command runs a script file of the workspace or of another folder (spec 007, "Ask
 * when unsure"). A short command can start a long script that any turn wrote, and the check
 * cannot read the script. Cases:
 * - a program given as a path (`./run.sh`, `/tmp/x`, `~/bin/tool`), or read with `source` or `.`,
 * - an interpreter with a file (`python3 build.py`, `node app.js`, `bash setup.sh`), but not
 *   with code in the command itself (`python3 -c "..."`),
 * - a task runner that reads its commands from a file (`make`, `just`, `npm run`, `npx`),
 * - `cargo run`, `go run` and the like, and an install from a folder (`pip install .`).
 * It looks at every simple command of the line. A command that cannot be read counts as a script
 * only when it shows one of the cases above, so the help is not a wall: it errs towards asking.
 */
export const runsScript = (command: string): boolean => {
  for (const words of simpleCommands(lexCommand(command))) {
    const head = headOf(words)
    if (!head) continue
    if (isPath(head.written) || head.name === "source" || head.written === ".") return true
    if (TASK_RUNNERS.has(head.name)) return true
    const sub = head.args.find((a) => !a.startsWith("-"))
    if (PACKAGE_MANAGERS.has(head.name)) {
      if (sub !== undefined && (PACKAGE_RUNS.has(sub) || SCRIPT_FILE.test(sub) || isPath(sub)))
        return true
      continue
    }
    if (BUILDERS.has(head.name)) {
      if (sub !== undefined && BUILD_RUNS.has(sub)) return true
      continue
    }
    if (INSTALLERS.has(head.name)) {
      // `pip install .` and `pip install ./pkg` run the build files of that folder.
      if (head.args.some((a) => !a.startsWith("-") && isPath(a) && !/^https?:\/\//.test(a)))
        return true
      continue
    }
    if (/^python[\d.]*$/.test(head.name) || INTERPRETERS.has(head.name)) {
      if (head.args.some((a) => INLINE_FLAGS.has(a))) continue
      if (head.args.includes("-m")) return true
      if (head.args.some((a) => !a.startsWith("-"))) return true
    }
  }
  return false
}

/** What decides if a checked step goes to the check. */
export interface CheckGate {
  /** True when the turn holds outside content, in this turn or in an earlier turn that the agent sees. */
  readonly outside: boolean
  /** True when the turn holds a sensitive read. */
  readonly sensitive: boolean
  /** The words of the user for this turn, or null when the turn has none. */
  readonly words: string | null
  readonly target: CheckTarget
}

/**
 * Why a checked step does not go to the check, or null when it may (spec 007, "Ask when unsure").
 * A step that does not go asks the user with the normal approval card, and the decision model gets
 * no request:
 * - the turn holds outside content (outside text can steer what the agent writes in a step),
 * - the turn holds a sensitive read (the agent has seen keys or logins),
 * - the turn has no words of the user,
 * - the command has more than 500 characters,
 * - the command runs a script file.
 */
export const noCheckReason = (gate: CheckGate): NoCheckReason | null => {
  if (gate.outside) return "outside"
  if (gate.sensitive) return "sensitive"
  if (gate.words === null || gate.words.trim() === "") return "no_words"
  if (gate.target.kind === "command") {
    if (gate.target.command.length > CHECK_COMMAND_MAX) return "long_command"
    if (runsScript(gate.target.command)) return "script"
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// The words of the user.
// ---------------------------------------------------------------------------------------------

/**
 * The words of the user for a turn, from the texts that count (spec 007, "Words of the user"): the
 * messages of the user that started the turn or joined it, the prompt of a routine, the job
 * message of a part, the text of a request for changes. The caller passes only the texts that
 * count. Empty texts are dropped. Returns null when no text is left.
 */
export const joinWords = (texts: readonly (string | null | undefined)[]): string | null => {
  const kept = texts.map((t) => (t ?? "").trim()).filter((t) => t !== "")
  return kept.length > 0 ? kept.join("\n\n") : null
}

/** Text with keys hidden, then the last `max` characters. */
const tail = (text: string, max: number): string => {
  const chars = [...redactSecrets(text)]
  return chars.length > max ? chars.slice(chars.length - max).join("") : chars.join("")
}

// ---------------------------------------------------------------------------------------------
// The request to the decision model, and its answer.
// ---------------------------------------------------------------------------------------------

export const CHECK_ASKED = "asked"
export const CHECK_NOT_ASKED = "not_asked"

/**
 * The request for the Decisions API: one Choice question with two options, "The user asked for
 * this" and "The user did not ask for this". It holds the words of the user (the last 2000
 * characters), the kind of the step, and its target: the full command, or the name of the
 * connection and the name of the tool. It holds no arguments of a tool, no output of a tool, no
 * web page, no reply or thinking of the agent, no memory, no file and no value of a secret. Text
 * that looks like a key is hidden first (spec 014).
 */
export const buildCheckRequest = (
  model: string,
  input: { readonly words: string; readonly target: CheckTarget },
) => ({
  model,
  state: {
    words_of_the_user: tail(input.words, CHECK_WORDS_MAX),
    step:
      input.target.kind === "command"
        ? { kind: "command", command: redactSecrets(input.target.command) }
        : {
            kind: "tool of a connection",
            connection: redactSecrets(input.target.connection),
            tool: redactSecrets(input.target.tool),
          },
  },
  questions: {
    ask: {
      type: "choice" as const,
      instructions:
        "An AI agent wants to take the step. Does the user ask for this step in the words of the user? Choose the option that fits.",
      criteria: {
        [CHECK_ASKED]: "The user asked for this",
        [CHECK_NOT_ASKED]: "The user did not ask for this",
      },
    },
  },
})

/** Why the check did not allow the step. The step asks the user in every case. */
export const CHECK_REASONS = [
  "unsure",
  "timeout",
  "network_error",
  "service_error",
  "unreadable",
  "not_set_up",
] as const
export type CheckReason = (typeof CHECK_REASONS)[number]

export const isCheckReason = (v: unknown): v is CheckReason =>
  typeof v === "string" && (CHECK_REASONS as readonly string[]).includes(v)

/** The answer of one check. The step runs only when `allowed` is true. */
export type CheckResult =
  | { readonly allowed: true; readonly probability: number; readonly ms: number }
  | {
      readonly allowed: false
      readonly reason: CheckReason
      readonly probability: number | null
      readonly ms: number
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Reads the body of an answer. The step may run only when "The user asked for this" is the most
 * likely option and has a probability of at least 0.9. Every other body, also one that the app
 * cannot read, is not sure: the step asks the user.
 */
export const readCheckAnswer = (
  body: unknown,
):
  | { ok: true; probability: number }
  | { ok: false; reason: CheckReason; probability: number | null } => {
  const answer = isRecord(body) && isRecord(body.answers) ? body.answers.ask : undefined
  if (!isRecord(answer) || answer.type !== "choice" || typeof answer.choice !== "string")
    return { ok: false, reason: "unreadable", probability: null }
  if (!isRecord(answer.probabilities)) return { ok: false, reason: "unreadable", probability: null }
  const asked = answer.probabilities[CHECK_ASKED]
  if (typeof asked !== "number" || !Number.isFinite(asked))
    return { ok: false, reason: "unreadable", probability: null }
  if (answer.choice !== CHECK_ASKED) return { ok: false, reason: "unsure", probability: asked }
  for (const other of Object.values(answer.probabilities))
    if (typeof other === "number" && other > asked)
      return { ok: false, reason: "unsure", probability: asked }
  return asked >= CHECK_MIN
    ? { ok: true, probability: asked }
    : { ok: false, reason: "unsure", probability: asked }
}

// ---------------------------------------------------------------------------------------------
// The level and its fall back.
// ---------------------------------------------------------------------------------------------

/** Where an agent runs its steps: with the tools of the app, or on a program of a vendor (006). */
export interface LevelEnv {
  /** True when the switch "Permission checks" is on (013). */
  readonly checks: boolean
  /** True when the agent runs on a vendor runtime. */
  readonly runtime: boolean
}

/** Why "Ask when unsure" works as "Ask for risky steps", or null when it works as it says. */
export type LevelFallback = "checks_off" | "runtime"

export const levelFallback = (level: PermissionLevel, env: LevelEnv): LevelFallback | null =>
  level !== "ask_unsure" ? null : env.runtime ? "runtime" : env.checks ? null : "checks_off"

/**
 * The level that a turn works at. "Ask when unsure" works as "Ask for risky steps" when the
 * switch "Permission checks" is off, and for an agent on a vendor runtime (spec 007). Every other
 * level stays.
 */
export const effectiveLevel = (level: PermissionLevel, env: LevelEnv): PermissionLevel =>
  levelFallback(level, env) ? "ask_risky" : level

/**
 * True when the level may be picked: "Ask when unsure" needs the switch "Permission checks" on and
 * an agent that uses the tools of the app. The agent that has the level already keeps it in the
 * picker, so that the user sees what is set (the line under the level says how it works).
 */
export const levelPickable = (level: PermissionLevel, env: LevelEnv): boolean =>
  level !== "ask_unsure" || (env.checks && !env.runtime)

/**
 * The level for an agent that runs on a vendor runtime: "Ask when unsure" works as "Ask for risky
 * steps" there, because the program decides its own steps (spec 007). Every other level stays.
 */
export const levelOnRuntime = (level: PermissionLevel, runtime: boolean): PermissionLevel =>
  runtime && level === "ask_unsure" ? "ask_risky" : level
