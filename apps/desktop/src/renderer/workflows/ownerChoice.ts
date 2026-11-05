import { WORKFLOW_OWNER_KINDS, type WorkflowOwner } from "@robot/shared"

/** The value of an option of the owner select: "" for none, else "<kind>:<id>" (spec 010). */
export const ownerChoice = (owner: WorkflowOwner | null): string =>
  owner === null ? "" : `${owner.kind}:${owner.id}`

/** The owner of an option value. A value that names no kind or no id counts as none. */
export const ownerFromChoice = (choice: string): WorkflowOwner | null => {
  const cut = choice.indexOf(":")
  const kind = choice.slice(0, cut)
  const id = choice.slice(cut + 1)
  const known = WORKFLOW_OWNER_KINDS.find((k) => k === kind)
  return cut > 0 && known && id !== "" ? { kind: known, id } : null
}
