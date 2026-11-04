import { describe, expect, test } from "bun:test"
import { dayBounds, type TodayGroupId, type TodaySnapshot } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Database, type DatabaseService } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { Notifier } from "./Notifier.ts"
import { secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Today } from "./Today.ts"
import { testRuntime } from "./testing.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR

// A fake clock in the year 2036, so that no schedule in these tests is due by the real clock. The
// computer is at the middle of its day, whatever the time zone is.
const MIDDAY = dayBounds(Date.UTC(2036, 5, 15, 12, 0, 0)).start + 12 * HOUR
const day = dayBounds(MIDDAY)
/** A time inside the day of the fake clock: `n` hours after midnight. */
const at = (n: number) => day.start + n * HOUR

const setup = async () => {
  const t = testRuntime({ name: "This Mac" })
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const db: DatabaseService = await run(Database.use((d) => Effect.succeed(d)))
  let n = 0
  const id = (prefix: string) => `${prefix}-${++n}`

  const agent = async (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: local.id, name, role: "", instructions: "", model: null }),
      ),
    )
  const account = (name: string, kind = "openai", connected = true) => {
    const accountId = id("acc")
    db.run(
      "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES (?, ?, ?, '', 0)",
      accountId,
      kind,
      name,
    )
    if (connected)
      void run(Secrets.use((s) => Effect.sync(() => s.set(secretKey(accountId), "key"))))
    return accountId
  }
  const useAccount = (agentId: string, accountId: string) =>
    db.run(
      "UPDATE agent SET model_account_id = ?, model_name = 'm' WHERE id = ?",
      accountId,
      agentId,
    )

  const task = (
    agentId: string,
    extra: {
      source?: string
      sourceId?: string | null
      parentId?: string | null
      retryOf?: string | null
      state?: string
      code?: string | null
      created?: number
      finished?: number | null
      origin?: string | null
      label?: string
    } = {},
  ) => {
    const taskId = id("task")
    const created = extra.created ?? at(1)
    db.run(
      `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, retry_of, state,
         error_code, created_at, finished_at, origin)
       VALUES (?, ?, 'p', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId,
      agentId,
      extra.label ?? `Task ${taskId}`,
      extra.source ?? "chat",
      extra.sourceId === undefined ? agentId : extra.sourceId,
      extra.parentId ?? null,
      extra.retryOf ?? null,
      extra.state ?? "failed",
      extra.code === undefined ? "provider_error" : extra.code,
      created,
      extra.finished === undefined ? created + 1000 : extra.finished,
      extra.origin ?? null,
    )
    return taskId
  }
  const routine = (
    agentId: string,
    extra: {
      name?: string
      enabled?: boolean
      updated?: number
      schedule?: string
      runsOn?: string | null
    } = {},
  ) => {
    const routineId = id("routine")
    db.run(
      `INSERT INTO routine (id, server_id, agent_id, name, prompt, schedule, channel_id, enabled,
         last_checked_at, created_at, updated_at, runs_on)
       VALUES (?, ?, ?, ?, 'p', ?, NULL, ?, 0, 0, ?, ?)`,
      routineId,
      local.id,
      agentId,
      extra.name ?? "Morning check",
      extra.schedule ?? JSON.stringify({ kind: "once", at: MIDDAY + 3 * HOUR }),
      extra.enabled === false ? 0 : 1,
      extra.updated ?? 0,
      extra.runsOn ?? null,
    )
    return routineId
  }
  const workflow = (name: string, trigger: object, extra: { enabled?: boolean } = {}) => {
    const workflowId = id("wf")
    db.run(
      `INSERT INTO workflow (id, server_id, name, trigger, steps, edges, enabled, last_checked_at,
         created_at, updated_at) VALUES (?, ?, ?, ?, '[]', '[]', ?, 0, 0, 0)`,
      workflowId,
      local.id,
      name,
      JSON.stringify(trigger),
      extra.enabled === false ? 0 : 1,
    )
    return workflowId
  }
  const workflowRun = (workflowId: string, state: string, finished: number) =>
    db.run(
      `INSERT INTO workflow_run (id, workflow_id, state, trigger, trigger_text, started_at, finished_at)
       VALUES (?, ?, ?, 'manual', '', ?, ?)`,
      id("wrun"),
      workflowId,
      state,
      finished - 1000,
      finished,
    )
  const message = (
    agentId: string,
    extra: { status: string; code?: string | null; resets?: number | null; created: number },
  ) =>
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, error_code, error_resets_at, created_at, finished_at)
       VALUES (?, ?, 'agent', '[]', ?, ?, ?, ?, ?)`,
      id("msg"),
      agentId,
      extra.status,
      extra.code ?? null,
      extra.resets ?? null,
      extra.created,
      extra.created + 500,
    )
  const channel = (name: string) => {
    const channelId = id("channel")
    db.run(
      `INSERT INTO channel (id, server_id, name, name_key, topic, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 0, 0)`,
      channelId,
      local.id,
      name,
      name.toLowerCase(),
    )
    return channelId
  }
  const ask = (
    agentId: string,
    callId: string,
    extra: { from?: string; askedAt?: number; kind?: "approval" | "question" } = {},
  ) =>
    run(
      Notifier.use((notifier) =>
        Effect.sync(() =>
          notifier.attention(
            {
              agentId,
              serverId: local.id,
              channelId: null,
              callId,
              kind: extra.kind ?? "approval",
              always: true,
              summary: `Run step ${callId}`,
              step: null,
              target: { kind: "agent", id: agentId, messageId: `m-${callId}` },
              ...(extra.askedAt !== undefined ? { askedAt: extra.askedAt } : {}),
            },
            extra.from,
          ),
        ),
      ),
    )
  const answer = (agentId: string, callId: string) =>
    run(Notifier.use((notifier) => Effect.sync(() => notifier.clearAttention(agentId, callId))))
  const page = (now = MIDDAY) => run(Today.use((today) => today.snapshot(now)))
  const rows = async (group: TodayGroupId, now = MIDDAY) =>
    (await page(now)).groups.find((g) => g.id === group)?.rows ?? []
  return {
    ...t,
    run,
    db,
    local,
    id,
    agent,
    account,
    useAccount,
    task,
    routine,
    workflow,
    workflowRun,
    message,
    channel,
    ask,
    answer,
    page,
    rows,
  }
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

describe("Today", () => {
  test("a new app has four groups, all empty, and the badge is 0", async () => {
    const s = await setup()
    const snapshot = await s.page()
    expect(snapshot.groups.map((g) => g.id)).toEqual(["needs", "wrong", "done", "next"])
    expect(snapshot.groups.every((g) => g.rows.length === 0 && !g.unreadable)).toBe(true)
    expect(snapshot.badge).toBe(0)
    expect(snapshot.dayStart).toBe(day.start)
  })

  describe("Needs you", () => {
    test("an approval shows, and leaves when it is answered", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      await s.ask(ada.id, "c1")
      const [row] = await s.rows("needs")
      expect(row?.kind).toBe("approval")
      expect(row?.text).toBe("Run step c1")
      expect(row?.agentId).toBe(ada.id)
      expect(row?.open).toEqual({
        kind: "place",
        target: { kind: "agent", id: ada.id, messageId: "m-c1" },
      })
      expect((await s.page()).badge).toBe(1)
      await s.answer(ada.id, "c1")
      expect((await s.page()).badge).toBe(0)
    })

    test("the oldest request is first, and a question is a question", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      await s.ask(ada.id, "new", { askedAt: at(5) })
      await s.ask(ada.id, "old", { askedAt: at(2), kind: "question" })
      const list = await s.rows("needs")
      expect(list.map((r) => r.id)).toEqual([`question:${ada.id}:old`, `approval:${ada.id}:new`])
    })

    test("a request that is seen again keeps the time it began to wait", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      await s.ask(ada.id, "c1", { askedAt: at(3) })
      await s.ask(ada.id, "c1")
      expect((await s.rows("needs"))[0]?.at).toBe(at(3))
    })

    test("21 requests give 21 rows and the badge counts all of them", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      for (let i = 1; i <= 21; i++) await s.ask(ada.id, `c${i}`, { askedAt: at(1) + i })
      const snapshot = await s.page()
      expect(snapshot.groups[0]?.rows).toHaveLength(21)
      expect(snapshot.badge).toBe(21)
    })

    test("a request of the other computer names it", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      await s.ask(ada.id, "c1", { from: "Studio Mac" })
      const [row] = await s.rows("needs")
      expect(row?.computer).toBe("Studio Mac")
    })

    test("a failed part of a channel job shows until it is tried again", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const channelId = s.channel("Launch")
      const lead = s.task(ada.id, {
        source: "channel",
        sourceId: channelId,
        state: "running",
        finished: null,
      })
      const part = s.task(ada.id, {
        source: "channel",
        sourceId: channelId,
        parentId: lead,
        label: "Check the facts",
      })
      const [row] = await s.rows("needs")
      expect(row?.kind).toBe("part_failed")
      expect(row?.text).toBe("Check the facts")
      expect(row?.where).toEqual({ kind: "channel", name: "Launch" })
      expect(row?.open).toMatchObject({ kind: "place", target: { kind: "channel", id: channelId } })
      // A failed part is not listed as a task.
      expect(await s.rows("wrong")).toEqual([])
      // Retry makes a new part that links to the old one.
      s.task(ada.id, {
        source: "channel",
        sourceId: channelId,
        parentId: lead,
        retryOf: part,
        state: "running",
        finished: null,
      })
      expect(await s.rows("needs")).toEqual([])
    })

    test("a failed part leaves when its request is ended", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const channelId = s.channel("Launch")
      const lead = s.task(ada.id, {
        source: "channel",
        sourceId: channelId,
        state: "running",
        finished: null,
      })
      s.task(ada.id, { source: "channel", sourceId: channelId, parentId: lead })
      expect(await s.rows("needs")).toHaveLength(1)
      s.db.run("UPDATE task SET state = 'cancelled' WHERE id = ?", lead)
      expect(await s.rows("needs")).toHaveLength(0)
    })
  })

  describe("Went wrong", () => {
    test("a task that failed today shows; yesterday and the other computer do not", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const failed = s.task(ada.id, { created: at(2), label: "Write the report" })
      s.task(ada.id, { created: at(-3) })
      s.task(ada.id, { created: at(2), origin: "other-computer" })
      s.task(ada.id, { created: at(2), state: "cancelled" })
      const list = await s.rows("wrong")
      expect(list.map((r) => r.id)).toEqual([`task:${failed}`])
      expect(list[0]?.kind).toBe("task_failed")
      expect(list[0]?.text).toBe("Write the report")
      expect(list[0]?.where).toEqual({ kind: "direct", name: "" })
      expect(list[0]?.open).toEqual({ kind: "task", id: failed })
    })

    test("a blocked task shows with its own kind, and a retry makes the old row leave", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const blocked = s.task(ada.id, { state: "blocked" })
      expect((await s.rows("wrong"))[0]?.kind).toBe("task_blocked")
      s.task(ada.id, { retryOf: blocked, state: "running", finished: null })
      expect(await s.rows("wrong")).toEqual([])
    })

    test("the newest row is first", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const early = s.task(ada.id, { created: at(1) })
      const late = s.task(ada.id, { created: at(5) })
      expect((await s.rows("wrong")).map((r) => r.id)).toEqual([`task:${late}`, `task:${early}`])
    })

    test("after midnight the task rows are gone", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      s.task(ada.id, { created: at(5) })
      expect(await s.rows("wrong")).toHaveLength(1)
      expect(await s.rows("wrong", MIDDAY + DAY)).toHaveLength(0)
    })

    test("a routine with 3 failed runs that is paused has one row marked paused; resume removes it", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const routineId = s.routine(ada.id, { enabled: false, updated: at(0) })
      for (const h of [1, 2, 3])
        s.task(ada.id, {
          source: "routine",
          sourceId: routineId,
          created: at(h),
          code: "provider_not_connected",
        })
      const list = await s.rows("wrong")
      expect(list).toHaveLength(1)
      expect(list[0]?.kind).toBe("routine_paused")
      expect(list[0]?.count).toBe(3)
      expect(list[0]?.reason?.code).toBe("provider_not_connected")
      expect(list[0]?.open).toEqual({ kind: "routine", id: routineId })
      // The failed runs of a routine are not listed as tasks.
      expect(list.some((r) => r.kind === "task_failed")).toBe(false)
      // Resume: the routine is on, and the update marks the time of the resume.
      s.db.run("UPDATE routine SET enabled = 1, updated_at = ? WHERE id = ?", at(6), routineId)
      expect(await s.rows("wrong")).toEqual([])
    })

    // A deleted routine leaves nothing behind on the page: not a failed run, not a done run, not a
    // mark on the badge. Its old runs stay in the task history only.
    test("deleting a routine takes its failed and done runs off the page", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const routineId = s.routine(ada.id)
      for (const h of [1, 2])
        s.task(ada.id, { source: "routine", sourceId: routineId, created: at(h) })
      s.task(ada.id, {
        source: "routine",
        sourceId: routineId,
        state: "done",
        code: null,
        created: at(3),
      })
      expect((await s.rows("wrong")).length).toBeGreaterThan(0)
      expect((await s.rows("done")).length).toBe(1)

      s.db.run("DELETE FROM routine WHERE id = ?", routineId)

      expect(await s.rows("wrong")).toEqual([])
      expect(await s.rows("done")).toEqual([])
      expect((await s.page()).badge).toBe(0)
    })

    test("a watch paused after 3 failed checks has the row marked paused, and no next run", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const routineId = s.routine(ada.id, { enabled: false, updated: at(0), name: "Inbox watch" })
      s.db.run(
        "UPDATE routine SET schedule = 'null', watch = ? WHERE id = ?",
        JSON.stringify({
          minutes: 5,
          target: { kind: "path", path: "gone" },
          postUnchanged: false,
        }),
        routineId,
      )
      for (const h of [1, 2, 3])
        s.db.run(
          "INSERT INTO routine_skip (id, routine_id, at, kind, reason) VALUES (?, ?, ?, 'failed', ?)",
          `skip-${h}`,
          routineId,
          at(h),
          JSON.stringify({ code: "watch_missing", detail: "gone" }),
        )
      const list = await s.rows("wrong")
      expect(list.map((r) => r.kind)).toEqual(["routine_paused"])
      expect(list[0]?.count).toBe(3)
      expect(list[0]?.reason).toEqual({ code: "watch_missing", detail: "gone" })
      s.db.run("UPDATE routine SET enabled = 1, updated_at = ? WHERE id = ?", at(6), routineId)
      expect(await s.rows("next")).toEqual([])
    })

    test("the paused routine keeps its row after midnight; a failed run of an on routine does not", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const paused = s.routine(ada.id, { enabled: false, updated: at(0), name: "Paused one" })
      for (const h of [1, 2, 3])
        s.task(ada.id, { source: "routine", sourceId: paused, created: at(h) })
      const flaky = s.routine(ada.id, { name: "Flaky", updated: at(0) })
      s.task(ada.id, { source: "routine", sourceId: flaky, created: at(4) })
      expect((await s.rows("wrong")).map((r) => r.kind).sort()).toEqual([
        "routine_failed",
        "routine_paused",
      ])
      const tomorrow = await s.rows("wrong", MIDDAY + DAY)
      expect(tomorrow.map((r) => r.kind)).toEqual(["routine_paused"])
    })

    test("a plan limit shows with the reset time; a turn that succeeds removes it", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const accountId = s.account("Work account")
      s.useAccount(ada.id, accountId)
      s.message(ada.id, {
        status: "failed",
        code: "provider_limit",
        resets: MIDDAY + 2 * HOUR,
        created: at(3),
      })
      const [row] = await s.rows("wrong")
      expect(row?.kind).toBe("account_limit")
      expect(row?.text).toBe("Work account")
      expect(row?.resetsAt).toBe(MIDDAY + 2 * HOUR)
      expect(row?.open).toEqual({ kind: "account", id: accountId })
      // The reset time has passed.
      expect(await s.rows("wrong", MIDDAY + 3 * HOUR)).toEqual([])
      // A turn of the account succeeds.
      s.message(ada.id, { status: "done", created: at(4) })
      expect(await s.rows("wrong")).toEqual([])
    })

    test("a sign-in that is not valid shows, and a disconnect removes the row", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const accountId = s.account("Work account")
      s.useAccount(ada.id, accountId)
      s.message(ada.id, { status: "failed", code: "provider_auth", created: at(3) })
      expect((await s.rows("wrong"))[0]?.kind).toBe("account_signin")
      await s.run(Secrets.use((x) => Effect.sync(() => x.remove(secretKey(accountId)))))
      expect(await s.rows("wrong")).toEqual([])
      // A runtime account is disconnected by its switch.
      const runtime = s.account("Claude", "claude_code", false)
      s.useAccount(ada.id, runtime)
      s.message(ada.id, { status: "failed", code: "runtime_signed_out", created: at(5) })
      expect((await s.rows("wrong"))[0]?.kind).toBe("account_signin")
      s.db.run("UPDATE provider_account SET off = 1 WHERE id = ?", runtime)
      expect(await s.rows("wrong")).toEqual([])
    })
  })

  describe("Done today", () => {
    test("a routine that ran twice gives one row with the count 2", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const routineId = s.routine(ada.id)
      s.task(ada.id, {
        source: "routine",
        sourceId: routineId,
        state: "done",
        code: null,
        created: at(1),
      })
      s.task(ada.id, {
        source: "routine",
        sourceId: routineId,
        state: "done",
        code: null,
        created: at(3),
      })
      s.task(ada.id, {
        source: "routine",
        sourceId: routineId,
        state: "done",
        code: null,
        created: at(-5),
      })
      s.task(ada.id, { source: "chat", state: "done", code: null, created: at(2) })
      const list = await s.rows("done")
      expect(list).toHaveLength(1)
      expect(list[0]?.kind).toBe("routine_done")
      expect(list[0]?.count).toBe(2)
      expect(list[0]?.at).toBe(at(3) + 1000)
    })

    test("a workflow with a run that ended as done shows, newest first; after midnight it is empty", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const routineId = s.routine(ada.id)
      s.task(ada.id, {
        source: "routine",
        sourceId: routineId,
        state: "done",
        code: null,
        created: at(1),
      })
      const w = s.workflow("Weekly report", { kind: "manual" })
      s.workflowRun(w, "done", at(4))
      s.workflowRun(w, "failed", at(5))
      const list = await s.rows("done")
      expect(list.map((r) => r.kind)).toEqual(["workflow_done", "routine_done"])
      expect(list[0]?.count).toBe(1)
      expect(await s.rows("done", MIDDAY + DAY)).toEqual([])
    })
  })

  describe("Next 24 hours", () => {
    test("a routine due in 3 hours shows; pausing it removes the row", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const routineId = s.routine(ada.id)
      const [row] = await s.rows("next")
      expect(row?.kind).toBe("routine_next")
      expect(row?.at).toBe(MIDDAY + 3 * HOUR)
      s.db.run("UPDATE routine SET enabled = 0 WHERE id = ?", routineId)
      expect(await s.rows("next")).toEqual([])
    })

    test("only runs within 24 hours, soonest first, and only of this computer", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      const later = s.routine(ada.id, {
        name: "Later",
        schedule: JSON.stringify({ kind: "once", at: MIDDAY + 20 * HOUR }),
      })
      const soon = s.routine(ada.id, { name: "Soon" })
      s.routine(ada.id, {
        name: "Far",
        schedule: JSON.stringify({ kind: "once", at: MIDDAY + 30 * HOUR }),
      })
      s.routine(ada.id, { name: "Elsewhere", runsOn: "other-computer" })
      const w = s.workflow("Scheduled", {
        kind: "schedule",
        schedule: { kind: "once", at: MIDDAY + HOUR },
      })
      s.workflow(
        "Off",
        { kind: "schedule", schedule: { kind: "once", at: MIDDAY + HOUR } },
        { enabled: false },
      )
      s.workflow("Manual", { kind: "manual" })
      expect((await s.rows("next")).map((r) => r.id)).toEqual([
        `next:workflow:${w}`,
        `next:routine:${soon}`,
        `next:routine:${later}`,
      ])
    })
  })

  describe("a group that cannot be read", () => {
    // The page logs a source that it cannot read. These tests expect it.
    const quiet = async (body: () => Promise<void>) => {
      const original = console.error
      console.error = () => {}
      try {
        await body()
        // The loop of the service reads the page again soon after; it logs the same way.
        await Bun.sleep(300)
      } finally {
        console.error = original
      }
    }

    test("shows as unreadable, not as empty, and the others still show", () =>
      quiet(async () => {
        const s = await setup()
        const ada = await s.agent("Ada")
        s.routine(ada.id, { schedule: "not json" })
        await s.ask(ada.id, "c1")
        const snapshot = await s.page()
        const state = (id: TodayGroupId) => snapshot.groups.find((g) => g.id === id)
        expect(state("next")?.unreadable).toBe(true)
        expect(state("next")?.rows).toEqual([])
        expect(state("needs")?.unreadable).toBe(false)
        expect(state("needs")?.rows).toHaveLength(1)
        expect(snapshot.badge).toBe(1)
      }))

    test("is only the groups that read the broken source", () =>
      quiet(async () => {
        const s = await setup()
        // "Done today" and the tasks of "Went wrong" read the runs of workflows.
        s.db.run("DROP TABLE workflow_run")
        const snapshot = await s.page()
        const state = (id: TodayGroupId) => snapshot.groups.find((g) => g.id === id)
        expect(state("done")?.unreadable).toBe(true)
        expect(state("wrong")?.unreadable).toBe(true)
        expect(state("needs")?.unreadable).toBe(false)
        expect(state("next")?.unreadable).toBe(false)
      }))
  })

  describe("live update", () => {
    const pushes = (s: Awaited<ReturnType<typeof setup>>) =>
      s.events.filter((e) => e.event === "today.changed").map((e) => e.payload as TodaySnapshot)

    test("the page is pushed within a second of a change, and not again when nothing changed", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      await s.page()
      const started = Date.now()
      await s.ask(ada.id, "c1")
      await until(() => pushes(s).some((p) => p.badge === 1))
      expect(Date.now() - started).toBeLessThan(1000)
      const count = pushes(s).length
      // An event that changes nothing on the page pushes nothing.
      await s.run(
        EventBus.use((bus) =>
          Effect.sync(() => bus.emit("tasks.changed", { serverId: s.local.id })),
        ),
      )
      await Bun.sleep(400)
      expect(pushes(s)).toHaveLength(count)
      await s.answer(ada.id, "c1")
      await until(() => pushes(s).at(-1)?.badge === 0)
    })

    test("a task that fails is pushed with the event of the task", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      await s.page()
      s.task(ada.id, { created: Date.now(), finished: Date.now() })
      await s.run(
        EventBus.use((bus) =>
          Effect.sync(() => bus.emit("tasks.changed", { serverId: s.local.id })),
        ),
      )
      // The real clock is far from the fake one, so the row is read at the real day.
      await until(() =>
        pushes(s).some((p) => p.groups.some((g) => g.id === "wrong" && g.rows.length === 1)),
      )
    })

    test("the page is pushed when the clock passes midnight", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      s.task(ada.id, { created: at(2) })
      const first = await s.page()
      expect(first.groups.find((g) => g.id === "wrong")?.rows).toHaveLength(1)
      await s.run(Today.use((today) => today.check(MIDDAY + DAY)))
      const last = pushes(s).at(-1)
      expect(last?.dayStart).toBe(dayBounds(MIDDAY + DAY).start)
      expect(last?.groups.find((g) => g.id === "wrong")?.rows).toEqual([])
    })

    test("a plan limit ends when its reset time passes, without an event", async () => {
      const s = await setup()
      const ada = await s.agent("Ada")
      s.useAccount(ada.id, s.account("Work account"))
      s.message(ada.id, {
        status: "failed",
        code: "provider_limit",
        resets: MIDDAY + 2 * HOUR,
        created: at(3),
      })
      expect(await s.rows("wrong")).toHaveLength(1)
      await s.run(Today.use((today) => today.check(MIDDAY + 2 * HOUR + 1)))
      expect(
        pushes(s)
          .at(-1)
          ?.groups.find((g) => g.id === "wrong")?.rows,
      ).toEqual([])
    })
  })

  test("opening the page starts no turn and writes nothing", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    s.task(ada.id, { created: at(2) })
    await s.ask(ada.id, "c1")
    const before = s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task")?.n
    const messages = s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message")?.n
    const noticed = s.shell.notices.length
    await s.page()
    await s.page()
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task")?.n).toBe(before)
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message")?.n).toBe(messages)
    // The page makes no notification (015).
    expect(s.shell.notices.length).toBe(noticed)
  })
})
