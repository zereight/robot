import { type ChannelLimitInfo, validDailyLimit } from "@robot/shared"

// The pure parts of the daily token limit in the window (spec 030): the box of the field in the
// channel settings, and the muted line above the message box of a channel. The components only
// show what these give.

/** The number in the box of the field, or null while it is not a whole number. Commas and spaces are fine. */
export const parseLimit = (text: string): number | null => {
  const digits = text.replace(/[,\s]/g, "")
  return /^\d+$/.test(digits) ? Number(digits) : null
}

/** True when the field holds what it takes: it is off, or its box holds a whole number in the range. */
export const limitFieldValid = (on: boolean, text: string): boolean =>
  !on || validDailyLimit(parseLimit(text))

/**
 * The part of a change of the channel for this field: nothing when the user did not change the
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

/**
 * The muted line above the message box of a channel (spec 030): the line at the limit names the
 * channel whose limit is used, and the line at 80 percent has no name. Null shows no line. A limit
 * that is used wins over the line at 80 percent.
 */
export const limitLineOf = (
  limit: ChannelLimitInfo,
):
  | { readonly key: "channels.limit.over"; readonly channel: string }
  | {
      readonly key: "channels.limit.near"
      readonly channel?: undefined
    }
  | null =>
  limit.stoppedBy
    ? { key: "channels.limit.over", channel: limit.stoppedBy.name }
    : limit.state === "near"
      ? { key: "channels.limit.near" }
      : null
