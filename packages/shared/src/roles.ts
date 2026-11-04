import { AGENT_ROLE_MAX, charLength, nameKey } from "./agents.ts"

/**
 * The roles of a server (spec 013, "Roles") and the choices of the role field (spec 002, "Role
 * label"). The window, a linked client and the Roles page all read one list, so they cannot
 * disagree about which roles exist.
 */

/** Two spellings are one role when this key is the same: trimmed, NFC, ignoring case. */
export const roleKey = nameKey

/** One role in the list: the spelling to show, and how many agents have it. */
export interface RoleEntry {
  readonly name: string
  readonly count: number
}

/** The part of an agent that the list reads. */
export interface RoleSource {
  readonly role: string
  /** An archived agent is not counted. Absent counts as not archived. */
  readonly archived?: boolean
}

/**
 * The roles that agents have now: one entry for each spelling that differs only in case, with the
 * number of agents that have it, in alphabetical order. The spelling shown is the first one found
 * in `agents`. An agent that is archived, or that has an empty role line, adds nothing.
 */
export const roleList = (agents: readonly RoleSource[], locale?: string): RoleEntry[] => {
  const found = new Map<string, { name: string; count: number }>()
  for (const agent of agents) {
    if (agent.archived) continue
    const name = agent.role.trim()
    if (name === "") continue
    const key = roleKey(name)
    const entry = found.get(key)
    if (entry) entry.count += 1
    else found.set(key, { name, count: 1 })
  }
  // Numbers sort as numbers ("Agent 2" before "Agent 10"). Spellings that the collator treats as
  // equal still get a fixed order, so the list does not change between two runs.
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true })
  return [...found.entries()]
    .sort(
      ([ka, a], [kb, b]) => collator.compare(a.name, b.name) || (ka < kb ? -1 : ka > kb ? 1 : 0),
    )
    .map(([, entry]) => entry)
}

/** A choice in the list of the role field. */
export type RoleChoice =
  | { readonly kind: "role"; readonly name: string; readonly count: number }
  /** "Add <text>". It is off when the text is longer than a role line can be. */
  | { readonly kind: "add"; readonly name: string; readonly off: boolean }

/** The text of a choice: the spelling of the list for a role, the typed text for "Add". */
export const choiceText = (choice: RoleChoice) => choice.name

/** A choice that the user can pick. */
export const isPickable = (choice: RoleChoice) => choice.kind === "role" || !choice.off

/**
 * The choices for the text in the filter box: the roles that hold the text, ignoring case, in the
 * order of `roles`, then "Add <text>" when the text is not empty and is not the same as a listed
 * role. Spaces at both ends of the text do not count. The "Add" choice stays in the list for a
 * text over 120 characters, but it is off.
 */
export const roleChoices = (roles: readonly RoleEntry[], typed: string): RoleChoice[] => {
  const text = typed.trim()
  const key = roleKey(text)
  const choices: RoleChoice[] = roles
    .filter((role) => key === "" || roleKey(role.name).includes(key))
    .map((role) => ({ kind: "role", name: role.name, count: role.count }))
  if (key !== "" && !roles.some((role) => roleKey(role.name) === key)) {
    choices.push({ kind: "add", name: text, off: charLength(text) > AGENT_ROLE_MAX })
  }
  return choices
}

/**
 * Where the mark starts when the list opens or the text changes: on the listed role that is the
 * same as the text (so "designer" picks "Designer"), else on the first choice that can be picked.
 * It is -1 when nothing can be picked.
 */
export const startMark = (choices: readonly RoleChoice[], typed: string): number => {
  const key = roleKey(typed)
  if (key !== "") {
    const exact = choices.findIndex((c) => c.kind === "role" && roleKey(c.name) === key)
    if (exact >= 0) return exact
  }
  return choices.findIndex(isPickable)
}

/**
 * The mark after one step down (`1`) or up (`-1`). It skips a choice that is off and goes round
 * at the ends. It stays at -1 when nothing can be picked.
 */
export const stepMark = (choices: readonly RoleChoice[], from: number, step: 1 | -1): number => {
  const n = choices.length
  if (!choices.some(isPickable)) return -1
  // With no mark, a step down lands on the first choice and a step up on the last.
  let at = from < 0 ? (step === 1 ? -1 : 0) : from
  for (let i = 0; i < n; i++) {
    at = (((at + step) % n) + n) % n
    if (isPickable(choices[at] as RoleChoice)) return at
  }
  return -1
}
