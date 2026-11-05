import { describe, expect, it } from "bun:test"
import { withBusyRetries } from "./busyRetry.ts"
import { ProviderFailure } from "./client.ts"

const none = () => {}

const read = async (
  open: () => AsyncIterable<{ readonly type: string }>,
  signal: AbortSignal,
  waitsMs: readonly number[],
) => {
  const lines: number[] = []
  const tries: number[] = []
  const events: string[] = []
  let error: unknown
  try {
    for await (const event of withBusyRetries(open, {
      signal,
      waitsMs,
      onWait: (n) => lines.push(n),
      onTry: () => tries.push(tries.length + 1),
    }))
      events.push(event.type)
  } catch (caught) {
    error = caught
  }
  return { lines, tries, events, error }
}

describe("When a provider is busy", () => {
  describe("with no output yet", () => {
    it("should try the request again and then give the text", async () => {
      let opens = 0
      const result = await read(
        () => {
          opens += 1
          if (opens < 3) throw new ProviderFailure("provider_busy", "overloaded")
          return (async function* () {
            yield { type: "text" }
          })()
        },
        new AbortController().signal,
        [0, 0, 0],
      )
      expect(result).toEqual({ lines: [1, 2], tries: [1, 2], events: ["text"], error: undefined })
    })

    it("should fail with the provider reason after the third try", async () => {
      const result = await read(
        () => {
          throw new ProviderFailure("provider_busy", "overloaded")
        },
        new AbortController().signal,
        [0, 0, 0],
      )
      expect(result.lines).toEqual([1, 2, 3])
      expect(result.error).toBeInstanceOf(ProviderFailure)
      if (result.error instanceof ProviderFailure) expect(result.error.detail).toBe("overloaded")
    })

    it("should end the wait when Stop aborts the signal", async () => {
      const controller = new AbortController()
      let opens = 0
      const lines: number[] = []
      let error: unknown
      try {
        for await (const _event of withBusyRetries(
          () => {
            opens += 1
            throw new ProviderFailure("provider_busy", "overloaded")
          },
          {
            signal: controller.signal,
            waitsMs: [60_000],
            onWait: () => {
              lines.push(1)
              setTimeout(() => controller.abort(), 20)
            },
            onTry: none,
          },
        )) {
          // The request makes no output.
        }
      } catch (caught) {
        error = caught
      }
      expect(opens).toBe(1)
      expect(lines).toEqual([1])
      expect(error).toBeInstanceOf(Error)
    })
  })

  describe("with output already sent", () => {
    it("should not try the request again", async () => {
      let opens = 0
      const result = await read(
        () => {
          opens += 1
          return (async function* () {
            yield { type: "text" }
            throw new ProviderFailure("provider_busy", "overloaded")
          })()
        },
        new AbortController().signal,
        [0, 0, 0],
      )
      expect(opens).toBe(1)
      expect(result.events).toEqual(["text"])
      expect(result.lines).toEqual([])
    })
  })

  describe("with a usage limit", () => {
    it("should not try the request again", async () => {
      let opens = 0
      const result = await read(
        () => {
          opens += 1
          throw new ProviderFailure("provider_limit", "usage limit", undefined, "plan")
        },
        new AbortController().signal,
        [0, 0, 0],
      )
      expect(opens).toBe(1)
      expect(result.lines).toEqual([])
    })
  })
})
