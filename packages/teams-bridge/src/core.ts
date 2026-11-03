// Pure logic. No browser, no Teams. Tested offline.

/** Text of a message that the bridge itself wrote starts with the marker. */
export function isBotText(text: string, marker: string): boolean {
  return text.trimStart().startsWith(marker)
}

export function withMarker(text: string, marker: string): string {
  return `${marker} ${text}`
}

/**
 * Split text in pieces of at most `max` characters.
 * Prefers a line break, then a space, then cuts hard.
 */
export function chunkText(text: string, max: number): string[] {
  if (max < 1) throw new Error("max must be at least 1")
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = window.lastIndexOf("\n")
    if (cut < max / 2) cut = window.lastIndexOf(" ")
    if (cut < max / 2) cut = max
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0 || out.length === 0) out.push(rest)
  return out
}

/** Pieces that each carry the marker, so the reader skips every one of them. */
export function markedChunks(text: string, marker: string, max: number): string[] {
  const room = max - marker.length - 1
  if (room < 1) throw new Error("chunk size is smaller than the marker")
  return chunkText(text, room).map((piece) => withMarker(piece, marker))
}

/** Remembers the last `cap` keys. `add` returns true when the key is new. */
export class SeenKeys {
  private readonly keys = new Set<string>()
  constructor(private readonly cap = 2000) {}

  add(key: string): boolean {
    if (this.keys.has(key)) return false
    this.keys.add(key)
    if (this.keys.size > this.cap) {
      const oldest = this.keys.values().next().value
      if (oldest !== undefined) this.keys.delete(oldest)
    }
    return true
  }

  get size(): number {
    return this.keys.size
  }
}

/** At most `max` takes in any window of `windowMs`. */
export class RateLimiter {
  private readonly stamps: number[] = []
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(): boolean {
    const t = this.now()
    while (this.stamps.length > 0 && t - (this.stamps[0] as number) >= this.windowMs) {
      this.stamps.shift()
    }
    if (this.stamps.length >= this.max) return false
    this.stamps.push(t)
    return true
  }
}

export interface ChatMessage {
  /** Id from the page when it has one, else empty. */
  id: string
  author: string
  text: string
  /** ISO time from the page when it has one, else empty. */
  time: string
}

/** Key for "have I seen this message". Falls back to time + text when the page gives no id. */
export function keyOf(m: ChatMessage): string {
  return m.id !== "" ? `id:${m.id}` : `t:${m.time}|${m.text}`
}
