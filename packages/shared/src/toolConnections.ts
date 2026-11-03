import { charLength, nameKey } from "./agents.ts"

// ---------------------------------------------------------------------------------------------
// Connections (spec 018): outside tool providers that speak MCP. This file holds the rules that
// do not need a program or a network: names, addresses, limits, the names that the model sees,
// the cut of a long result and the search of tools. The window and the main process share it.
// ---------------------------------------------------------------------------------------------

/** The longest name of a connection, in characters that the user sees. */
export const CONNECTION_NAME_MAX = 40
/** One server holds at most this many connections. */
export const CONNECTIONS_MAX = 20
/** An agent gets at most this many tools of one connection. */
export const CONNECTION_TOOLS_MAX = 100
/** A call of a tool ends with the reason "timed out" after this time. */
export const CONNECTION_CALL_MS = 60_000
/** The Test button gives up after this time. */
export const CONNECTION_TEST_MS = 20_000
/** A running call ends this soon after Stop. */
export const CONNECTION_STOP_MS = 2_000
/** A result is cut after this many characters. */
export const CONNECTION_RESULT_MAX = 100_000
/** A connection that was idle for this long stops. */
export const CONNECTION_IDLE_MS = 10 * 60_000
/** An agent that may use more tools than this gets the step "Search tools" (spec 018). */
export const TOOL_SEARCH_LIMIT = 20
/** The step "Search tools" gives at most this many tools. */
export const TOOL_SEARCH_RESULTS_MAX = 10
/** The name of the step "Search tools". It is a tool of the app, so no connection can use it. */
export const SEARCH_TOOLS_NAME = "search_tools"
/** The text of a tool that is cut, in characters. */
export const TOOL_TEXT_MAX = 20_000

/** The limits of the fields of the form. */
export const CONNECTION_FIELD_LIMITS = {
  command: 1_000,
  argument: 2_000,
  arguments: 100,
  folder: 1_000,
  address: 2_000,
  entries: 50,
  entryName: 200,
  entryValue: 10_000,
} as const

export type ToolConnectionKind = "program" | "web"
export const TOOL_CONNECTION_KINDS: readonly ToolConnectionKind[] = ["program", "web"]

/** A line of the form for an environment value or a header. */
export interface ConnectionEntryInput {
  readonly name: string
  /** The value that the user typed. Absent or empty for a secret keeps the saved value. */
  readonly value?: string
  readonly secret: boolean
}

/** What the form sends when the user saves or tests a connection. */
export interface ToolConnectionInput {
  readonly name: string
  readonly kind: ToolConnectionKind
  readonly command: string
  readonly args: readonly string[]
  /** The working folder. Empty means the home folder. */
  readonly folder: string
  readonly env: readonly ConnectionEntryInput[]
  readonly address: string
  readonly headers: readonly ConnectionEntryInput[]
  /** "all", or the ids of the agents that may use the connection. */
  readonly agents: "all" | readonly string[]
}

/** An environment value or a header as the page shows it. A secret value is never here. */
export interface ConnectionEntryView {
  readonly name: string
  readonly secret: boolean
  /** The value of a plain entry. Null for a secret. */
  readonly value: string | null
  /** For a secret: true when a value is in the keychain of this computer. */
  readonly saved: boolean
}

export interface ConnectionToolView {
  readonly name: string
  readonly description: string
  /** True when the connection marks the tool as one that only reads (spec 018, "Read-only mark"). */
  readonly readOnly: boolean
  /** False when the user turned this tool off. */
  readonly enabled: boolean
}

/** The reasons that a Test, or the start of a connection, fails (spec 018, "Flows"). */
export const CONNECTION_FAILURES = [
  "not_found",
  "ended",
  "timeout",
  "refused",
  "sign_in",
  "invalid",
] as const
export type ConnectionFailure = (typeof CONNECTION_FAILURES)[number]

export type ConnectionState = "off" | "untested" | "connected" | "error"

export interface ToolConnection {
  readonly id: string
  readonly name: string
  readonly kind: ToolConnectionKind
  readonly enabled: boolean
  readonly command: string
  readonly args: readonly string[]
  readonly folder: string
  readonly env: readonly ConnectionEntryView[]
  readonly address: string
  readonly headers: readonly ConnectionEntryView[]
  readonly agents: "all" | readonly string[]
  readonly state: ConnectionState
  /** The reason, when the state is "error". */
  readonly failure: ConnectionFailure | null
  /** The tools that the connection offered the last time that the app read them. */
  readonly tools: readonly ConnectionToolView[]
  /** True when the connection offers more than 100 tools: the agent gets the first 100. */
  readonly tooMany: boolean
  /** True when a secret value of the connection is missing on this computer. */
  readonly valueMissing: boolean
}

/** What a Test gives back. */
export type ConnectionTestResult =
  | { readonly ok: true; readonly tools: readonly ConnectionToolView[]; readonly tooMany: boolean }
  | { readonly ok: false; readonly failure: ConnectionFailure }

// ---------------------------------------------------------------------------------------------
// The checks of the form.
// ---------------------------------------------------------------------------------------------

export type ConnectionNameProblem = "empty" | "long" | "taken"

/**
 * Checks a name against the names of the other connections. The name has 1 to 40 characters
 * after the spaces at both ends are removed, and no two names are the same when case is ignored.
 */
export const checkConnectionName = (
  name: string,
  others: readonly string[],
): ConnectionNameProblem | null => {
  const length = charLength(name.trim())
  if (length < 1) return "empty"
  if (length > CONNECTION_NAME_MAX) return "long"
  const key = nameKey(name)
  return others.some((other) => nameKey(other) === key) ? "taken" : null
}

/** True when the server holds the most connections that it can. */
export const connectionsFull = (count: number) => count >= CONNECTIONS_MAX

export type AddressProblem = "invalid" | "scheme" | "credentials"

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * Checks the address of a web connection (spec 018, "Rules"). It uses https. An address on this
 * computer (`127.0.0.1`, `localhost` or `::1`) may use http. An address has no sign-in part.
 */
export const checkConnectionAddress = (text: string): AddressProblem | null => {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return "invalid"
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme"
  if (url.username || url.password) return "credentials"
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname.toLowerCase())) return "scheme"
  return url.hostname ? null : "invalid"
}

/** True when the address is on this computer. */
export const isLocalAddress = (text: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(text.trim()).hostname.toLowerCase())
  } catch {
    return false
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export type EntryProblem = "name" | "duplicate" | "value" | "many"

/**
 * Checks the lines of the form for environment values or for headers. A name is a word of
 * letters, digits and `_` for an environment value, and a token for a header. No two names are the
 * same (headers ignore case, as HTTP does).
 */
export const checkEntries = (
  entries: readonly ConnectionEntryInput[],
  what: "env" | "header",
): EntryProblem | null => {
  if (entries.length > CONNECTION_FIELD_LIMITS.entries) return "many"
  const seen = new Set<string>()
  for (const entry of entries) {
    const name = entry.name
    if (!name || name.length > CONNECTION_FIELD_LIMITS.entryName) return "name"
    if (!(what === "env" ? ENV_NAME : HEADER_NAME).test(name)) return "name"
    const key = what === "env" ? name : name.toLowerCase()
    if (seen.has(key)) return "duplicate"
    seen.add(key)
    const value = entry.value ?? ""
    if (value.length > CONNECTION_FIELD_LIMITS.entryValue) return "value"
    if (what === "header" && /[\r\n\0]/.test(value)) return "value"
    if (what === "env" && value.includes("\0")) return "value"
  }
  return null
}

export type ConnectionFormProblem =
  | "name_empty"
  | "name_long"
  | "name_taken"
  | "command_empty"
  | "command_long"
  | "arguments"
  | "folder"
  | "env"
  | "address_invalid"
  | "address_scheme"
  | "address_credentials"
  | "headers"

/**
 * The first problem of a whole form, or null. Only the fields of the chosen kind count: a web
 * connection holds no command and a program holds no address. `others` are the other names.
 */
export const checkConnection = (
  input: ToolConnectionInput,
  others: readonly string[],
): ConnectionFormProblem | null => {
  const name = checkConnectionName(input.name, others)
  if (name === "empty") return "name_empty"
  if (name === "long") return "name_long"
  if (name === "taken") return "name_taken"
  const limits = CONNECTION_FIELD_LIMITS
  if (input.kind === "program") {
    if (!input.command.trim()) return "command_empty"
    if (input.command.length > limits.command) return "command_long"
    if (
      input.args.length > limits.arguments ||
      input.args.some((a) => a.length > limits.argument || a.includes("\0"))
    )
      return "arguments"
    if (input.folder.length > limits.folder || input.folder.includes("\0")) return "folder"
    if (checkEntries(input.env, "env")) return "env"
    return null
  }
  const address = checkConnectionAddress(input.address)
  if (address === "invalid") return "address_invalid"
  if (address === "scheme") return "address_scheme"
  if (address === "credentials") return "address_credentials"
  if (input.address.length > limits.address) return "address_invalid"
  if (checkEntries(input.headers, "header")) return "headers"
  return null
}

/**
 * The command line that the form shows before the user confirms a program (spec 018, "Flows"):
 * the command and its arguments, each argument in quotes when it holds a space or a quote.
 */
export const commandLine = (command: string, args: readonly string[]): string =>
  [command.trim(), ...args]
    .map((part) => (/[\s"'\\]/.test(part) || part === "" ? JSON.stringify(part) : part))
    .join(" ")

// ---------------------------------------------------------------------------------------------
// The names that the model sees (spec 018, "Many tools").
// ---------------------------------------------------------------------------------------------

/** The longest name of a tool that a model accepts. */
export const MODEL_TOOL_NAME_MAX = 64
const ALIAS_PREFIX = "mcp__"

/**
 * A word of a connection name that is safe in the name of a tool: lower case letters, digits and
 * `-`. A name with no such letter (for example one in Hangul) gives "". The word never holds `__`,
 * so the name of a tool can be read back into its connection and its tool.
 */
export const connectionSlug = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "")

const safeToolPart = (tool: string): string => tool.replace(/[^A-Za-z0-9_-]+/g, "_") || "tool"

export interface AliasSource {
  readonly id: string
  readonly name: string
  readonly tools: readonly { readonly name: string }[]
}

export interface ToolTarget {
  readonly connectionId: string
  /** The name of the tool, as the connection gave it. */
  readonly tool: string
}

/**
 * The names that the model calls the tools by: `mcp__<word>__<tool>`, at most 64 characters, with
 * only letters, digits, `_` and `-`. The word comes from the name of the connection, with a short
 * piece of its id when the name has no usable letter or another connection took the word. A name
 * that two tools would share gets a number.
 */
export const toolAliases = (sources: readonly AliasSource[]): Map<string, ToolTarget> => {
  const out = new Map<string, ToolTarget>()
  const words = new Set<string>()
  for (const source of sources) {
    let word = connectionSlug(source.name) || `c${source.id.replace(/[^a-z0-9]/gi, "").slice(0, 6)}`
    if (words.has(word))
      word = `${word.slice(0, 17)}-${source.id.replace(/[^a-z0-9]/gi, "").slice(0, 6)}`
    words.add(word)
    const head = `${ALIAS_PREFIX}${word}__`
    for (const tool of source.tools) {
      const base = `${head}${safeToolPart(tool.name)}`.slice(0, MODEL_TOOL_NAME_MAX)
      let alias = base
      for (let n = 2; out.has(alias); n++) {
        const tail = `_${n}`
        alias = `${base.slice(0, MODEL_TOOL_NAME_MAX - tail.length)}${tail}`
      }
      out.set(alias, { connectionId: source.id, tool: tool.name })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The result of a call, and the search of tools.
// ---------------------------------------------------------------------------------------------

/** What the agent reads when a result was cut. */
export const RESULT_CUT_NOTE = `[The result was longer than ${CONNECTION_RESULT_MAX} characters and was cut.]`
/** What the agent reads for a tool that it did not find in this turn. */
export const UNKNOWN_TOOL_TEXT = "Unknown tool. Search for it first."
/** What the step "Search tools" says when nothing matches. */
export const NO_TOOL_FOUND_TEXT = "No tool found."
/** What the agent reads when a call ends at its time limit. */
export const CALL_TIMED_OUT_TEXT = "The call timed out."

/** Cuts a result at 100000 characters, and tells whether it did. The note says that it was cut. */
export const cutResult = (text: string): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= CONNECTION_RESULT_MAX) return { text, cut: false }
  const chars = [...text]
  if (chars.length <= CONNECTION_RESULT_MAX) return { text, cut: false }
  return {
    text: `${chars.slice(0, CONNECTION_RESULT_MAX).join("")}\n${RESULT_CUT_NOTE}`,
    cut: true,
  }
}

export interface SearchableTool {
  /** The name of the connection. */
  readonly connection: string
  readonly tool: string
  readonly description: string
  /** The name that the model calls the tool by. */
  readonly alias: string
}

/** The words of a search, without empty ones, at most 20, each cut at 100 characters. */
export const toolSearchWords = (query: string): string[] =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,;]+/)
        .map((w) => w.trim().slice(0, 100))
        .filter(Boolean),
    ),
  ].slice(0, 20)

/**
 * The tools that match a search. A tool matches when one of the words is in its name or its
 * description, with case ignored. At most 10 come back: the tools that match the most words
 * first, and equal tools in the order of the connection name and then the tool name.
 */
export const searchTools = (
  tools: readonly SearchableTool[],
  query: string,
): readonly SearchableTool[] => {
  const words = toolSearchWords(query)
  if (words.length === 0) return []
  return tools
    .map((tool) => {
      const text = `${tool.tool}\n${tool.description}`.toLowerCase()
      return { tool, hits: words.filter((w) => text.includes(w)).length }
    })
    .filter((x) => x.hits > 0)
    .sort(
      (a, b) =>
        b.hits - a.hits ||
        a.tool.connection.localeCompare(b.tool.connection) ||
        a.tool.tool.localeCompare(b.tool.tool),
    )
    .slice(0, TOOL_SEARCH_RESULTS_MAX)
    .map((x) => x.tool)
}

/** True when an agent that may use this many tools gets the step "Search tools" (spec 018). */
export const needsToolSearch = (count: number) => count > TOOL_SEARCH_LIMIT

/** The text that the step "Search tools" gives back to the agent. */
export const searchResultText = (found: readonly SearchableTool[]): string =>
  found.length === 0
    ? NO_TOOL_FOUND_TEXT
    : [
        `Found ${found.length} ${found.length === 1 ? "tool" : "tools"}. You can call them now, by the name in front.`,
        ...found.map(
          (t) =>
            `- ${t.alias} (connection "${t.connection}", tool "${t.tool}"): ${t.description.trim() || "No description."}`,
        ),
      ].join("\n")

/** The text that tells the agent what the step does, with the count and the connections. */
export const searchStepDescription = (count: number, connections: readonly string[]): string =>
  `Finds tools of the outside connections. You may use ${count} such tools, from the connections ${connections
    .map((c) => `"${c}"`)
    .join(
      ", ",
    )}, and you get none of them until you search. Give some words; the step gives back at most ${TOOL_SEARCH_RESULTS_MAX} tools whose name or description holds one of them. A tool that you found works for the rest of this turn.`

/** The label of the card of a call of a connection tool: the connection and the tool. */
export const connectionToolLabel = (connection: string, tool: string): string =>
  `${connection} · ${tool}`
