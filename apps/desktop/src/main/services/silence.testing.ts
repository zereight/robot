import type { Clock } from "./silence.ts"

/** A clock that the test moves by hand. `advance` fires the ticks that fall in the time. */
export const fakeClock = () => {
  let now = 1_000_000
  const ticks = new Set<{ every: number; next: number; fn: () => void }>()
  const clock: Clock = {
    now: () => now,
    every: (ms, fn) => {
      const entry = { every: ms, next: now + ms, fn }
      ticks.add(entry)
      return () => ticks.delete(entry)
    },
  }
  return {
    clock,
    /** Moves time on, one tick at a time, as a running computer does. */
    advance(ms: number) {
      const end = now + ms
      while (now < end) {
        now = Math.min(end, Math.min(...[...ticks].map((t) => t.next), end))
        for (const t of [...ticks]) {
          if (t.next <= now) {
            t.next += t.every
            t.fn()
          }
        }
      }
    },
    /** The computer sleeps: the time moves, no tick runs, and one tick runs when it wakes. */
    sleep(ms: number) {
      now += ms
      for (const t of [...ticks]) {
        t.next = now + t.every
        t.fn()
      }
    },
  }
}
