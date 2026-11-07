// A diff of two texts by words (spec 002, "Self-improvement", "Card": "the removed and the added
// parts marked"). It is pure, so a test can read it and the window can draw it.

export type DiffKind = "same" | "removed" | "added"

export interface DiffSegment {
  readonly kind: DiffKind
  readonly text: string
}

export interface TextDiff {
  readonly segments: readonly DiffSegment[]
  /** The characters of the removed parts and of the added parts. */
  readonly removed: number
  readonly added: number
}

/** The words and the runs of white space of a text. The tokens joined are the text. */
const tokens = (text: string): string[] => text.match(/\s+|\S+/g) ?? []

type Op = "=" | "-" | "+"

/**
 * The edit script of two token lists (Myers, O(ND)). Returns null when the script needs more than
 * `maxD` edits: the caller wants no big diff.
 */
const script = (a: readonly string[], b: readonly string[], maxD: number): Op[] | null => {
  const n = a.length
  const m = b.length
  if (n === 0) return Array.from({ length: m }, () => "+" as const)
  if (m === 0) return Array.from({ length: n }, () => "-" as const)
  const limit = Math.min(n + m, maxD)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  // The window of `v` at the start of each round: the entries k in [-d - 1, d + 1].
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number)))
        x = v[offset + k + 1] as number
      else x = (v[offset + k - 1] as number) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        const ops: Op[] = []
        let cx = n
        let cy = m
        for (let r = d; r >= 0; r--) {
          const w = trace[r] as Int32Array
          const at = (kk: number) => w[kk + r + 1] as number
          const ck = cx - cy
          const prevK = ck === -r || (ck !== r && at(ck - 1) < at(ck + 1)) ? ck + 1 : ck - 1
          const px = r === 0 ? 0 : at(prevK)
          const py = r === 0 ? 0 : px - prevK
          while (cx > px && cy > py) {
            ops.push("=")
            cx--
            cy--
          }
          if (r > 0) {
            ops.push(cx === px ? "+" : "-")
            cx = px
            cy = py
          }
        }
        return ops.reverse()
      }
    }
  }
  return null
}

/**
 * The difference of two texts. `maxChanged` is the most characters that the removed and the added
 * parts may hold together; a difference that is bigger gives null.
 */
export const textDiff = (
  before: string,
  after: string,
  maxChanged = Number.POSITIVE_INFINITY,
): TextDiff | null => {
  const a = tokens(before)
  const b = tokens(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  // Every edit changes at least one character, so more edits than `maxChanged` is over the limit.
  const budget = Number.isFinite(maxChanged) ? Math.floor(maxChanged) : midA.length + midB.length
  const ops = script(midA, midB, budget)
  if (ops === null) return null
  const segments: DiffSegment[] = []
  const push = (kind: DiffKind, text: string) => {
    const last = segments.at(-1)
    if (last?.kind === kind) segments[segments.length - 1] = { kind, text: last.text + text }
    else segments.push({ kind, text })
  }
  push("same", a.slice(0, start).join(""))
  let i = 0
  let j = 0
  let removed = 0
  let added = 0
  for (const op of ops) {
    if (op === "=") {
      push("same", midA[i] as string)
      i++
      j++
    } else if (op === "-") {
      const t = midA[i] as string
      push("removed", t)
      removed += [...t].length
      i++
    } else {
      const t = midB[j] as string
      push("added", t)
      added += [...t].length
      j++
    }
  }
  push("same", a.slice(endA).join(""))
  if (removed + added > maxChanged) return null
  return { segments: segments.filter((s) => s.text !== ""), removed, added }
}
