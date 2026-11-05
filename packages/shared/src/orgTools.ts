// The tools that an organization gives (spec 030, "Tools"). The list of agents of a skill (017) or
// a connection (018) holds organizations with the value "On" or "Off". An organization that is not
// in the list has the value "Inherit": it takes the value of its parent organization. An agent may
// use the tool when the value of an organization that it is a member of is "On". These are plain
// functions on the tree and the list.

import { higherOrgs, type TreeOrg } from "./orgTree.ts"

/** The value of an organization that is in the list of a tool. Not in the list: "Inherit". */
export type OrgToolValue = "on" | "off"
export type OrgToolChoice = OrgToolValue | "inherit"

/** One organization in the list of a skill or a connection. */
export interface OrgToolEntry {
  readonly id: string
  readonly value: OrgToolValue
}

/**
 * Reads the stored list: a JSON array of `{ id, value }`. A text that holds no array gives an empty
 * list; an entry that is not right is left out; an organization named twice counts once, the first
 * entry.
 */
export const orgToolEntries = (text: string | null | undefined): OrgToolEntry[] => {
  if (text === null || text === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: OrgToolEntry[] = []
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue
    const { id, value } = entry as { id?: unknown; value?: unknown }
    if (typeof id !== "string" || (value !== "on" && value !== "off")) continue
    if (out.some((e) => e.id === id)) continue
    out.push({ id, value })
  }
  return out
}

/**
 * The value of an organization for a tool, and the organization that gives that value: its own
 * entry, else the entry of the nearest higher organization that has one. `null` when no entry is on
 * the line: a top organization with "Inherit" has no tool (spec 030, "Access").
 */
export const orgToolValue = (
  orgs: readonly TreeOrg[],
  entries: readonly OrgToolEntry[],
  orgId: string,
): { readonly value: OrgToolValue | null; readonly from: string | null } => {
  for (const at of [orgId, ...higherOrgs(orgs, orgId)]) {
    const entry = entries.find((e) => e.id === at)
    if (entry) return { value: entry.value, from: at }
  }
  return { value: null, from: null }
}

/**
 * The organizations that give a tool to an agent that is a member of `memberOf` (spec 030). Each
 * organization of the agent whose value is "On" counts, and the giver is the organization that
 * holds the "On" entry: the line "From <organization>" names it. "Off" in one organization takes
 * away only what that organization would get from above: another organization of the agent can
 * still give the tool. Each giver comes once, in the order of the organizations of the agent. An
 * organization that does not exist gives nothing.
 */
export const orgGivers = (
  orgs: readonly TreeOrg[],
  entries: readonly OrgToolEntry[],
  memberOf: readonly string[],
): string[] => {
  const exists = new Set(orgs.map((o) => o.id))
  const out: string[] = []
  for (const orgId of memberOf) {
    if (!exists.has(orgId)) continue
    const { value, from } = orgToolValue(orgs, entries, orgId)
    if (value === "on" && from !== null && !out.includes(from)) out.push(from)
  }
  return out
}

/**
 * What the muted line "Now: <value> from <organization>" under "Inherit" shows (spec 030, "Access"):
 * the value that the nearest entry on the line above the organization gives, and the organization
 * that holds it. The entry of the organization itself does not count, because the line shows only
 * when the value of the organization is "Inherit". `null` is "Now: none": no organization above
 * gives a value.
 */
export const orgToolNow = (
  orgs: readonly TreeOrg[],
  entries: readonly OrgToolEntry[],
  orgId: string,
): { readonly value: OrgToolValue; readonly from: string } | null => {
  for (const at of higherOrgs(orgs, orgId)) {
    const entry = entries.find((e) => e.id === at)
    if (entry) return { value: entry.value, from: at }
  }
  return null
}

/** The agents and organizations that may use a skill or a connection (spec 017, 018). */
export interface ToolList {
  /** The agents of the list; `null` is "All agents". */
  readonly agentIds: readonly string[] | null
  /** The organizations of the list, each with the value "On" or "Off". */
  readonly entries: readonly OrgToolEntry[]
}

/**
 * Whether an agent may use a skill or a connection (spec 030, "Tools"): "All agents" is on, or the
 * list holds the agent, or an organization that the agent is a member of has the value "On" (its own
 * or the value of a higher organization). "Off" takes away only what the organization would get
 * from above: it never takes a tool that comes from another organization, from the own entry of the
 * agent, or from "All agents". The caller checks that the skill or connection is on.
 */
export const agentMayUse = (
  list: ToolList,
  agentId: string,
  orgs: readonly TreeOrg[],
  memberOf: readonly string[],
): boolean =>
  list.agentIds === null ||
  list.agentIds.includes(agentId) ||
  orgGivers(orgs, list.entries, memberOf).length > 0

/**
 * The list after the value of an organization is set (spec 030): "Inherit" takes the organization
 * out of the list, "On" and "Off" put it in with that value. The other entries stay in place.
 */
export const withOrgSwitch = (
  entries: readonly OrgToolEntry[],
  orgId: string,
  choice: OrgToolChoice,
): OrgToolEntry[] => {
  if (choice === "inherit") return entries.filter((e) => e.id !== orgId)
  const at = entries.findIndex((e) => e.id === orgId)
  if (at < 0) return [...entries, { id: orgId, value: choice }]
  return entries.map((e, i) => (i === at ? { id: orgId, value: choice } : e))
}

// ---------------------------------------------------------------------------------------------
// What the window shows
// ---------------------------------------------------------------------------------------------

/** One row of the part "Tools" of the form of an organization: a skill or a connection of this computer. */
export interface OrgToolRow {
  readonly kind: "skill" | "connection"
  readonly id: string
  readonly name: string
  /** The switch: "on" when the list holds this organization with the value "On" (spec 030). */
  readonly choice: OrgToolChoice
  /**
   * True when the skill or connection is for "All agents": the list has no organizations, and the
   * row shows the tool as on, read only.
   */
  readonly all: boolean
  /**
   * The muted line "Now: <value> from <organization>" under "Inherit": the value that the nearest
   * entry above gives, and the organization that holds it. `null` when the row has its own value,
   * is for "All agents", or no organization above gives a value ("Now: none").
   */
  readonly now: {
    readonly value: OrgToolValue
    readonly organization: { readonly id: string; readonly name: string }
  } | null
}

/** A skill or a connection that an agent has from organizations, for the lines "From <organization>". */
export interface AgentOrgTool {
  readonly kind: "skill" | "connection"
  readonly id: string
  readonly name: string
  /** The organizations that give it, nearest first. */
  readonly organizations: readonly { readonly id: string; readonly name: string }[]
}

/** The organizations in the list of a skill or a connection, with the mark "organization" (spec 030). */
export interface OrgPickerEntry {
  readonly id: string
  readonly name: string
  readonly value: OrgToolValue
}
