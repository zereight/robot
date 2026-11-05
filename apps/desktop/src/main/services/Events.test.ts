import { describe, expect, test } from "bun:test"
import { EVENTS_MAX, EVENTS_PAGE } from "@robot/shared"
import { Events } from "./Events.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

// The record of what arrived at a place (spec 038). It keeps one row for each arrival, finds a
// call that comes again, and trims a profile. It starts nothing.

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  return { run, local }
}

const base = (serverId: string) => ({
  serverId,
  type: "planned run",
  summary: "Planned run of Morning brief",
  why: "The routine runs at its planned time.",
  result: "routed" as const,
})

describe("When an event is recorded", () => {
  describe("with a summary of several lines", () => {
    test("should store it as one line", async () => {
      const { run, local } = await setup()
      const event = await run(
        Events.use((e) =>
          e.add({
            ...base(local.id),
            source: "schedule",
            summary: "  Planned\n\nrun   of Morning brief  ",
          }),
        ),
      )
      expect(event.summary).toBe("Planned run of Morning brief")
    })
  })

  describe("with a detail over the limit", () => {
    test("should cut it and mark the cut", async () => {
      const { run, local } = await setup()
      const event = await run(
        Events.use((e) =>
          e.add({ ...base(local.id), source: "watch", detail: "z".repeat(25_000) }),
        ),
      )
      expect([...event.detail]).toHaveLength(20_000)
      expect(event.detail.endsWith("…")).toBe(true)
    })
  })
})

describe("When the same call arrives twice", () => {
  describe("with the same id inside 7 days", () => {
    test("should find the first one", async () => {
      const { run, local } = await setup()
      const now = Date.now()
      const first = await run(
        Events.use((e) =>
          e.add({ ...base(local.id), source: "outside_program", callId: "call-1" }),
        ),
      )
      const found = await run(Events.use((e) => e.duplicateOf(local.id, "call-1", now)))
      expect(found?.id).toBe(first.id)
    })
  })

  describe("with an id older than 7 days", () => {
    test("should find nothing", async () => {
      const { run, local } = await setup()
      const now = Date.now()
      await run(
        Events.use((e) =>
          e.add({ ...base(local.id), source: "outside_program", callId: "call-old" }),
        ),
      )
      const later = now + 8 * 24 * 60 * 60 * 1000
      expect(await run(Events.use((e) => e.duplicateOf(local.id, "call-old", later)))).toBeNull()
    })
  })

  describe("with no id", () => {
    test("should find nothing", async () => {
      const { run, local } = await setup()
      const found = await run(Events.use((e) => e.duplicateOf(local.id, null, Date.now())))
      expect(found).toBeNull()
    })
  })
})

describe("When a profile holds more events than the limit", () => {
  describe("with one more event", () => {
    test("should keep the newest and drop the oldest", async () => {
      const { run, local } = await setup()
      for (let i = 0; i < EVENTS_MAX + 1; i++)
        await run(
          Events.use((e) => e.add({ ...base(local.id), source: "schedule", summary: `run ${i}` })),
        )
      const rows = await run(Events.use((e) => e.list(local.id)))
      expect(rows).toHaveLength(EVENTS_PAGE)
      expect(rows[0]?.summary).toBe(`run ${EVENTS_MAX}`)
    })
  })
})

describe("When the page reads a filter", () => {
  describe("with the result No rule", () => {
    test("should show only those rows", async () => {
      const { run, local } = await setup()
      await run(
        Events.use((e) =>
          e.add({
            ...base(local.id),
            source: "web_hook",
            result: "no_rule",
            summary: "not a kind",
          }),
        ),
      )
      await run(Events.use((e) => e.add({ ...base(local.id), source: "schedule" })))
      const rows = await run(Events.use((e) => e.list(local.id, { result: "no_rule" })))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.summary).toBe("not a kind")
    })
  })
})

describe("When a test event is more than a day old", () => {
  describe("with the clock moved on", () => {
    test("should leave the page", async () => {
      const { run, local } = await setup()
      await run(Events.use((e) => e.add({ ...base(local.id), source: "test" })))
      const later = Date.now() + 2 * 24 * 60 * 60 * 1000
      await run(Events.use((e) => e.trimTest(later)))
      expect(await run(Events.use((e) => e.list(local.id)))).toHaveLength(0)
    })
  })
})

describe("When a task of a place ends as failed", () => {
  describe("with the event that started it", () => {
    test("should show Failed with the reason", async () => {
      const { run, local } = await setup()
      const event = await run(
        Events.use((e) => e.add({ ...base(local.id), source: "schedule", placeId: "routine-1" })),
      )
      await run(Events.use((e) => e.failLatestOfPlace("routine-1", "The app stopped.")))
      const after = await run(Events.use((e) => e.get(event.id)))
      expect(after?.result).toBe("failed")
      expect(after?.reason).toBe("The app stopped.")
    })
  })

  describe("with a place that has no event", () => {
    test("should change nothing", async () => {
      const { run, local } = await setup()
      await run(Events.use((e) => e.failLatestOfPlace("no-such-place", "reason")))
      expect(await run(Events.use((e) => e.list(local.id)))).toHaveLength(0)
    })
  })
})

describe("When messages of one subject wait", () => {
  describe("with three already waiting", () => {
    test("should count them", async () => {
      const { run, local } = await setup()
      for (let i = 0; i < 3; i++)
        await run(
          Events.use((e) =>
            e.add({
              ...base(local.id),
              source: "outside_program",
              subject: "owner/app#1",
              result: "waits",
              summary: "waits",
            }),
          ),
        )
      expect(await run(Events.use((e) => e.waitingOf(local.id, "owner/app#1")))).toBe(3)
    })
  })

  describe("with another subject", () => {
    test("should not count those", async () => {
      const { run, local } = await setup()
      await run(
        Events.use((e) =>
          e.add({
            ...base(local.id),
            source: "outside_program",
            subject: "owner/app#1",
            result: "waits",
            summary: "waits",
          }),
        ),
      )
      expect(await run(Events.use((e) => e.waitingOf(local.id, "owner/app#2")))).toBe(0)
    })
  })
})
