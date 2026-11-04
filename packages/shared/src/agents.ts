import { Schema } from "effect"
import type { ModelHold } from "./backup.ts"
import type { PlaceOutside } from "./placeMarks.ts"
import type { RuntimeProblem } from "./providers.ts"
import type { SensitiveLabel } from "./sensitive.ts"
import { PERMISSION_LEVELS, type PermissionLevel } from "./tools.ts"

export const AGENT_NAME_MAX = 40
export const AGENT_ROLE_MAX = 120
export const FACE_SHAPES = 6
export const FACE_HUES = 10

/** Length in user-visible characters, not UTF-16 units. */
export const charLength = (text: string) => [...text].length

export const AgentName = Schema.String.check(
  Schema.makeFilter((s: string) => {
    const n = charLength(s.trim())
    return n >= 1 && n <= AGENT_NAME_MAX
  }),
)
export const AgentRole = Schema.String.check(
  Schema.makeFilter((s: string) => charLength(s) <= AGENT_ROLE_MAX),
)

export const Face = Schema.Struct({
  shape: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: FACE_SHAPES - 1 })),
  hue: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: FACE_HUES - 1 })),
})
export type Face = typeof Face.Type

export const AgentModel = Schema.Struct({
  accountId: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
})
export type AgentModel = typeof AgentModel.Type

export type AgentState = "idle" | "working" | "waiting" | "offline"

/** The last change of an agent that a linked device made (spec 012, "Create and change agents"). */
export interface AgentChange {
  /** The name of the device, as it was when it made the change. */
  readonly by: string
  readonly at: number
}

export interface Agent {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly role: string
  readonly instructions: string
  readonly face: Face
  /** A data URL of the uploaded picture, when there is one. */
  readonly faceImage: string | null
  readonly model: AgentModel | null
  /**
   * The backup model (spec 006, "Backup model"): the account, model and effort that take the turns
   * while the main model is held because a limit is spent. Null is "None". It syncs with the agent
   * (spec 019). A client of an older step has none.
   */
  readonly backupModel?: AgentModel | null
  /**
   * True when the backup model is ready on the computer that holds the agent: its account is here,
   * connected and, for a program, Ready. A synced backup that names an account that this computer
   * lacks is not ready (spec 006). Absent when the agent has no backup.
   */
  readonly backupReady?: boolean
  /**
   * The hold of the main model while the backup model takes the turns, with its end time. It is a
   * state of the computer that holds the agent and does not sync (spec 006, 019). A linked device
   * shows it as its server tells it (spec 012). Null or absent when no hold lasts.
   */
  readonly hold?: ModelHold | null
  readonly workspace: string
  /** The built-in section. The user section is `sectionId`. */
  readonly section: "agents"
  /** The user section of the Agents list that holds the agent, or null for "No section". */
  readonly sectionId: string | null
  readonly archived: boolean
  readonly state: AgentState
  /**
   * Set when the state is "offline" because the program of the agent needs repair or is not
   * installed (spec 006). The message box says so and offers "Repair" or "Providers". It is
   * a fact of this computer and does not sync (spec 019).
   */
  readonly runtimeProblem?: RuntimeProblem | null
  readonly permission: PermissionLevel
  /** When off, the agent does not read its memory. Items stay. */
  readonly memoryEnabled: boolean
  /** When off, the agent does not read its knowledge and has no knowledge tools. Articles stay. */
  readonly knowledgeEnabled: boolean
  readonly createdAt: number
  /** Set when a linked device made the last change. The user of this computer clears it. */
  readonly changedBy: AgentChange | null
  /**
   * The label of the first credential place that a turn of the chat read, while the next turn
   * holds that sensitive read (spec 007, "Sensitive places"). It is stored with the agent, syncs,
   * and a linked device cannot clear it. A client of an older step has none.
   */
  readonly sensitive?: SensitiveLabel | null
  /**
   * The outside content that the next turns of the chat hold, with the program mark (spec 007,
   * "The mark of a place"). It is stored with the agent and syncs. A client of an older step has none.
   */
  readonly outside?: PlaceOutside | null
}

export const AgentCreate = Schema.Struct({
  serverId: Schema.String,
  name: AgentName,
  role: AgentRole,
  instructions: Schema.String,
  face: Schema.optionalKey(Face),
  model: Schema.optionalKey(Schema.NullOr(AgentModel)),
  /** The backup model (spec 006). Absent or null is "None". */
  backupModel: Schema.optionalKey(Schema.NullOr(AgentModel)),
  sectionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The level of the new agent. Without it the agent starts at the default (spec 007). */
  permission: Schema.optionalKey(Schema.Literals(PERMISSION_LEVELS)),
})
export type AgentCreate = typeof AgentCreate.Type

export const AgentPatch = Schema.Struct({
  name: Schema.optionalKey(AgentName),
  role: Schema.optionalKey(AgentRole),
  instructions: Schema.optionalKey(Schema.String),
  face: Schema.optionalKey(Face),
  model: Schema.optionalKey(Schema.NullOr(AgentModel)),
  backupModel: Schema.optionalKey(Schema.NullOr(AgentModel)),
  permission: Schema.optionalKey(Schema.Literals(PERMISSION_LEVELS)),
  memoryEnabled: Schema.optionalKey(Schema.Boolean),
  knowledgeEnabled: Schema.optionalKey(Schema.Boolean),
  sectionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type AgentPatch = typeof AgentPatch.Type

/**
 * The most text that a linked device may send as the instructions of an agent. The window has no
 * limit, but a request from the link must stay small (spec 012).
 */
export const CLIENT_INSTRUCTIONS_MAX = 200_000

const ClientModel = Schema.Struct({
  accountId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  effort: Schema.NullOr(Schema.String.check(Schema.isMaxLength(40))),
})
const ClientInstructions = Schema.String.check(Schema.isMaxLength(CLIENT_INSTRUCTIONS_MAX))

/**
 * What a linked device may send to make an agent (spec 012). There is no field for a workspace
 * folder, a permission level or a picture: the server decides the folder and the level, and a
 * request that has any other field is refused.
 */
export const ClientAgentCreate = Schema.Struct({
  serverId: Schema.String.check(Schema.isMaxLength(100)),
  name: AgentName,
  role: AgentRole,
  instructions: ClientInstructions,
  face: Schema.optionalKey(Face),
  model: Schema.optionalKey(Schema.NullOr(ClientModel)),
  backupModel: Schema.optionalKey(Schema.NullOr(ClientModel)),
})
export type ClientAgentCreate = typeof ClientAgentCreate.Type

/** What a linked device may change on an agent. The level may only get stricter (007). */
export const ClientAgentPatch = Schema.Struct({
  name: Schema.optionalKey(AgentName),
  role: Schema.optionalKey(AgentRole),
  instructions: Schema.optionalKey(ClientInstructions),
  face: Schema.optionalKey(Face),
  model: Schema.optionalKey(Schema.NullOr(ClientModel)),
  backupModel: Schema.optionalKey(Schema.NullOr(ClientModel)),
  permission: Schema.optionalKey(Schema.Literals(PERMISSION_LEVELS)),
})
export type ClientAgentPatch = typeof ClientAgentPatch.Type

/** Picks a starting face from the name, so the same name gives the same face. */
export const faceFromName = (name: string): Face => {
  let hash = 2166136261
  for (const ch of name) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return { shape: hash % FACE_SHAPES, hue: (hash >>> 8) % FACE_HUES }
}

/** The key that makes names unique on a server: trimmed, NFC, ignoring case. */
export const nameKey = (name: string) => name.trim().normalize("NFC").toLocaleLowerCase()

/**
 * Keeps agents whose name or role line contains every word of the query, ignoring case.
 * An empty query keeps all agents. The order does not change.
 */
export const filterAgents = <A extends { readonly name: string; readonly role: string }>(
  agents: readonly A[],
  query: string,
): readonly A[] => {
  const words = query.normalize("NFC").toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return agents
  return agents.filter((a) => {
    const text = `${a.name} ${a.role}`.normalize("NFC").toLocaleLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/**
 * The name of a copy: "Name copy", then "Name copy 2", "Name copy 3" and so on.
 * The base is shortened when the result would be longer than the name limit.
 */
export const copyName = (name: string, suffix: string, taken: (candidate: string) => boolean) => {
  const fit = (tail: string) => {
    const room = AGENT_NAME_MAX - charLength(tail)
    return [...name.trim()].slice(0, Math.max(1, room)).join("").trimEnd() + tail
  }
  let candidate = fit(suffix)
  for (let n = 2; taken(candidate); n++) candidate = fit(`${suffix} ${n}`)
  return candidate
}

/**
 * First names for the name button. They are English in every interface language (002), so they
 * are data and not interface text.
 */
export const AGENT_NAMES: readonly string[] = [
  "Ada",
  "Alice",
  "Amelia",
  "Andrew",
  "Anna",
  "Arthur",
  "Barbara",
  "Benjamin",
  "Caleb",
  "Carmen",
  "Charlie",
  "Chloe",
  "Claire",
  "Clara",
  "Daniel",
  "David",
  "Diana",
  "Dylan",
  "Edward",
  "Eleanor",
  "Elena",
  "Elliot",
  "Emily",
  "Emma",
  "Ethan",
  "Evelyn",
  "Felix",
  "Fiona",
  "Frank",
  "George",
  "Grace",
  "Hannah",
  "Harper",
  "Henry",
  "Hugo",
  "Ian",
  "Irene",
  "Isaac",
  "Isabel",
  "Ivy",
  "Jack",
  "James",
  "Jasper",
  "Julia",
  "Julian",
  "June",
  "Kate",
  "Kevin",
  "Laura",
  "Leo",
  "Lillian",
  "Logan",
  "Lucas",
  "Lucy",
  "Marcus",
  "Marina",
  "Martin",
  "Mason",
  "Maya",
  "Mia",
  "Michael",
  "Miles",
  "Nathan",
  "Nina",
  "Noah",
  "Nora",
  "Oliver",
  "Olivia",
  "Oscar",
  "Owen",
  "Paul",
  "Penelope",
  "Peter",
  "Quinn",
  "Rachel",
  "Rebecca",
  "Robert",
  "Rose",
  "Ruby",
  "Ryan",
  "Samuel",
  "Sarah",
  "Sebastian",
  "Simon",
  "Sophia",
  "Stella",
  "Tessa",
  "Theo",
  "Thomas",
  "Victor",
  "Violet",
  "Vivian",
  "Walter",
  "Wesley",
  "William",
  "Zachary",
  "Zoe",
]

/**
 * Picks a random name for a new agent from a list of names.
 * It skips names that are taken (see `nameKey`) and the name that is in the field now, so each
 * press gives a new name. When every name is taken, it adds a number: "Nova 2", "Nova 3".
 * `random` returns a number from 0 up to, but not including, 1.
 */
export const suggestName = (
  names: readonly string[],
  taken: (candidate: string) => boolean,
  current: string,
  random: () => number = Math.random,
): string => {
  const pick = <T>(items: readonly T[]) =>
    items[Math.min(items.length - 1, Math.floor(random() * items.length))] as T
  if (names.length === 0) return ""
  const shown = nameKey(current)
  const usable = (candidate: string) => nameKey(candidate) !== shown && !taken(candidate)
  const free = names.filter(usable)
  if (free.length > 0) return pick(free)
  const base = pick(names)
  for (let n = 2; ; n++) {
    const tail = ` ${n}`
    const room = AGENT_NAME_MAX - charLength(tail)
    const candidate = [...base].slice(0, room).join("").trimEnd() + tail
    if (usable(candidate)) return candidate
  }
}
