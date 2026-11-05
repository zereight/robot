import { validDailyLimit } from "@robot/shared"

// The pure parts of the field "Daily token limit" in the form of an organization (spec 030): the box
// and what the form sends. The component only shows what these give.

/** The number in the box of the field, or null while it is not a whole number. Commas and spaces are fine. */
export const parseLimit = (text: string): number | null => {
  const digits = text.replace(/[,\s]/g, "")
  return /^\d+$/.test(digits) ? Number(digits) : null
}

/** True when the field holds what it takes: it is off, or its box holds a whole number in the range. */
export const limitFieldValid = (on: boolean, text: string): boolean =>
  !on || validDailyLimit(parseLimit(text))

/**
 * The part of a change of the organization for this field: nothing when the user did not change the
 * limit, else the new limit (null when the field is off now).
 */
export const limitPatch = (
  was: number | null,
  on: boolean,
  text: string,
): { dailyTokenLimit?: number | null } => {
  const next = on ? parseLimit(text) : null
  return next === was ? {} : { dailyTokenLimit: next }
}

/** The text of the box for a limit that is stored: empty while the limit is off. */
export const limitText = (limit: number | null): string => (limit === null ? "" : String(limit))
