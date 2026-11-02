/**
 * Only a last message less than this far ahead of the clock moves a new message on. A message of
 * another computer whose clock is ahead (spec 019) is further ahead, and a new message keeps the
 * time of this clock.
 */
const SAME_TIME_MS = 1000

/**
 * The time of a new message of a chat or a channel. A question and its reply are often made in
 * the same millisecond. A computer that syncs gets the two in any order and orders by time, so
 * they must not have the same time: a new message is at least 1 ms after the last one.
 */
export const nextMessageTime = (last: number | null | undefined, now = Date.now()): number =>
  last != null && last >= now && last - now < SAME_TIME_MS ? last + 1 : now
