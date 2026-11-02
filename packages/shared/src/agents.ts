import { Schema } from "effect"
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
  readonly workspace: string
  readonly section: "agents"
  readonly archived: boolean
  readonly state: AgentState
  readonly permission: PermissionLevel
  /** When off, the agent does not read its memory. Items stay. */
  readonly memoryEnabled: boolean
  readonly createdAt: number
  /** Set when a linked device made the last change. The user of this computer clears it. */
  readonly changedBy: AgentChange | null
}

export const AgentCreate = Schema.Struct({
  serverId: Schema.String,
  name: AgentName,
  role: AgentRole,
  instructions: Schema.String,
  face: Schema.optionalKey(Face),
  model: Schema.optionalKey(Schema.NullOr(AgentModel)),
})
export type AgentCreate = typeof AgentCreate.Type

export const AgentPatch = Schema.Struct({
  name: Schema.optionalKey(AgentName),
  role: Schema.optionalKey(AgentRole),
  instructions: Schema.optionalKey(Schema.String),
  face: Schema.optionalKey(Face),
  model: Schema.optionalKey(Schema.NullOr(AgentModel)),
  permission: Schema.optionalKey(Schema.Literals(PERMISSION_LEVELS)),
  memoryEnabled: Schema.optionalKey(Schema.Boolean),
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
})
export type ClientAgentCreate = typeof ClientAgentCreate.Type

/** What a linked device may change on an agent. The level may only get stricter (007). */
export const ClientAgentPatch = Schema.Struct({
  name: Schema.optionalKey(AgentName),
  role: Schema.optionalKey(AgentRole),
  instructions: Schema.optionalKey(ClientInstructions),
  face: Schema.optionalKey(Face),
  model: Schema.optionalKey(Schema.NullOr(ClientModel)),
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

export const AGENT_TEMPLATES = ["general", "reviewer", "researcher"] as const
export type AgentTemplate = (typeof AGENT_TEMPLATES)[number]
