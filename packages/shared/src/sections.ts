import { Schema } from "effect"
import { charLength, nameKey } from "./agents.ts"
import { PlaceKind } from "./ui.ts"

/** A user section holds places of one kind (see 001, "User sections"). */
export const SECTION_NAME_MAX = 40
/** One built-in section (Channels or Agents) holds at most this many user sections. */
export const SECTIONS_MAX = 20

/** A section that the user made inside Channels or inside Agents. */
export interface UserSection {
  readonly id: string
  readonly serverId: string
  /** The kind of place it holds. */
  readonly kind: PlaceKind
  readonly name: string
  /** Where it sits among the sections of its kind. 0 is first. */
  readonly position: number
}

export const SectionCreate = Schema.Struct({
  serverId: Schema.String,
  kind: PlaceKind,
  // The length rule runs on the trimmed name in the service; this only stops huge input.
  name: Schema.String.check(Schema.isMaxLength(SECTION_NAME_MAX * 2)),
})
export type SectionCreate = typeof SectionCreate.Type

export const MOVE_DIRECTIONS = ["up", "down"] as const
export type MoveDirection = (typeof MOVE_DIRECTIONS)[number]

export type SectionNameProblem = "empty" | "long" | "taken"

/**
 * Checks a section name. `others` are the names of the other sections of the same kind on the
 * same server. A name has 1 to 40 characters after the spaces at both ends are removed, and no
 * two names are the same when case is ignored. Returns null when the name is good.
 */
export const checkSectionName = (
  name: string,
  others: readonly string[],
): SectionNameProblem | null => {
  const length = charLength(name.trim())
  if (length < 1) return "empty"
  if (length > SECTION_NAME_MAX) return "long"
  const key = nameKey(name)
  return others.some((other) => nameKey(other) === key) ? "taken" : null
}

/** True when the kind already has the most sections that it can hold. */
export const sectionsFull = (count: number) => count >= SECTIONS_MAX

/** True when "Move up" or "Move down" does something for this section. */
export const canMoveSection = (ids: readonly string[], id: string, direction: MoveDirection) => {
  const at = ids.indexOf(id)
  if (at < 0) return false
  return direction === "up" ? at > 0 : at < ids.length - 1
}

/** The order of section ids after one step up or down. It stays as it is at the ends. */
export const moveInOrder = (
  ids: readonly string[],
  id: string,
  direction: MoveDirection,
): readonly string[] => {
  if (!canMoveSection(ids, id, direction)) return ids
  const at = ids.indexOf(id)
  const to = direction === "up" ? at - 1 : at + 1
  const next = [...ids]
  next[at] = ids[to] as string
  next[to] = id
  return next
}
