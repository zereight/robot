import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { type DevicesState, groupCode, type PairingState } from "@robot/shared"
import { Effect } from "effect"
import { forgetSweeps, ownTempRoot } from "../stale-temp.ts"
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

describe("the upload folder of linked devices", () => {
  /** A folder of the upload kind, as old as `ageMs`. */
  const folder = (area: string, name: string, ageMs: number) => {
    const path = join(area, name)
    mkdirSync(path)
    const at = new Date(Date.now() - ageMs)
    utimesSync(path, at, at)
    return path
  }
  /** The number of a process that has ended. */
  const deadPid = () => Number(spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout)

  test("a start removes the old upload folders of a gone app, keeps the others, and the quit removes its own", async () => {
    // The test has its own temporary folder, so that no other test file is counted.
    const own = mkdtempSync(join(tmpdir(), "robot-own-tmp-"))
    const saved = process.env.TMPDIR
    process.env.TMPDIR = own
    forgetSweeps()
    let a: Rt | undefined
    try {
      const area = ownTempRoot() as string
      const hour = 60 * 60_000
      const gone = folder(area, `robot-uploads-${deadPid()}-AAAAAA`, hour)
      const young = folder(area, `robot-uploads-${deadPid()}-BBBBBB`, 60_000)
      const running = folder(area, `robot-uploads-${process.pid}-CCCCCC`, hour)
      // The app starts after the folders are there, as after a kill.
      a = testRuntime({ name: "MacBook Upload" })
      await state(a)
      expect(existsSync(gone)).toBe(false)
      expect(existsSync(young)).toBe(true)
      expect(existsSync(running)).toBe(true)
      const mine = readdirSync(area).filter(
        (n) => n.startsWith(`robot-uploads-${process.pid}-`) && n !== basename(running),
      )
      expect(mine).toHaveLength(1)
      // A normal quit removes the folder of this start.
      await a.runtime.dispose()
      expect(existsSync(join(area, mine[0] as string))).toBe(false)
      expect(existsSync(running)).toBe(true)
    } finally {
      await a?.runtime.dispose().catch(() => {})
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
      rmSync(own, { recursive: true, force: true })
    }
  })
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
