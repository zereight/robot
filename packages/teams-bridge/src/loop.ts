import { isBotText, keyOf, markedChunks, type RateLimiter, type SeenKeys } from "./core.ts"
import type { TeamsPage } from "./teams.ts"

export interface LoopOptions {
  teams: TeamsPage
  seen: SeenKeys
  limiter: RateLimiter
  mode: "watch" | "echo"
  marker: string
  chunkMax: number
  expectTitle: string
  log: (line: string) => void
}

/** Reads the chat once. Handles each message that is new and not written by the bridge. Returns the number of echoes. */
export async function processNew(o: LoopOptions): Promise<number> {
  let echoed = 0
  for (const m of await o.teams.readMessages()) {
    if (!o.seen.add(keyOf(m))) continue
    if (isBotText(m.text, o.marker)) continue
    o.log(`< ${m.author || "?"}: ${m.text}`)
    if (o.mode !== "echo") continue
    if (!o.limiter.tryTake()) {
      o.log("Rate limit: 20 replies in a minute. This message gets no echo.")
      continue
    }
    try {
      for (const piece of markedChunks(`echo: ${m.text}`, o.marker, o.chunkMax)) {
        await o.teams.send(piece, o.expectTitle)
      }
      echoed++
      o.log("> echoed")
    } catch (err) {
      o.log(`send failed: ${(err as Error).message}`)
    }
  }
  return echoed
}
