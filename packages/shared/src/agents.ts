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
