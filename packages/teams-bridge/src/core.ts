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

/** Who may make the bridge answer. Only the user sets it, in the environment. Chat text cannot change it. */
export interface Admission {
  /** Names of the senders that may call the bridge. Empty: nobody may. */
  allow: string[]
  /** Names of senders that are bots. A bot never makes the bridge answer, also when it is on `allow`. */
  bots: string[]
  /** Text that calls the bridge, for example "@ROBot". Empty: the chat is a direct chat, so every message calls it. */
  call: string
}

export type AdmitResult = { ok: true } | { ok: false; reason: string }

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** A message makes the bridge answer only when the sender is on the list, is not a bot, and calls the bridge. */
export function admit(m: ChatMessage, a: Admission): AdmitResult {
  if (m.author.trim() === "") return { ok: false, reason: "the sender is not known" }
  if (a.bots.some((b) => sameName(b, m.author))) return { ok: false, reason: "the sender is a bot" }
  if (!a.allow.some((n) => sameName(n, m.author))) {
    return { ok: false, reason: "the sender is not on the list" }
  }
  if (a.call !== "" && !m.text.toLowerCase().includes(a.call.toLowerCase())) {
    return { ok: false, reason: "the message does not call the bridge" }
  }
  return { ok: true }
}

/** A failure that never gets better with another try, for example a chat that is not the expected chat. */
export class FinalSendError extends Error {
  override name = "FinalSendError"
  readonly final: boolean = true
}

const isFinal = (err: unknown) => (err as { final?: unknown } | null)?.final === true

export interface OutboxEntry {
  /** Key of the message that this answer is for. */
  for: string
  pieces: string[]
  /** Pieces that went out. A new try starts at the first piece that did not. */
  sent: number
  state: "waiting" | "sent" | "dropped"
  failures: number
  nextAt: number
  lastError: string
  droppedAt?: number
  dropReason?: string
}

export type OutboxEvent =
  | { kind: "sent"; entry: OutboxEntry }
  | { kind: "retry"; entry: OutboxEntry; error: string; waitMs: number }
  | { kind: "problem"; entry: OutboxEntry; error: string }
  | { kind: "dropped"; entry: OutboxEntry; reason: string }

/** First wait after a failed try. The wait doubles after each failure, up to `MAX_WAIT_MS`. */
export const FIRST_WAIT_MS = 5_000
export const MAX_WAIT_MS = 300_000
/** Failed tries in a row before an answer shows as a problem and stops holding back later answers. */
export const PROBLEM_AFTER = 3

export function retryWait(failures: number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** Math.max(0, failures - 1), MAX_WAIT_MS)
}

/**
 * Keeps each answer before it goes out, and sends the answers in the order in which they were made.
 * An answer waits while an earlier one has not gone out, until that one failed `PROBLEM_AFTER` times.
 * A dropped answer keeps its record and is never sent again.
 */
export class Outbox {
  private readonly entries: OutboxEntry[] = []
  constructor(private readonly now: () => number = Date.now) {}

  add(forKey: string, pieces: string[]): OutboxEntry {
    const entry: OutboxEntry = {
      for: forKey,
      pieces,
      sent: 0,
      state: "waiting",
      failures: 0,
      nextAt: this.now(),
      lastError: "",
    }
    this.entries.push(entry)
    return entry
  }

  get all(): readonly OutboxEntry[] {
    return this.entries
  }

  get waiting(): OutboxEntry[] {
    return this.entries.filter((e) => e.state === "waiting")
  }

  /** Sends what is due, in order. */
  async flush(send: (piece: string) => Promise<void>): Promise<OutboxEvent[]> {
    const events: OutboxEvent[] = []
    for (const entry of this.waiting) {
      if (entry.nextAt > this.now()) {
        if (entry.failures < PROBLEM_AFTER) break
        continue
      }
      try {
        while (entry.sent < entry.pieces.length) {
          await send(entry.pieces[entry.sent] as string)
          entry.sent++
        }
        entry.state = "sent"
        events.push({ kind: "sent", entry })
      } catch (err) {
        const error = (err as Error).message
        entry.lastError = error
        if (isFinal(err)) {
          entry.state = "dropped"
          entry.droppedAt = this.now()
          entry.dropReason = error
          events.push({ kind: "dropped", entry, reason: error })
          continue
        }
        entry.failures++
        const waitMs = retryWait(entry.failures)
        entry.nextAt = this.now() + waitMs
        events.push(
          entry.failures >= PROBLEM_AFTER
            ? { kind: "problem", entry, error }
            : { kind: "retry", entry, error, waitMs },
        )
        if (entry.failures < PROBLEM_AFTER) break
      }
    }
    return events
  }
}
