import { describe, expect, test } from "bun:test"
import {
  type AccountFacts,
  accountProblem,
  badgeText,
  type CardFacts,
  dayBounds,
  dayKey,
  doneRows,
  failedInARow,
  needsRows,
  nextRows,
  type PartFacts,
  ROUTINE_PAUSE_FAILS,
  type RoutineFacts,
  type RunFacts,
  routineProblem,
  TODAY_AHEAD_MS,
  TODAY_GROUPS,
  type TodayRow,
  type TodaySnapshot,
  todayFilterEmpty,
  todayForOrganization,
  todayLine,
  todaySnapshot,
  visibleGroups,
  wrongRows,
} from "./today.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const UTC = "UTC"

// A fake clock: noon on 15 June 2026, in UTC. Every test reads the day from it.
const NOON = Date.UTC(2026, 5, 15, 12, 0, 0)
const day = dayBounds(NOON, UTC)

const card = (n: number, extra: Partial<CardFacts> = {}): CardFacts => ({
  agentId: "a1",
  callId: `c${n}`,
  kind: "approval",
  text: `Run step ${n}`,
  channel: null,
  target: { kind: "agent", id: "a1", messageId: `m${n}` },
  askedAt: NOON - n * HOUR,
  computer: null,
  ...extra,
})

const run = (state: string, createdAt: number, extra: Partial<RunFacts> = {}): RunFacts => ({
  state,
  createdAt,
  finishedAt: createdAt + 1000,
  reason: state === "done" ? null : { code: "provider_not_connected", detail: "" },
  ...extra,
})

const routine = (extra: Partial<RoutineFacts> = {}): RoutineFacts => ({
  id: "r1",
  name: "Morning check",
  agentId: "a1",
  enabled: true,
  resetAt: 0,
  runs: [],
  nextRun: null,
  ...extra,
})

describe("the day", () => {
  test("runs from midnight to midnight in the zone of the computer", () => {
    expect(new Date(day.start).toISOString()).toBe("2026-06-15T00:00:00.000Z")
    expect(new Date(day.end).toISOString()).toBe("2026-06-16T00:00:00.000Z")
    const seoul = dayBounds(NOON, "Asia/Seoul")
    // 12:00 UTC is 21:00 in Seoul, so the day started at 15:00 UTC on the 14th.
    expect(new Date(seoul.start).toISOString()).toBe("2026-06-14T15:00:00.000Z")
    expect(seoul.end - seoul.start).toBe(DAY)
  })

  test("the moment before midnight is in the old day and midnight starts the new one", () => {
    expect(dayBounds(day.end - 1, UTC).start).toBe(day.start)
    expect(dayBounds(day.end, UTC).start).toBe(day.end)
  })

  test("a day with a clock change is shorter or longer than 24 hours", () => {
    const spring = dayBounds(Date.UTC(2026, 2, 8, 18, 0, 0), "America/New_York")
    expect(spring.end - spring.start).toBe(23 * HOUR)
    const autumn = dayBounds(Date.UTC(2026, 10, 1, 18, 0, 0), "America/New_York")
    expect(autumn.end - autumn.start).toBe(25 * HOUR)
  })

  test("a change of the time zone changes the key of the day", () => {
    expect(dayKey(NOON, UTC)).not.toBe(dayKey(NOON, "Asia/Seoul"))
    expect(dayKey(NOON, UTC)).toBe(dayKey(NOON + HOUR, UTC))
    expect(dayKey(NOON, UTC)).not.toBe(dayKey(NOON + DAY, UTC))
  })

  test("an unknown zone falls back to UTC", () => {
    expect(dayBounds(NOON, "Not/AZone")).toEqual(day)
  })
})

describe("text", () => {
  test("a line has at most 90 characters and a longer one ends with an ellipsis", () => {
    const long = "x".repeat(200)
    const line = todayLine(long)
    expect([...line]).toHaveLength(90)
    expect(line.endsWith("…")).toBe(true)
    expect(todayLine("y".repeat(90))).toBe("y".repeat(90))
    expect(todayLine("  a \n b\t c  ")).toBe("a b c")
  })

  test("a line counts characters, not code units", () => {
    const line = todayLine("한".repeat(120))
    expect([...line]).toHaveLength(90)
  })

  test("the badge hides at 0, counts up to 99, and reads 99+ above", () => {
    expect(badgeText(0)).toBeNull()
    expect(badgeText(1)).toBe("1")
    expect(badgeText(99)).toBe("99")
    expect(badgeText(100)).toBe("99+")
    expect(badgeText(1234)).toBe("99+")
  })
})

describe("Needs you", () => {
  test("the oldest row is first", () => {
    const rows = needsRows([card(1), card(3), card(2)], [])
    expect(rows.map((r) => r.text)).toEqual(["Run step 3", "Run step 2", "Run step 1"])
  })

  test("a request of the other computer names it and a part in review has its own kind", () => {
    const part: PartFacts = {
      taskId: "t9",
      agentId: "a2",
      label: "Check the facts",
      state: "review",
      channel: "Launch",
      target: { kind: "channel", id: "ch1" },
      at: NOON - 5 * HOUR,
      reason: null,
    }
    const rows = needsRows([card(1, { computer: "Studio Mac" })], [part])
    expect(rows.map((r) => r.kind)).toEqual(["part_review", "approval"])
    expect(rows[1]?.computer).toBe("Studio Mac")
    expect(rows[0]?.where).toEqual({ kind: "channel", name: "Launch" })
  })

  test("a question is a question and an approval is an approval", () => {
    const rows = needsRows([card(1, { kind: "question" }), card(2)], [])
    expect(rows.map((r) => r.kind).sort()).toEqual(["approval", "question"])
  })
})

describe("failed runs in a row (spec 009)", () => {
  const t = (n: number) => NOON + n * 1000
  test("a run that ends as done sets the count to 0", () => {
    expect(failedInARow([run("failed", t(1)), run("done", t(2)), run("failed", t(3))], 0)).toBe(1)
  })
  test("two fail, one is done, one fails: not paused; two fail and one fails: paused", () => {
    expect(
      failedInARow(
        [run("failed", t(1)), run("failed", t(2)), run("done", t(3)), run("failed", t(4))],
        0,
      ),
    ).toBeLessThan(ROUTINE_PAUSE_FAILS)
    expect(failedInARow([run("failed", t(1)), run("failed", t(2)), run("failed", t(3))], 0)).toBe(3)
  })
  test("a blocked run counts as a failed run and a cancelled run changes nothing", () => {
    expect(
      failedInARow([run("failed", t(1)), run("cancelled", t(2)), run("blocked", t(3))], 0),
    ).toBe(2)
  })
  test("runs from before the last resume or edit do not count", () => {
    const runs = [run("failed", t(1)), run("failed", t(2)), run("failed", t(3))]
    expect(failedInARow(runs, t(2))).toBe(2)
    expect(failedInARow(runs, t(10))).toBe(0)
  })
})

describe("routines in Went wrong", () => {
  const fails = (n: number, from = NOON - 3 * HOUR) =>
    Array.from({ length: n }, (_, i) => run("failed", from + i * 60_000))

  test("a failed run today gives one row that names the last failure", () => {
    const row = routineProblem(routine({ runs: fails(1) }), day)
    expect(row?.kind).toBe("routine_failed")
    expect(row?.reason?.code).toBe("provider_not_connected")
    expect(row?.open).toEqual({ kind: "routine", id: "r1" })
  })

  test("a failure from an earlier day gives no row while the routine is on", () => {
    expect(routineProblem(routine({ runs: fails(1, NOON - 2 * DAY) }), day)).toBeNull()
  })

  test("3 failed runs in a row and a paused routine give one row marked Paused", () => {
    const row = routineProblem(routine({ enabled: false, runs: fails(3) }), day)
    expect(row?.kind).toBe("routine_paused")
    expect(row?.count).toBe(3)
  })

  test("a routine that is paused by the user without failures gives no row", () => {
    expect(
      routineProblem(routine({ enabled: false, runs: [run("done", NOON - HOUR)] }), day),
    ).toBeNull()
    expect(routineProblem(routine({ enabled: false, runs: fails(2) }), day)?.kind).toBe(
      "routine_failed",
    )
  })

  test("a paused routine keeps its row from an earlier day", () => {
    const old = fails(3, NOON - 3 * DAY)
    const row = routineProblem(routine({ enabled: false, runs: old }), day)
    expect(row?.kind).toBe("routine_paused")
    // The clock passes midnight twice: the day rows are gone, the paused routine stays.
    const later = dayBounds(NOON + 2 * DAY, UTC)
    expect(routineProblem(routine({ enabled: false, runs: old }), later)?.kind).toBe(
      "routine_paused",
    )
    expect(routineProblem(routine({ runs: fails(1) }), later)).toBeNull()
  })

  test("a pause is not an edit: the paused routine keeps the count of failed runs", () => {
    // The routine was paused after its runs, so its time of change is later than the failures.
    const runs = fails(3)
    const row = routineProblem(routine({ enabled: false, runs, resetAt: NOON }), day)
    expect(row?.kind).toBe("routine_paused")
  })

  test("resume sets the count to 0 and the row leaves", () => {
    const runs = fails(3)
    expect(routineProblem(routine({ enabled: false, runs }), day)?.kind).toBe("routine_paused")
    expect(
      routineProblem(routine({ enabled: true, runs, resetAt: NOON - 1 * HOUR }), day),
    ).toBeNull()
  })
})

describe("model accounts in Went wrong (spec 006, 021)", () => {
  const account = (
    extra: Partial<AccountFacts["last"] & object> | null,
    connected = true,
  ): AccountFacts => ({
    id: "acc1",
    name: "Work account",
    connected,
    last:
      extra === null
        ? null
        : {
            failed: true,
            code: "provider_limit",
            resetsAt: null,
            at: NOON - HOUR,
            agentId: "a1",
            ...extra,
          },
  })

  test("a plan limit gives a row with the reset time", () => {
    const row = accountProblem(account({ resetsAt: NOON + 2 * HOUR }), NOON)
    expect(row?.kind).toBe("account_limit")
    expect(row?.resetsAt).toBe(NOON + 2 * HOUR)
    expect(row?.open).toEqual({ kind: "account", id: "acc1" })
  })

  test("a limit also ends when the reset time has passed", () => {
    expect(accountProblem(account({ resetsAt: NOON + HOUR }), NOON + 2 * HOUR)).toBeNull()
  })

  test("a limit with no reset time stays until a turn succeeds", () => {
    expect(accountProblem(account({}), NOON + 10 * DAY)?.kind).toBe("account_limit")
  })

  test("a sign-in that is not valid gives a row, from any of the codes", () => {
    for (const code of ["provider_auth", "runtime_signed_out"])
      expect(accountProblem(account({ code }), NOON)?.kind).toBe("account_signin")
  })

  test("a turn that succeeds, another failure, or a disconnect give no row", () => {
    expect(accountProblem(account({ failed: false, code: "" }), NOON)).toBeNull()
    expect(accountProblem(account({ code: "provider_error" }), NOON)).toBeNull()
    expect(accountProblem(account(null), NOON)).toBeNull()
    expect(accountProblem(account({}, false), NOON)).toBeNull()
  })
})

describe("Went wrong", () => {
  const task = (id: string, at: number, state: "failed" | "blocked" = "failed") => ({
    id,
    agentId: "a1",
    label: `Task ${id}`,
    state,
    source: "chat" as const,
    where: { kind: "direct" as const, name: "" },
    at,
    reason: null,
  })

  test("the newest row is first and only tasks of this day show", () => {
    const rows = wrongRows(
      [
        task("old", day.start - HOUR),
        task("a", NOON - 3 * HOUR),
        task("b", NOON - HOUR, "blocked"),
      ],
      [routine({ runs: [run("failed", NOON - 2 * HOUR)] })],
      [],
      day,
      NOON,
    )
    expect(rows.map((r) => r.id)).toEqual(["task:b", "routine:r1", "task:a"])
    expect(rows[0]?.kind).toBe("task_blocked")
  })

  test("after midnight the day rows are empty and a paused routine keeps its row", () => {
    const paused = routine({
      enabled: false,
      runs: [
        run("failed", NOON - 3 * HOUR),
        run("failed", NOON - 2 * HOUR),
        run("failed", NOON - HOUR),
      ],
    })
    const tomorrow = dayBounds(NOON + DAY, UTC)
    const rows = wrongRows([task("a", NOON - HOUR)], [paused], [], tomorrow, NOON + DAY)
    expect(rows.map((r) => r.id)).toEqual(["routine:r1"])
  })
})

describe("Done today", () => {
  test("one row for each routine and workflow with the count and the last time, newest first", () => {
    const rows = doneRows([
      {
        kind: "routine",
        id: "r1",
        name: "Morning check",
        agentId: "a1",
        count: 2,
        last: NOON - HOUR,
      },
      { kind: "workflow", id: "w1", name: "Weekly report", agentId: null, count: 1, last: NOON },
      { kind: "routine", id: "r2", name: "None", agentId: "a1", count: 0, last: NOON },
    ])
    expect(rows.map((r) => [r.id, r.count])).toEqual([
      ["done:workflow:w1", 1],
      ["done:routine:r1", 2],
    ])
    expect(rows[1]?.open).toEqual({ kind: "routine", id: "r1" })
  })
})

describe("Next 24 hours", () => {
  const next = (id: string, nextRun: number | null, enabled = true) => ({
    id,
    name: `Routine ${id}`,
    agentId: "a1",
    enabled,
    nextRun,
  })

  test("a run due in 3 hours shows; the soonest is first", () => {
    const rows = nextRows([next("late", NOON + 20 * HOUR), next("soon", NOON + 3 * HOUR)], [], NOON)
    expect(rows.map((r) => r.id)).toEqual(["next:routine:soon", "next:routine:late"])
  })

  test("a routine that is paused or off does not show", () => {
    expect(nextRows([next("p", NOON + 3 * HOUR, false)], [], NOON)).toEqual([])
    expect(
      nextRows([], [{ id: "w", name: "W", enabled: false, nextRun: NOON + HOUR }], NOON),
    ).toEqual([])
  })

  test("a run after 24 hours, a run that is past, and no run do not show", () => {
    const rows = nextRows(
      [
        next("far", NOON + TODAY_AHEAD_MS + 1),
        next("past", NOON - 1),
        next("none", null),
        next("edge", NOON + TODAY_AHEAD_MS),
      ],
      [],
      NOON,
    )
    expect(rows.map((r) => r.id)).toEqual(["next:routine:edge"])
  })

  test("a scheduled workflow shows with the workflow kind", () => {
    const rows = nextRows(
      [],
      [{ id: "w", name: "Report", enabled: true, nextRun: NOON + HOUR }],
      NOON,
    )
    expect(rows[0]?.kind).toBe("workflow_next")
  })
})

describe("the page", () => {
  const row = (n: number): TodayRow => needsRows([card(n)], [])[0] as TodayRow

  test("the groups come in the order of the page and the badge counts all of Needs you", () => {
    const many = Array.from({ length: 21 }, (_, i) => row(i + 1))
    const snapshot = todaySnapshot(day.start, { needs: many, wrong: [], done: [], next: [] })
    expect(snapshot.groups.map((g) => g.id)).toEqual([...TODAY_GROUPS])
    expect(snapshot.badge).toBe(21)
    expect(snapshot.dayStart).toBe(day.start)
  })

  test("a group with no rows is hidden, but Needs you stays", () => {
    const snapshot = todaySnapshot(day.start, { needs: [], wrong: [], done: [], next: [] })
    expect(visibleGroups(snapshot, {}).map((g) => g.group.id)).toEqual(["needs"])
  })

  test("a group that cannot be read shows in place of rows, not as empty", () => {
    const snapshot: TodaySnapshot = todaySnapshot(day.start, {
      needs: [],
      wrong: null,
      done: [],
      next: [],
    })
    const shown = visibleGroups(snapshot, {})
    expect(shown.map((g) => g.group.id)).toEqual(["needs", "wrong"])
    expect(shown[1]?.group.unreadable).toBe(true)
    expect(snapshot.badge).toBe(0)
  })

  test("a group shows 20 rows and Show more adds 20", () => {
    const many = Array.from({ length: 45 }, (_, i) => row(i + 1))
    const snapshot = todaySnapshot(day.start, { needs: many, wrong: [], done: [], next: [] })
    const first = visibleGroups(snapshot, {})[0]
    expect(first?.rows).toHaveLength(20)
    expect(first?.more).toBe(25)
    const second = visibleGroups(snapshot, { needs: 40 })[0]
    expect(second?.rows).toHaveLength(40)
    expect(second?.more).toBe(5)
    const third = visibleGroups(snapshot, { needs: 60 })[0]
    expect(third?.rows).toHaveLength(45)
    expect(third?.more).toBe(0)
  })
})

describe("the filter by organization (spec 021)", () => {
  const snapshotOf = (rows: readonly TodayRow[]): TodaySnapshot =>
    todaySnapshot(day.start, { needs: rows, wrong: rows, done: rows, next: rows })

  test("it keeps the rows of the agents of the organization, and drops a row with no agent", () => {
    // Three approvals: two of agents, and one that names no agent (a row that a filter drops).
    const rows = needsRows(
      [
        card(1, { agentId: "ada" }),
        card(2, { agentId: "bo" }),
        card(3, { agentId: null as never }),
      ],
      [],
    )
    const out = todayForOrganization(snapshotOf(rows), new Set(["ada"]))
    expect(out.groups.every((g) => g.rows.map((r) => r.text).join(",") === "Run step 1")).toBe(true)
    // The groups stay four, in the same order.
    expect(out.groups.map((g) => g.id)).toEqual(["needs", "wrong", "done", "next"])
    // The badge does not change: it counts what waits, not what the filter shows.
    expect(out.badge).toBe(3)
  })

  test("a filter that keeps no row is told from one that keeps every row", () => {
    const rows = needsRows([card(1, { agentId: "ada" })], [])
    expect(todayFilterEmpty(todayForOrganization(snapshotOf(rows), new Set()))).toBe(true)
    expect(todayFilterEmpty(todayForOrganization(snapshotOf(rows), new Set(["ada"])))).toBe(false)
  })
})
