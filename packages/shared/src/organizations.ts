import { Schema } from "effect"
import { charLength, nameKey } from "./agents.ts"

// The organization (spec 030): a group of agents with a lead, a parent organization and access.
// This file holds the shape of an organization, the rules of its name, the shapes that a form and
// a linked computer send, and the plan of the migration that makes organizations from channels.
// The rules of the tree are in `orgTree.ts`, the rules of the tools in `orgTools.ts`.

/** The name holds 1 to 60 characters (spec 030). */
export const ORG_NAME_MAX = 60
/** A profile holds at most this many organizations (spec 030). */
export const ORGS_MAX = 100
/** Most members that a linked computer may name in one request. */
export const CLIENT_ORG_MEMBERS_MAX = 500

/** The hand-off range of an organization (spec 030, "Hand-off range"). "Inherit" is the default. */
export const HAND_OFF_RANGES = ["inherit", "own", "own_lower", "all"] as const
export type HandOffRange = (typeof HAND_OFF_RANGES)[number]
export const DEFAULT_HAND_OFF_RANGE: HandOffRange = "inherit"

export const isHandOffRange = (value: unknown): value is HandOffRange =>
  typeof value === "string" && (HAND_OFF_RANGES as readonly string[]).includes(value)

/** One organization as stored. The rules of the tree decide which parent counts (`orgParent`). */
export interface Org {
  readonly id: string
  readonly serverId: string
  readonly name: string
  /** The agents, in the order of the form. An archived agent stays a member (spec 030). */
  readonly memberIds: readonly string[]
  /** One of the members, or null. An archived lead counts as no lead for every rule. */
  readonly leadId: string | null
  /** The parent organization as stored (spec 030), or null for a top organization. */
  readonly parentId: string | null
  /** Stored now; the hand-off rule reads it in a later step (spec 030, "Hand-off range"). */
  readonly handOffRange: HandOffRange
  /** The daily token limit (10,000 to 100,000,000), or null when it is off (the default). */
  readonly dailyTokenLimit: number | null
  readonly createdAt: number
}

export const OrgCreate = Schema.Struct({
  serverId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ORG_NAME_MAX * 2)),
  memberIds: Schema.Array(Schema.String),
  leadId: Schema.NullOr(Schema.String),
  /** Absent or null: a top organization. */
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Absent or null: off. The service checks the range. */
  dailyTokenLimit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Absent: "Inherit". */
  handOffRange: Schema.optionalKey(Schema.Literals(HAND_OFF_RANGES)),
})
export type OrgCreate = typeof OrgCreate.Type

export const OrgPatch = Schema.Struct({
  name: Schema.optionalKey(OrgCreate.fields.name),
  memberIds: Schema.optionalKey(OrgCreate.fields.memberIds),
  leadId: Schema.optionalKey(OrgCreate.fields.leadId),
  parentId: OrgCreate.fields.parentId,
  dailyTokenLimit: OrgCreate.fields.dailyTokenLimit,
  handOffRange: OrgCreate.fields.handOffRange,
})
export type OrgPatch = typeof OrgPatch.Type

const ClientIds = Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
  Schema.isMaxLength(CLIENT_ORG_MEMBERS_MAX),
)
const ClientId = Schema.String.check(Schema.isMaxLength(100))

/**
 * What a linked computer with the switch "Can create and change agents" may send to make an
 * organization (spec 012, 030). Any other field is refused. The hand-off range and the daily token
 * limit are in: the same switch lets a client set them.
 */
export const ClientOrgCreate = Schema.Struct({
  serverId: ClientId,
  name: OrgCreate.fields.name,
  memberIds: ClientIds,
  leadId: Schema.NullOr(ClientId),
  parentId: Schema.optionalKey(Schema.NullOr(ClientId)),
  dailyTokenLimit: OrgCreate.fields.dailyTokenLimit,
  handOffRange: OrgCreate.fields.handOffRange,
})
export type ClientOrgCreate = typeof ClientOrgCreate.Type

export const ClientOrgPatch = Schema.Struct({
  name: Schema.optionalKey(OrgCreate.fields.name),
  memberIds: Schema.optionalKey(ClientIds),
  leadId: Schema.optionalKey(Schema.NullOr(ClientId)),
  parentId: ClientOrgCreate.fields.parentId,
  dailyTokenLimit: OrgCreate.fields.dailyTokenLimit,
  handOffRange: OrgCreate.fields.handOffRange,
})
export type ClientOrgPatch = typeof ClientOrgPatch.Type

// ---------------------------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------------------------

/** Why a name is refused, or undefined when it is right (spec 030, "Concepts"). */
export const orgNameProblem = (
  name: string,
  taken: (key: string) => boolean,
): "invalid" | "taken" | undefined => {
  const length = charLength(name.trim())
  if (length < 1 || length > ORG_NAME_MAX) return "invalid"
  return taken(nameKey(name)) ? "taken" : undefined
}

/**
 * A name that no other organization holds (spec 030, "Migration"): the name itself, or the name
 * with a number ("Docs 2"), cut so that the whole fits the length limit. The check ignores case.
 * `taken` gets the key of a candidate (`nameKey`).
 */
export const numberedOrgName = (name: string, taken: (key: string) => boolean): string => {
  const base = name.trim()
  if (!taken(nameKey(base))) return base
  for (let n = 2; ; n++) {
    const tail = ` ${n}`
    const room = ORG_NAME_MAX - [...tail].length
    const candidate = [...base].slice(0, room).join("").trimEnd() + tail
    if (!taken(nameKey(candidate))) return candidate
  }
}

// ---------------------------------------------------------------------------------------------
// The lead and the members
// ---------------------------------------------------------------------------------------------

/**
 * The lead that the rules read: the lead when it is one of the members and is not archived, else
 * null (spec 030, "Lead"). A member that was removed is no longer the lead. `archived` tells which
 * agents are archived.
 */
export const effectiveLead = (
  org: Pick<Org, "memberIds" | "leadId">,
  archived: ReadonlySet<string>,
): string | null =>
  org.leadId !== null && org.memberIds.includes(org.leadId) && !archived.has(org.leadId)
    ? org.leadId
    : null

/** The members that the rules read: those that are not archived (spec 030, "Member"). */
export const activeMembers = (
  org: Pick<Org, "memberIds">,
  archived: ReadonlySet<string>,
): string[] => org.memberIds.filter((id) => !archived.has(id))

/** The organizations an agent is a member of, in the order of the list. */
export const orgsOfAgent = <O extends Pick<Org, "id" | "memberIds">>(
  orgs: readonly O[],
  agentId: string,
): O[] => orgs.filter((o) => o.memberIds.includes(agentId))

// ---------------------------------------------------------------------------------------------
// The migration (spec 030, "Migration")
// ---------------------------------------------------------------------------------------------

/** The id of the organization that the migration makes from a channel. Both computers derive the same id. */
export const migratedOrgId = (channelId: string) => `org-${channelId}`

/** What the migration needs of a channel. */
export interface MigrationChannel {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly parentId: string | null
  readonly leadId: string | null
  readonly memberIds: readonly string[]
  readonly dailyTokenLimit: number | null
  /** True when a skill or a connection names the channel in its list (a tool of the channel). */
  readonly hasTools: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** The organization that the migration makes from a channel. */
export interface MigratedOrg extends Omit<Org, "handOffRange"> {
  readonly handOffRange: "inherit"
  /** The channel it came from. The tools of the channel become the value "On" of this organization. */
  readonly channelId: string
  readonly updatedAt: number
}

/**
 * Which channels make an organization (spec 030, "Migration"): a channel with a parent channel, a
 * sub-channel, a tool or a daily token limit. When the hand-off rule is "Along the channels", also
 * every channel with two or more members. A channel with none of these makes none. The result is the
 * same on every computer that holds the same channels: the channels go in the order of their
 * making (then their id), so a taken name gets the same number everywhere. A name is taken when
 * `options.taken` (an organization that exists) or an earlier organization of the plan holds it
 * on the same server. The parent
 * organization is the organization of the parent channel; a parent channel always makes one,
 * because it has a sub-channel.
 */
export const planOrgMigration = (
  channels: readonly MigrationChannel[],
  options: {
    readonly alongChannels: boolean
    /** Whether an organization of this server already holds the name with this key. */
    readonly taken?: (serverId: string, key: string) => boolean
  },
): MigratedOrg[] => {
  const withParent = new Set(channels.flatMap((c) => (c.parentId ? [c.parentId] : [])))
  const known = new Set(channels.map((c) => c.id))
  const makes = (c: MigrationChannel) =>
    c.parentId !== null ||
    withParent.has(c.id) ||
    c.hasTools ||
    c.dailyTokenLimit !== null ||
    (options.alongChannels && c.memberIds.length >= 2)
  const order = [...channels]
    .filter(makes)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const planned = new Set<string>()
  const out: MigratedOrg[] = []
  for (const c of order) {
    const name = numberedOrgName(
      c.name,
      (key) => planned.has(`${c.serverId}|${key}`) || options.taken?.(c.serverId, key) === true,
    )
    planned.add(`${c.serverId}|${nameKey(name)}`)
    out.push({
      id: migratedOrgId(c.id),
      serverId: c.serverId,
      name,
      memberIds: c.memberIds,
      leadId: c.leadId !== null && c.memberIds.includes(c.leadId) ? c.leadId : null,
      parentId: c.parentId !== null && known.has(c.parentId) ? migratedOrgId(c.parentId) : null,
      handOffRange: "inherit",
      dailyTokenLimit: c.dailyTokenLimit,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      channelId: c.id,
    })
  }
  return out
}
