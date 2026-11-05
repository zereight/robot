import { nameKey } from "./agents.ts"
import type { HandOffRange } from "./organizations.ts"
import type { AgentOrgTool, OrgToolChoice, OrgToolEntry, OrgToolValue } from "./orgTools.ts"
import { type OrgParentRefusal, orgParentRefusal, orgParents, type TreeOrg } from "./orgTree.ts"

// What the form of an organization needs (spec 030, "Flows" 1, 2 and 4). These are plain functions,
// so the dialog, the list in the settings and the org chart (029) read the same rules.

/** An organization as the form reads it: the tree fields and the name. */
export interface NamedOrg extends TreeOrg {
  readonly name: string
}

/** One choice of the field "Parent organization" (spec 030, "Organization tree"). */
export interface OrgParentOption {
  readonly id: string
  readonly name: string
  /** Why the rules of the tree refuse this organization as the parent, or undefined when allowed. */
  readonly refusal: Exclude<OrgParentRefusal, "gone"> | undefined
}

/**
 * The choices of the field "Parent organization" of organization `id`: every other organization by
 * name (the check ignores case, a tie goes by id), each with the reason when the tree does not
 * allow it. "None" is not here: it is always allowed. `id` may be an organization that is not made
 * yet.
 */
export const orgParentOptions = (orgs: readonly NamedOrg[], id: string): OrgParentOption[] =>
  orgs
    .filter((o) => o.id !== id)
    .map((o): OrgParentOption | undefined => {
      const refusal = orgParentRefusal(orgs, id, o.id)
      return refusal === "gone" ? undefined : { id: o.id, name: o.name, refusal }
    })
    .filter((o): o is OrgParentOption => o !== undefined)
    .sort((a, b) => {
      const byName = nameKey(a.name).localeCompare(nameKey(b.name))
      return byName !== 0 ? byName : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

/**
 * The sub-organizations that move up when `id` is deleted, and the parent they get (spec 030,
 * flow 4): the parent of the deleted organization, or null when it had none. Only the direct
 * sub-organizations move. The ones below them keep their parents, so the tree gets no deeper and
 * no agent gets off its line.
 */
export const orgDeleteMoveUp = (
  orgs: readonly TreeOrg[],
  id: string,
): { subIds: string[]; parentId: string | null } => {
  const parents = orgParents(orgs)
  const subIds = orgs.filter((o) => parents.get(o.id) === id).map((o) => o.id)
  return { subIds, parentId: parents.get(id) ?? null }
}

/** <n> of the confirm of a delete: the sub-organizations of `id`, not the ones below them. */
export const orgDeleteSubCount = (orgs: readonly TreeOrg[], id: string): number =>
  orgDeleteMoveUp(orgs, id).subIds.length

/** The fields of the form that the tree and the service read. */
export interface OrgFormValues {
  readonly name: string
  readonly memberIds: readonly string[]
  readonly leadId: string | null
  /** The parent as the tree reads it now. */
  readonly parentId: string | null
  /** The hand-off range (spec 030). A form that holds none leaves the field alone. */
  readonly handOffRange?: HandOffRange
}

export interface OrgFormPatch {
  name?: string
  memberIds?: readonly string[]
  leadId?: string | null
  parentId?: string | null
  handOffRange?: HandOffRange
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * What the form sends when it saves an organization that exists: only the fields that changed. A
 * field that the user did not touch is left out, so a form that stayed open cannot undo a change
 * that came by sync. A lead that is not a member is sent as no lead (spec 030, "Lead").
 */
export const orgPatchOf = (was: OrgFormValues, now: OrgFormValues): OrgFormPatch => {
  const patch: OrgFormPatch = {}
  const name = now.name.trim()
  if (name !== was.name) patch.name = name
  if (!sameList(was.memberIds, now.memberIds)) patch.memberIds = now.memberIds
  const lead = now.leadId !== null && now.memberIds.includes(now.leadId) ? now.leadId : null
  if (lead !== was.leadId) patch.leadId = lead
  if (now.parentId !== was.parentId) patch.parentId = now.parentId
  if (now.handOffRange !== undefined && now.handOffRange !== was.handOffRange)
    patch.handOffRange = now.handOffRange
  return patch
}

/**
 * The organizations of the list of a skill or a connection after the form saves (spec 017, 018,
 * 030): `values` holds the organizations that the user set to "On" or "Off". An organization that
 * is not in `values` has "Inherit" and leaves the list. An organization that is gone is left out.
 * The old entries keep their place.
 */
export const orgPickerEntries = (
  was: readonly OrgToolEntry[],
  values: ReadonlyMap<string, OrgToolValue>,
  exists: (id: string) => boolean,
): OrgToolEntry[] => {
  const out: OrgToolEntry[] = []
  for (const entry of was) {
    const value = values.get(entry.id)
    if (value !== undefined && exists(entry.id)) out.push({ id: entry.id, value })
  }
  for (const [id, value] of values)
    if (exists(id) && !out.some((e) => e.id === id)) out.push({ id, value })
  return out
}

/** The values of the organizations in a list that are still there: the start of a picker. */
export const orgPickerValues = (
  list: readonly OrgToolEntry[],
  exists: (id: string) => boolean,
): Map<string, OrgToolValue> =>
  new Map(list.filter((e) => exists(e.id)).map((e) => [e.id, e.value] as const))

/**
 * The value that a row of "Tools" shows, and whether the user can change it. A tool for "All
 * agents" shows "On" and cannot change. A linked computer reads the rows and changes none of them
 * (spec 012, 030).
 */
export const orgToolSwitch = (
  row: { readonly choice: OrgToolChoice; readonly all: boolean },
  linked: boolean,
): { readonly value: OrgToolChoice; readonly disabled: boolean } => ({
  value: row.all ? "on" : row.choice,
  disabled: linked || row.all,
})

/** The organizations that give a tool to an agent, as the line "From <organization>" names them. */
export const agentOrgNames = (tool: AgentOrgTool): string =>
  tool.organizations.map((o) => o.name).join(", ")
