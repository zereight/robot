import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type DevicesState, groupCode, type PairingState } from "@robot/shared"
import { Effect } from "effect"
import { Devices } from "./Devices.ts"
import { testRuntime } from "./testing.ts"

type Rt = ReturnType<typeof testRuntime>

const start = (side: Rt): Promise<PairingState> =>
  side.runtime.runPromise(Devices.use((d) => d.pairStart()))
const state = (side: Rt): Promise<DevicesState> =>
  side.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.state())))
const _joins = (side: Rt) =>
  side.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.joins())))
const _decide = (side: Rt, allow: boolean) =>
  side.runtime.runPromise(
    Effect.gen(function* () {
      const d = yield* Devices
      for (let i = 0; i < 150; i++) {
        const first = d.joins()[0]
        if (first) return yield* d.decide(first.id, allow)
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
      }
      throw new Error("no join request")
    }),
  )
const _waitFor = async <T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50))
    last = await read()
  }
  return last
}

const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
  process.env.ROBOT_LINK_RETRY_MAX_MS = "300"
  process.env.ROBOT_LINK_NEARBY_WAIT_MS = "80"
})
afterAll(async () => {
  for (const s of sides) await s.runtime.dispose()
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
  delete process.env.ROBOT_LINK_NEARBY_WAIT_MS
})

describe("device link between two computers", () => {
  test("the switch is off at first start and no port is open", async () => {
    const a = side("MacBook 2")
    const s = await state(a)
    expect(s.accept).toBe(false)
    expect(s.port).toBeNull()
    expect(s.self.name).toBe("MacBook 2")
    expect(s.self.kind).toBe("computer")
    expect(s.self.protocol).toBe(1)
  })

  test("a pairing code is six digits, shows every address, and turns the switch on", async () => {
    const a = side("MacBook 2")
    const pairing = await start(a)
    expect(pairing.code).toMatch(/^\d{6}$/)
    expect(groupCode(pairing.code)).toMatch(/^\d{3} \d{3}$/)
    expect(pairing.addresses[0]?.address).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(pairing.link).toContain("robot://pair?")
    expect(pairing.link).toContain(pairing.code)
    expect((await state(a)).accept).toBe(true)
    expect((await state(a)).port).not.toBeNull()
  })
})
