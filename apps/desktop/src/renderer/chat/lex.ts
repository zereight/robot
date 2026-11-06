import { lexer, type Token } from "marked"

/**
 * Markdown for a reply that grows. A reply arrives in parts, and the whole text is read again for
 * each part. This module reads only the end of the text again and keeps the tokens of the blocks
 * before it, as the same objects. A view that keys on the object (the Solid `For`) then keeps the
 * elements of those blocks, and a long reply costs the same for each part as a short one.
 */

/** One reading of a text, with what a longer text can reuse. */
export interface Lexed {
  /** The text, with line ends as "\n". */
  readonly text: string
  readonly tokens: readonly Token[]
  /** How many tokens at the start no added text can change. */
  readonly settled: number
  /** The text that those tokens cover. */
  readonly prefix: string
}

const OPTIONS = { gfm: true, breaks: true } as const

/**
 * A line like `[name]: address`. It changes how `[name]` reads in a block above it, so a text with
 * such a line is always read whole.
 */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m

/**
 * How much of the start of `tokens` no added text can change. The last block can grow. The block
 * before it can join the last one: a line that is only `#` or `<div` ends the block above it,
 * and the same line with more text (`#tag`) does not. So the last two blocks stay open. Blank
 * space between blocks does not count as a block.
 *
 * The settled tokens must also cover the start of `source` exactly. If the reader changed the
 * text (it does not, today), nothing is settled and the next reading is whole.
 */
const settle = (source: string, tokens: readonly Token[]) => {
  let seen = 0
  let settled = 0
  for (let at = tokens.length - 1; at >= 0; at--) {
    if (tokens[at]?.type === "space") continue
    seen++
    if (seen === 2) {
      settled = at
      break
    }
  }
  const prefix = tokens
    .slice(0, settled)
    .map((token) => token.raw)
    .join("")
  return source.startsWith(prefix) ? { settled, prefix } : { settled: 0, prefix: "" }
}

/**
 * Reads `text`. `previous` is the reading of an earlier text. When `text` starts with the settled
 * part of that text, only the rest is read, and the settled tokens are the same objects as before.
 * The tokens are always equal to the tokens of a whole reading.
 */
export const lexMarkdown = (text: string, previous?: Lexed): Lexed => {
  // The reader of Markdown does this too. Doing it here keeps the offsets of the tokens exact.
  const source = text.replace(/\r\n?/g, "\n")
  const reuse =
    previous !== undefined &&
    previous.settled > 0 &&
    source.startsWith(previous.prefix) &&
    !DEFINITION.test(source)
  const tokens = reuse
    ? [
        ...previous.tokens.slice(0, previous.settled),
        ...lexer(source.slice(previous.prefix.length), OPTIONS),
      ]
    : [...lexer(source, OPTIONS)]
  return { text: source, tokens, ...settle(source, tokens) }
}
