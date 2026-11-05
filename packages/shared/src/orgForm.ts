import { nameKey } from "./agents.ts"
import type { AgentOrgTool, OrgToolChoice, OrgToolEntry } from "./orgTools.ts"
import { lowerOrgs, type OrgParentRefusal, orgParentRefusal, type TreeOrg } from "./orgTree.ts"

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

/** How many lower organizations become top organizations when `id` is deleted (flow 4). */
export const orgDeleteLowerCount = (orgs: readonly TreeOrg[], id: string): number =>
  lowerOrgs(orgs, id).size

/** The fields of the form that the tree and the service read. */
export interface OrgFormValues {
  readonly name: string
  readonly memberIds: readonly string[]
  readonly leadId: string | null
  /** The parent as the tree reads it now. */
  readonly parentId: string | null
}

export interface OrgFormPatch {
  name?: string
  memberIds?: readonly string[]
  leadId?: string | null
  parentId?: string | null
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
  return patch
}

/**
 * The organizations of the list of a skill or a connection after the form saves (spec 017, 018,
 * 030). A checked organization has the value "On". An organization that the form does not check
 * keeps the value "Off" that it had, and leaves the list otherwise ("Inherit"). An organization
 * that is gone is left out. The old entries keep their place.
 */
export const orgPickerEntries = (
  was: readonly OrgToolEntry[],
  checked: ReadonlySet<string>,
  exists: (id: string) => boolean,
): OrgToolEntry[] => {
  const out: OrgToolEntry[] = []
  for (const entry of was) {
    if (!exists(entry.id)) continue
    if (checked.has(entry.id)) out.push({ id: entry.id, value: "on" })
    else if (entry.value === "off") out.push(entry)
  }
  for (const id of checked)
    if (exists(id) && !out.some((e) => e.id === id)) out.push({ id, value: "on" })
  return out
}

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
