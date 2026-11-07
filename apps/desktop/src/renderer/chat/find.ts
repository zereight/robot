/** One match of a find (spec 003, flow 10): where it starts and ends in the text of one message. */
export interface Hit {
  readonly start: number
  readonly end: number
}

/**
 * The matches of `query` in `text`, ignoring letter case. A match does not overlap the one before.
 * The text is what the window draws for the message, so the count is what the user sees.
 */
export const findHits = (text: string, query: string): Hit[] => {
  const needle = query.toLowerCase()
  if (needle === "") return []
  const hay = text.toLowerCase()
  const hits: Hit[] = []
  for (let from = 0; ; ) {
    const at = hay.indexOf(needle, from)
    if (at < 0) return hits
    hits.push({ start: at, end: at + needle.length })
    from = at + needle.length
  }
}

/**
 * Finds the text node and the offset in it for a position in the joined text of `segments` (the
 * text nodes of a message, in order). `end` places the end of a match: it stays in the node where
 * the match ends.
 */
export const locate = (
  segments: readonly string[],
  position: number,
  end = false,
): { segment: number; offset: number } => {
  let rest = position
  for (let i = 0; i < segments.length; i += 1) {
    const length = (segments[i] as string).length
    if (rest < length || (end && rest === length)) return { segment: i, offset: rest }
    rest -= length
  }
  return { segment: Math.max(0, segments.length - 1), offset: (segments.at(-1) ?? "").length }
}

/** The next position in a ring of `count` matches. `step` is 1 for Next and -1 for Previous. */
export const stepHit = (current: number, count: number, step: 1 | -1): number =>
  count === 0 ? 0 : (current + step + count) % count
