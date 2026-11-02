/**
 * The order of changes (spec 016, Rules). Each change gets a stamp from a hybrid logical clock:
 * the wall clock of the computer that made it, lifted above every stamp that this computer has
 * seen. So a change made after the user saw another change always has the larger stamp, and for
 * two changes made while the computers were apart the later wall time wins. Equal times break by a
 * counter, then by the device id. Both computers compare stamps the same way, so both pick the
 * same winner, and the two clocks never have to agree for the data to end up equal.
 */

export interface Stamp {
  /** Wall time in ms, lifted above every stamp seen. */
  readonly l: number
  /** Counter for changes in the same ms. */
  readonly c: number
  /** The id of the device that made the change. */
  readonly n: string
}

export const NO_STAMP: Stamp = { l: 0, c: 0, n: "" }

export const compareStamps = (a: Stamp, b: Stamp): number =>
  a.l - b.l || a.c - b.c || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)

export const sameStamp = (a: Stamp, b: Stamp) => a.l === b.l && a.c === b.c && a.n === b.n

export const stampText = (s: Stamp) => `${s.l}.${s.c}.${s.n}`

/** A stamp that travels as `[l, c, n]`. Returns undefined when the value is not one. */
export const readStamp = (value: unknown, limit: number): Stamp | undefined => {
  if (!Array.isArray(value) || value.length !== 3) return undefined
  const [l, c, n] = value as unknown[]
  if (
    typeof l !== "number" ||
    typeof c !== "number" ||
    typeof n !== "string" ||
    !Number.isSafeInteger(l) ||
    !Number.isSafeInteger(c) ||
    l < 0 ||
    c < 0 ||
    c > 2 ** 31 ||
    l > limit ||
    n.length === 0 ||
    n.length > 64
  ) {
    return undefined
  }
  return { l, c, n }
}

/**
 * How old a message of the other computer is when it arrives, on the clock of this computer.
 * `madeAt` is the time that the other computer wrote on it. `skew` is the other clock minus this
 * one, as the computers measured it when they connected (spec 016). So a clock that is wrong
 * does not make an old message look new, or a new one look old.
 */
export const ageOnArrival = (madeAt: number, now: number, skew: number) => now - (madeAt - skew)

export const wireStamp = (s: Stamp): [number, number, string] => [s.l, s.c, s.n]

/** A stamp of the far future is refused: it would lift the clock of the pair for good. */
export const STAMP_FUTURE_MS = 366 * 24 * 60 * 60 * 1000

export class HybridClock {
  readonly #node: string
  readonly #now: () => number
  readonly #save: (state: { l: number; c: number }) => void
  #l: number
  #c: number

  constructor(
    node: string,
    state: { l: number; c: number },
    save: (state: { l: number; c: number }) => void,
    now: () => number = Date.now,
  ) {
    this.#node = node
    this.#l = state.l
    this.#c = state.c
    this.#save = save
    this.#now = now
  }

  /** A stamp for a change made here. */
  tick(): Stamp {
    const wall = this.#now()
    if (wall > this.#l) {
      this.#l = wall
      this.#c = 0
    } else {
      this.#c++
    }
    this.#save({ l: this.#l, c: this.#c })
    return { l: this.#l, c: this.#c, n: this.#node }
  }

  /** A stamp that is made from a time that is not now, for data that has no stamp yet. */
  at(wall: number): Stamp {
    return { l: Math.max(0, Math.floor(wall)), c: 0, n: this.#node }
  }

  /** Lifts the clock to a stamp that came from the other computer. The next stamp is above it. */
  observe(remote: Stamp): void {
    if (remote.l < this.#l || (remote.l === this.#l && remote.c <= this.#c)) return
    this.#l = remote.l
    this.#c = remote.c
    this.#save({ l: this.#l, c: this.#c })
  }

  get state() {
    return { l: this.#l, c: this.#c }
  }
}
