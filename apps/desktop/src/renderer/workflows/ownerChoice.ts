import type { WorkflowOwner } from "@robot/shared"

/** The value of an option of the owner select: "" for none, else "agent:<id>" (spec 010). */
export const ownerChoice = (owner: WorkflowOwner | null): string =>
  owner === null ? "" : `${owner.kind}:${owner.id}`

/**
 * The owner of an option value. The owner is none or one agent (spec 010). A value that names no
 * agent counts as none.
 */
export const ownerFromChoice = (choice: string): WorkflowOwner | null => {
  const cut = choice.indexOf(":")
  const kind = choice.slice(0, cut)
  const id = choice.slice(cut + 1)
  return kind === "agent" && id !== "" ? { kind: "agent", id } : null
}
