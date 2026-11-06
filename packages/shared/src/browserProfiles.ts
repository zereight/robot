import { Schema } from "effect"
import { charLength, nameKey } from "./chars.ts"

/** The longest name of a browser profile, in characters that the user sees. */
export const BROWSER_PROFILE_NAME_MAX = 40
/** One computer holds at most this many browser profiles. */
export const BROWSER_PROFILES_MAX = 20

/**
 * A browser profile: a named set of saved browser data (cookies, sign-ins) on this computer. Each
 * workflow uses one profile, or its own private data when none is assigned. Workflows that use the same
 * profile are signed in to the same sites.
 */
export interface BrowserProfile {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  /** The workflows that use this profile now. */
  readonly workflowIds: readonly string[]
}

export const BrowserProfileCreate = Schema.Struct({
  // The length rule runs on the trimmed name in the service; this only stops huge input.
  name: Schema.String.check(Schema.isMaxLength(BROWSER_PROFILE_NAME_MAX * 2)),
})
export type BrowserProfileCreate = typeof BrowserProfileCreate.Type

export type BrowserProfileNameProblem = "empty" | "long" | "taken"

/**
 * Checks the name of a browser profile. `others` are the names of the other profiles. A name has
 * 1 to 40 characters after the spaces at both ends are removed, and no two names are the same when
 * case is ignored. Returns null when the name is good.
 */
export const checkBrowserProfileName = (
  name: string,
  others: readonly string[],
): BrowserProfileNameProblem | null => {
  const length = charLength(name.trim())
  if (length < 1) return "empty"
  if (length > BROWSER_PROFILE_NAME_MAX) return "long"
  const key = nameKey(name)
  return others.some((other) => nameKey(other) === key) ? "taken" : null
}

/**
 * True when the computer already holds the most browser profiles that it can. The count is the
 * count of the profiles that the user made.
 */
export const browserProfilesFull = (count: number) => count >= BROWSER_PROFILES_MAX
