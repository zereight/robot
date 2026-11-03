import {
  type Admission,
  admit,
  isBotText,
  keyOf,
  markedChunks,
  type Outbox,
  type OutboxEvent,
  type RateLimiter,
  type SeenKeys,
} from "./core.ts"
import type { TeamsPage } from "./teams.ts"

export interface LoopOptions {
  teams: TeamsPage
  seen: SeenKeys
  limiter: RateLimiter
  outbox: Outbox
  admission: Admission
  mode: "watch" | "echo"
  marker: string
  chunkMax: number
  expectTitle: string
  log: (line: string) => void
}

function describe(e: OutboxEvent): string {
  switch (e.kind) {
    case "sent":
      return "> echoed"
    case "retry":
      return `send failed: ${e.error} Next try in ${Math.round(e.waitMs / 1000)} s.`
    case "problem":
      return `problem: the answer for ${e.entry.for} failed ${e.entry.failures} times in a row: ${e.error}`
    case "dropped":
      return `dropped: the answer for ${e.entry.for}: ${e.reason}`
  }
}

/**
 * Reads the chat once. Each new message that is not the bridge's own text and that passes the
 * admission gets an answer in the outbox. Then sends what is due. Returns the number of answers sent.
 */
export async function processNew(o: LoopOptions): Promise<number> {
  for (const m of await o.teams.readMessages()) {
    if (!o.seen.add(keyOf(m))) continue
    if (isBotText(m.text, o.marker)) continue
    o.log(`< ${m.author || "?"}: ${m.text}`)
    if (o.mode !== "echo") continue
    const gate = admit(m, o.admission)
    if (!gate.ok) {
      o.log(`not answered: ${gate.reason}`)
      continue
    }
    if (!o.limiter.tryTake()) {
      o.log("Rate limit: 20 replies in a minute. This message gets no echo.")
      continue
    }
    o.outbox.add(keyOf(m), markedChunks(`echo: ${m.text}`, o.marker, o.chunkMax))
  }
  return flushOutbox(o)
}

/** Sends the answers that are due. Returns the number sent. */
export async function flushOutbox(o: LoopOptions): Promise<number> {
  const events = await o.outbox.flush((piece) => o.teams.send(piece, o.expectTitle))
  for (const e of events) o.log(describe(e))
  return events.filter((e) => e.kind === "sent").length
}
