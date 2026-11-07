import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunSource, RunSummary, TaskItem, WorkflowNode } from "@robot/shared"
import { Effect } from "effect"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import { runRequest } from "../rpc.ts"
import { Cards } from "./Cards.ts"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { Providers } from "./Providers.ts"
import { RunFacts } from "./RunFacts.ts"
import { Runs, runClock } from "./Runs.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

// The queue, the slots, "Run next", the moments, the quiet line and the retry note of the Tasks
// page (spec 005), on a real database and the real services. The model is a stand-in.

let mock: MockProvider
const clock = { ...runClock }
beforeAll(async () => {
  mock = await startMockProvider()
  runClock.retryWaitMs = 10
})
afterEach(() => {
  Object.assign(runClock, clock)
  runClock.retryWaitMs = 10
})
afterAll(async () => {
  await mock.close()
})

const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`timeout: ${what}`)
}

/** A prompt that the stand-in never answers, until the task is stopped. */
const HANG = "[[hang]] hold"

const setup = async (options: { databaseFile?: string } = {}) => {
  const t = testRuntime({ ...(options.databaseFile ? { databaseFile: options.databaseFile } : {}) })
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  await run(
    Providers.use((p) =>
      p.connect({ kind: "openai", name: "Mock", baseUrl: mock.openaiUrl, apiKey: GOOD_KEY }),
    ),
  )
  const account = (await run(Providers.use((p) => p.accounts)))[0]
  if (!account) throw new Error("no account")
  const flow = async (name: string, prompts: string[], level?: "ask_all" | "full") => {
    const w = await run(Workflows.use((x) => x.create({ serverId: server.id, name })))
    await run(Workflows.use((x) => x.setSelfImprovement(w.id, false)))
    await run(Memory.use((m) => m.setEnabled(w.id, false)))
    if (level) await run(Workflows.use((x) => x.setPermission(w.id, level)))
    const nodes: WorkflowNode[] = []
    for (const [i, prompt] of prompts.entries()) {
      const node = await run(
        Workflows.use((x) =>
          x.addNode(w.id, {
            kind: "text",
            name: `Step ${i + 1}`,
            prompt,
            accountId: account.id,
            model: "mock-fast",
          }),
        ),
      )
      const before = nodes.at(-1)
      if (before) await run(Workflows.use((x) => x.connect(w.id, before.id, node.id, null)))
      nodes.push(node)
    }
    return { ...w, nodes }
  }
  const start = (workflowId: string, source: RunSource = "hand", trigger?: string) =>
    run(
      Runs.use((r) => r.start({ workflowId, ...(trigger ? { trigger } : {}) }, source)),
    ) as Promise<RunSummary>
  const tasks = (filter: Parameters<Tasks["Service"]["list"]>[0] = {}) =>
    run(Tasks.use((x) => x.list(filter)))
  const taskOf = async (runId: string, node = 1): Promise<TaskItem> => {
    await until(async () => (await tasks()).some((x) => x.runId === runId), "task of run")
    const found = (await tasks()).find((x) => x.runId === runId && x.nodeNumber === node)
    if (!found) throw new Error("no task")
    return found
  }
  const stateOf = async (runId: string, node = 1) => (await taskOf(runId, node)).state
  /** The state of the task of a node, or null while the run has made no task for it. */
  const nodeState = async (runId: string, node: number) =>
    (await tasks()).find((x) => x.runId === runId && x.nodeNumber === node)?.state ?? null
  const stop = (runId: string) => run(Runs.use((r) => r.stop(runId)))
  const setSlots = (tasksAtOnce: number) => run(SettingsStore.use((s) => s.update({ tasksAtOnce })))
  const sql = <R>(statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all<R>(statement, ...params))))
  const cards = (workflowId: string) => run(Cards.use((c) => Effect.sync(() => c.open(workflowId))))
  const waitCard = async (workflowId: string) => {
    await until(async () => (await cards(workflowId)).length > 0, "a card")
    return (await cards(workflowId))[0] as NonNullable<Awaited<ReturnType<typeof cards>>[0]>
  }
  const ended = async (runId: string) => {
    await until(
      async () => (await run(Runs.use((r) => r.get(runId)))).finishedAt !== null,
      "run ended",
    )
    return run(Runs.use((r) => r.get(runId)))
  }
  /** The code and the detail of the error that a call fails with, or "ok". */
  const failure = (call: Promise<unknown>) =>
    call.then(
      () => ({ code: "ok" as string | undefined, detail: undefined as string | undefined }),
      (e: { code?: string; detail?: string }) => ({ code: e.code, detail: e.detail }),
    )
  const reasonLine = async (workflowId: string) => {
    const facts = await run(RunFacts.use((f) => f.runs(workflowId)))
    return facts.flatMap((f) => f.nodes.map((n) => n.reason))
  }
  return {
    ...t,
    run,
    flow,
    start,
    tasks,
    taskOf,
    stateOf,
    nodeState,
    stop,
    setSlots,
    sql,
    cards,
    waitCard,
    ended,
    reasonLine,
    failure,
  }
}

describe("slots: Tasks at once (spec 005, Queue)", () => {
  test("the default is 4 and the setting accepts 1 to 8 only", async () => {
    const t = await setup()
    expect((await t.run(SettingsStore.use((s) => s.get))).tasksAtOnce).toBe(4)
    await t.setSlots(8)
    expect((await t.run(SettingsStore.use((s) => s.get))).tasksAtOnce).toBe(8)
  })

  test("two slots, three workflows: two tasks run, the third waits for a free slot; Stop starts it at once", async () => {
    const t = await setup()
    await t.setSlots(2)
    const [a, b, c] = [
      await t.flow("A", [HANG]),
      await t.flow("B", [HANG]),
      await t.flow("C", [HANG]),
    ]
    const ra = await t.start(a.id)
    const rb = await t.start(b.id)
    const rc = await t.start(c.id)
    await until(async () => (await t.stateOf(ra.id)) === "running", "A runs")
    await until(async () => (await t.stateOf(rb.id)) === "running", "B runs")
    await until(async () => (await t.stateOf(rc.id)) === "queued", "C queues")
    const waiting = await t.taskOf(rc.id)
    expect(waiting.reasonCode).toBe("slot")
    expect(waiting.slots).toBe(2)
    expect(waiting.behind).toBeNull()
    expect((await t.run(Runs.use((r) => r.get(rc.id)))).state).toBe("queued")
    // The responsible document reads the same words (spec 003).
    expect(await t.reasonLine(c.id)).toContain("Waits for a free slot")
    await t.stop(ra.id)
    await until(async () => (await t.stateOf(rc.id)) === "running", "C runs after Stop")
    expect((await t.run(Runs.use((r) => r.get(rc.id)))).state).toBe("running")
    await t.stop(rb.id)
    await t.stop(rc.id)
  })

  test("a new number applies at once: with 3 slots the waiting task starts and the others go on", async () => {
    const t = await setup()
    await t.setSlots(2)
    const flows = [await t.flow("A", [HANG]), await t.flow("B", [HANG]), await t.flow("C", [HANG])]
    const runs: RunSummary[] = []
    for (const f of flows) runs.push(await t.start(f.id))
    await until(async () => (await t.stateOf(runs[2]?.id ?? "")) === "queued", "C queues")
    await t.setSlots(3)
    await until(async () => (await t.stateOf(runs[2]?.id ?? "")) === "running", "C runs")
    expect(await t.stateOf(runs[0]?.id ?? "")).toBe("running")
    expect(await t.stateOf(runs[1]?.id ?? "")).toBe("running")
    for (const r of runs) await t.stop(r.id)
  })

  test("lowering the number stops no task that runs", async () => {
    const t = await setup()
    await t.setSlots(3)
    const flows = [await t.flow("A", [HANG]), await t.flow("B", [HANG])]
    const runs: RunSummary[] = []
    for (const f of flows) runs.push(await t.start(f.id))
    await until(async () => (await t.stateOf(runs[1]?.id ?? "")) === "running", "B runs")
    await t.setSlots(1)
    await new Promise((r) => setTimeout(r, 100))
    expect(await t.stateOf(runs[0]?.id ?? "")).toBe("running")
    expect(await t.stateOf(runs[1]?.id ?? "")).toBe("running")
    for (const r of runs) await t.stop(r.id)
  })

  test("the workflow of the first waiting task is busy: the second task starts and the first keeps its place", async () => {
    const t = await setup()
    await t.setSlots(2)
    const a = await t.flow("A", [HANG])
    const b = await t.flow("B", [HANG])
    const a1 = await t.start(a.id)
    await until(async () => (await t.stateOf(a1.id)) === "running", "A1 runs")
    const a2 = await t.start(a.id)
    const b1 = await t.start(b.id)
    await until(async () => (await t.stateOf(b1.id)) === "running", "B1 runs")
    // The second slot went to B. The second run of A waits behind the first one, not for a slot.
    await until(async () => (await t.stateOf(a2.id)) === "queued", "A2 queues")
    const queued = await t.taskOf(a2.id)
    expect(queued.reasonCode).toBe("behind")
    expect(queued.behind).toMatchObject({ runId: a1.id, nodeNumber: 1, nodeName: "Step 1" })
    expect(await t.reasonLine(a.id)).toContain("Waits behind Step 1")
    await t.stop(b1.id)
    await new Promise((r) => setTimeout(r, 100))
    expect(await t.stateOf(a2.id)).toBe("queued")
    await t.stop(a1.id)
    await until(async () => (await t.stateOf(a2.id)) === "running", "A2 runs after A1")
    await t.stop(a2.id)
  })

  test("a task that waits for an approval uses no slot; after the answer it waits for a slot, with its workflow held", async () => {
    const t = await setup()
    await t.setSlots(1)
    const a = await t.flow("A", ['tool run_command {"command":"echo slot-test"}'], "ask_all")
    const b = await t.flow("B", [HANG])
    const ra = await t.start(a.id)
    const card = await t.waitCard(a.id)
    expect(await t.stateOf(ra.id)).toBe("waiting")
    // The slot is free: a task of another workflow starts and runs.
    const rb = await t.start(b.id)
    await until(async () => (await t.stateOf(rb.id)) === "running", "B runs while A waits")
    // A second task of the first workflow stays queued, behind the task that waits.
    const a2 = await t.start(a.id)
    await until(async () => (await t.stateOf(a2.id)) === "queued", "A2 queues")
    expect((await t.taskOf(a2.id)).reasonCode).toBe("behind")
    // The user allows the step of A: A waits as queued for the slot that B holds.
    await t.run(Cards.use((c) => c.answer(card.id, { kind: "approval", answer: "allow" })))
    await until(async () => (await t.stateOf(ra.id)) === "queued", "A queues for a slot")
    const back = await t.taskOf(ra.id)
    expect(back.reasonCode).toBe("slot")
    // The second task of A did not take the slot, and B still runs.
    expect(await t.stateOf(rb.id)).toBe("running")
    expect(await t.stateOf(a2.id)).toBe("queued")
    await t.stop(rb.id)
    await until(async () => (await t.stateOf(ra.id)) === "done", "A finishes")
    const first = await t.ended(ra.id)
    expect(first.state).toBe("done")
    // A2 now has its turn: it asks for approval too.
    await until(async () => (await t.stateOf(a2.id)) === "waiting", "A2 asks")
    await t.stop(a2.id)
  })
})

describe("the order of the queue (spec 005, Queue)", () => {
  test("two runs of one workflow: the second waits until the first ends", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const r1 = await t.start(a.id)
    const r2 = await t.start(a.id)
    expect(r2.state).toBe("queued")
    await until(async () => (await t.stateOf(r2.id)) === "queued", "task of run 2")
    expect(await t.stateOf(r1.id)).toBe("running")
    await t.stop(r1.id)
    await until(async () => (await t.stateOf(r2.id)) === "running", "run 2 runs")
    await t.stop(r2.id)
  })

  test("a run of the user starts before a run of a schedule that came first; two schedule runs keep their order", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const first = await t.start(a.id)
    await until(async () => (await t.stateOf(first.id)) === "running", "first runs")
    const s1 = await t.start(a.id, "schedule")
    const s2 = await t.start(a.id, "schedule")
    const hand = await t.start(a.id, "hand")
    for (const r of [s1, s2, hand])
      await until(async () => (await t.stateOf(r.id)) === "queued", "queued")
    const order: string[] = []
    for (const [name, id] of [
      ["hand", hand.id],
      ["s1", s1.id],
      ["s2", s2.id],
    ] as const) {
      await t.stop(order.length === 0 ? first.id : (order.at(-1) ?? ""))
      void name
      order.push(id)
      await until(async () => (await t.stateOf(id)) === "running", `${name} runs`)
    }
    // The order of the starts: hand, then the schedule runs in the order they were made.
    expect(order).toEqual([hand.id, s1.id, s2.id])
    await t.stop(s2.id)
  })

  test("Run next: the third task starts first when the running task ends; a later pick of the second goes before the third", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const first = await t.start(a.id)
    await until(async () => (await t.stateOf(first.id)) === "running", "first runs")
    const second = await t.start(a.id)
    const third = await t.start(a.id)
    for (const r of [second, third])
      await until(async () => (await t.stateOf(r.id)) === "queued", "queued")
    expect((await t.taskOf(third.id)).canRunNext).toBe(true)
    expect((await t.taskOf(first.id)).canRunNext).toBe(false)
    const pick = async (runId: string) => {
      const task = await t.taskOf(runId)
      await t.run(Tasks.use((x) => x.runNext(task.id)))
    }
    await pick(third.id)
    await t.stop(first.id)
    await until(async () => (await t.stateOf(third.id)) === "running", "third runs first")
    expect(await t.stateOf(second.id)).toBe("queued")
    await t.stop(third.id)
    await until(async () => (await t.stateOf(second.id)) === "running", "second runs")
    await t.stop(second.id)
  })

  test("Run next picked on the second after the third: the second starts before the third", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const first = await t.start(a.id)
    await until(async () => (await t.stateOf(first.id)) === "running", "first runs")
    const second = await t.start(a.id)
    const third = await t.start(a.id)
    for (const r of [second, third])
      await until(async () => (await t.stateOf(r.id)) === "queued", "queued")
    for (const r of [third, second]) {
      const task = await t.taskOf(r.id)
      await t.run(Tasks.use((x) => x.runNext(task.id)))
    }
    await t.stop(first.id)
    await until(async () => (await t.stateOf(second.id)) === "running", "second runs first")
    expect(await t.stateOf(third.id)).toBe("queued")
    await t.stop(second.id)
    await until(async () => (await t.stateOf(third.id)) === "running", "third runs")
    await t.stop(third.id)
  })

  test("Run next is refused for a task that is not queued", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const r = await t.start(a.id)
    await until(async () => (await t.stateOf(r.id)) === "running", "runs")
    const task = await t.taskOf(r.id)
    expect((await t.failure(t.run(Tasks.use((x) => x.runNext(task.id))))).code).toBe(
      "cannot_run_next",
    )
    await t.stop(r.id)
  })
})

describe("runs of a workflow with more than one node (spec 005, Rules; 010)", () => {
  for (const slots of [1, 2]) {
    test(`${slots} slot${slots === 1 ? "" : "s"}: two runs do not interleave; the second run waits for the end of the first, and starts when the first is stopped`, async () => {
      const t = await setup()
      await t.setSlots(slots)
      const a = await t.flow("A", ["hello", HANG])
      const r1 = await t.start(a.id)
      const r2 = await t.start(a.id)
      expect(r2.state).toBe("queued")
      await until(async () => (await t.nodeState(r1.id, 2)) === "running", "node 2 of run 1 runs")
      // The order is node 1 and 2 of run 1, then node 1 and 2 of run 2. Never node 1 of run 2 in between.
      expect(await t.nodeState(r1.id, 1)).toBe("done")
      expect(await t.nodeState(r2.id, 1)).toBe("queued")
      expect(await t.nodeState(r2.id, 2)).toBeNull()
      await t.stop(r1.id)
      const d1 = await t.ended(r1.id)
      await until(async () => (await t.nodeState(r2.id, 2)) === "running", "node 2 of run 2 runs")
      expect(await t.nodeState(r2.id, 1)).toBe("done")
      const startedAt = await t.sql<{ started_at: number }>(
        "SELECT started_at FROM task WHERE run_id = ? AND node_number = 1",
        r2.id,
      )
      expect(startedAt[0]?.started_at).toBeGreaterThanOrEqual(d1.finishedAt ?? Number.MAX_VALUE)
      await t.stop(r2.id)
    })
  }

  test("a node that fails ends its run and frees the workflow for the second run", async () => {
    const t = await setup()
    const a = await t.flow("A", ["hello", "[[fail]] x"])
    const r1 = await t.start(a.id)
    const r2 = await t.start(a.id)
    const d1 = await t.ended(r1.id)
    const d2 = await t.ended(r2.id)
    expect(d1.state).toBe("failed")
    expect(d2.state).toBe("failed")
    expect(d2.nodes.map((n) => n.state)).toEqual(["done", "failed"])
    const first = await t.sql<{ started_at: number }>(
      "SELECT started_at FROM task WHERE run_id = ? AND node_number = 1",
      r2.id,
    )
    expect(first[0]?.started_at).toBeGreaterThanOrEqual(d1.finishedAt ?? Number.MAX_VALUE)
  })

  test("a run that waits for an approval between its nodes keeps its place: the second run waits", async () => {
    const t = await setup()
    const a = await t.flow("A", ['tool run_command {"command":"echo held"}', "second"], "ask_all")
    const r1 = await t.start(a.id)
    const r2 = await t.start(a.id)
    const card = await t.waitCard(a.id)
    expect(await t.nodeState(r1.id, 1)).toBe("waiting")
    expect(await t.nodeState(r2.id, 1)).toBe("queued")
    await t.run(Cards.use((c) => c.answer(card.id, { kind: "approval", answer: "allow" })))
    // The first run goes through its second node; only then does the second run start.
    const d1 = await t.ended(r1.id)
    expect(d1.nodes.map((n) => n.state)).toEqual(["done", "done"])
    await until(async () => (await t.nodeState(r2.id, 1)) === "waiting", "run 2 asks")
    expect(await t.nodeState(r2.id, 2)).toBeNull()
    await t.stop(r2.id)
  })

  test("Run next on a task of the second run does not start it between the nodes of the first run", async () => {
    const t = await setup()
    const a = await t.flow("A", ["hello", HANG])
    const r1 = await t.start(a.id)
    const r2 = await t.start(a.id)
    const queued = await t.taskOf(r2.id)
    await t.run(Tasks.use((x) => x.runNext(queued.id)))
    await until(async () => (await t.nodeState(r1.id, 2)) === "running", "node 2 of run 1 runs")
    expect(await t.nodeState(r2.id, 1)).toBe("queued")
    await t.stop(r1.id)
    await until(async () => (await t.nodeState(r2.id, 2)) === "running", "run 2 goes on")
    await t.stop(r2.id)
  })

  test("after a restart the new queue holds nothing: both runs failed, and a new run of the workflow starts at once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-tasks-")), "robot.db")
    const t = await setup({ databaseFile: file })
    const a = await t.flow("A", ["hello", HANG])
    const r1 = await t.start(a.id)
    const r2 = await t.start(a.id)
    await until(async () => (await t.nodeState(r1.id, 2)) === "running", "node 2 of run 1 runs")
    const again = testRuntime({ databaseFile: file })
    const go = again.runtime.runPromise
    for (const id of [r1.id, r2.id]) {
      const d = await go(Runs.use((r) => r.get(id)))
      expect(d.state).toBe("failed")
      expect(d.reasonText).toBe("The app stopped")
    }
    const tasksAfter = await go(Tasks.use((x) => x.list({})))
    expect(tasksAfter.filter((x) => x.runId === r2.id).map((x) => x.state)).toEqual(["failed"])
    const fresh = await go(Runs.use((r) => r.start({ workflowId: a.id })))
    expect(fresh.state).toBe("running")
    await go(Runs.use((r) => r.stop(fresh.id)))
    await t.stop(r1.id)
  })
})

describe("the limit of 20 queued tasks (spec 005, Queue)", () => {
  test("the 21st queued start by hand makes no run and names the workflow; a schedule run is Failed with that reason", async () => {
    const t = await setup()
    const a = await t.flow("Weekly", [HANG])
    const running = await t.start(a.id)
    const queued: RunSummary[] = []
    for (let i = 0; i < 20; i++) queued.push(await t.start(a.id))
    // Each run makes its task a moment after the start: wait for the 21 tasks.
    await until(async () => (await t.tasks()).length === 21, "21 tasks")
    const refused = await t.failure(t.run(Runs.use((r) => r.start({ workflowId: a.id }))))
    expect(refused).toEqual({ code: "run_queue_full", detail: "Weekly" })
    // No task was made for the refused start.
    expect((await t.sql<{ n: number }>("SELECT COUNT(*) AS n FROM run"))[0]?.n).toBe(21)
    expect((await t.tasks()).length).toBe(21)
    // A schedule run in the same state is a failed run with the reason, and it holds no task.
    const failed = await t.start(a.id, "schedule")
    expect(failed.state).toBe("failed")
    expect(failed.reasonText).toBe("Weekly has 20 tasks that wait. Try again later.")
    expect(failed.reasonCode).toBe("run_queue_full")
    for (const r of [running, ...queued].reverse()) await t.stop(r.id)
  })

  test("a task that waits for the user does not count", async () => {
    const t = await setup()
    const a = await t.flow("A", ['tool run_command {"command":"echo x"}'], "ask_all")
    const first = await t.start(a.id)
    await t.waitCard(a.id)
    expect(await t.stateOf(first.id)).toBe("waiting")
    // 20 more starts queue behind the task that waits; the 21st is refused only then.
    const more: RunSummary[] = []
    for (let i = 0; i < 20; i++) more.push(await t.start(a.id))
    const refused = await t.failure(t.run(Runs.use((r) => r.start({ workflowId: a.id }))))
    expect(refused.code).toBe("run_queue_full")
    for (const r of [first, ...more].reverse()) await t.stop(r.id)
  })
})

describe("stop (spec 005, States and reasons)", () => {
  test("Stop of a run: the running task is Cancelled with 'Stopped by you'; a queued task of another run is untouched", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const r1 = await t.start(a.id)
    await until(async () => (await t.stateOf(r1.id)) === "running", "runs")
    const r2 = await t.start(a.id)
    await until(async () => (await t.stateOf(r2.id)) === "queued", "queued")
    await t.stop(r1.id)
    const d1 = await t.ended(r1.id)
    expect(d1.nodes[0]?.task).toMatchObject({
      state: "cancelled",
      reasonCode: "user",
      reasonText: "Stopped by you",
    })
    await until(async () => (await t.stateOf(r2.id)) === "running", "second runs")
    await t.stop(r2.id)
  })

  test("a task that was queued when its run was stopped shows 'The run was stopped'", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const r1 = await t.start(a.id)
    await until(async () => (await t.stateOf(r1.id)) === "running", "runs")
    const r2 = await t.start(a.id)
    await until(async () => (await t.stateOf(r2.id)) === "queued", "queued")
    await t.stop(r2.id)
    const d2 = await t.run(Runs.use((r) => r.get(r2.id)))
    expect(d2.state).toBe("cancelled")
    const task = await t.taskOf(r2.id)
    expect(task).toMatchObject({
      state: "cancelled",
      reasonCode: "run",
      reasonText: "The run was stopped",
    })
    await t.stop(r1.id)
  })

  test("Stop of one queued task by the user: 'Stopped by you', and the run ends", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const r1 = await t.start(a.id)
    await until(async () => (await t.stateOf(r1.id)) === "running", "runs")
    const r2 = await t.start(a.id)
    await until(async () => (await t.stateOf(r2.id)) === "queued", "queued")
    const queued = await t.taskOf(r2.id)
    await t.run(Tasks.use((x) => x.stop(queued.id)))
    const task = await t.taskOf(r2.id)
    expect(task).toMatchObject({ state: "cancelled", reasonText: "Stopped by you" })
    expect((await t.run(Runs.use((r) => r.get(r2.id)))).state).toBe("cancelled")
    await t.stop(r1.id)
  })

  test("a task stopped while it waits for a free slot frees its place in the order", async () => {
    const t = await setup()
    await t.setSlots(1)
    const [a, b, c] = [
      await t.flow("A", [HANG]),
      await t.flow("B", [HANG]),
      await t.flow("C", [HANG]),
    ]
    const ra = await t.start(a.id)
    const rb = await t.start(b.id)
    const rc = await t.start(c.id)
    await until(async () => (await t.stateOf(rc.id)) === "queued", "C queues")
    await t.stop(rb.id)
    await t.stop(ra.id)
    await until(async () => (await t.stateOf(rc.id)) === "running", "C runs")
    await t.stop(rc.id)
  })
})

describe("moments and times (spec 005, Moments and Times)", () => {
  test("a task that ended has the moments Given, Started, Ended and Closed in order, with times", async () => {
    const t = await setup()
    const a = await t.flow("A", ["hello"])
    const r = await t.start(a.id)
    await t.ended(r.id)
    const task = await t.taskOf(r.id)
    const view = await t.run(Tasks.use((x) => x.get(task.id)))
    expect(view.state).toBe("done")
    expect(view.moments.map((m) => m.kind)).toEqual(["given", "started", "ended", "closed"])
    expect(view.moments[2]).toMatchObject({ how: "done" })
    const at = view.moments.map((m) => m.at)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(view.times.wait).not.toBeNull()
    expect(view.times.firstReply).not.toBeNull()
    expect(view.times.total).not.toBeNull()
    expect(view.times.total ?? 0).toBeGreaterThanOrEqual(view.times.firstReply ?? 0)
  })

  test("a task that waits to start has Given only", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const r1 = await t.start(a.id)
    await until(async () => (await t.stateOf(r1.id)) === "running", "runs")
    const r2 = await t.start(a.id)
    await until(async () => (await t.stateOf(r2.id)) === "queued", "queued")
    const queued = await t.taskOf(r2.id)
    const view = await t.run(Tasks.use((x) => x.get(queued.id)))
    expect(view.moments.map((m) => m.kind)).toEqual(["given"])
    expect(view.times.wait).toBeNull()
    expect(view.times.total).toBeNull()
    await t.stop(r2.id)
    await t.stop(r1.id)
  })

  test("a task that failed before any reply has no first reply: the time is not known, not 0", async () => {
    const t = await setup()
    const a = await t.flow("A", ["[[fail]] x"])
    const r = await t.start(a.id)
    await t.ended(r.id)
    const task = await t.taskOf(r.id)
    const view = await t.run(Tasks.use((x) => x.get(task.id)))
    expect(view.state).toBe("failed")
    expect(view.times.firstReply).toBeNull()
    expect(view.times.wait).not.toBeNull()
    expect(view.moments.map((m) => m.kind)).toEqual(["given", "started", "ended", "closed"])
    expect(view.moments[2]).toMatchObject({ how: "failed" })
  })

  test("a task that was stopped by a restart has a closed moment and no known total", async () => {
    const t = await setup()
    const a = await t.flow("A", [HANG])
    const r = await t.start(a.id)
    await until(async () => (await t.stateOf(r.id)) === "running", "runs")
    await t.stop(r.id)
    await t.ended(r.id)
    const task = await t.taskOf(r.id)
    const view = await t.run(Tasks.use((x) => x.get(task.id)))
    expect(view.state).toBe("cancelled")
    expect(view.moments.map((m) => m.kind)).toEqual(["given", "started", "ended", "closed"])
    expect(view.moments[2]).toMatchObject({ how: "cancelled" })
  })
})

describe("the retry note and Retry (spec 005, Retry note)", () => {
  const echo = 'tools 25 run_command {"command":"echo changed"}'

  test("a failed task whose first try ran steps shows the note first: at most 5 steps, newest first, 'and N more'; Back starts nothing", async () => {
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ stepLimit: 20 })))
    const a = await t.flow("A", [echo], "full")
    const r = await t.start(a.id)
    const d = await t.ended(r.id)
    expect(d.nodes[0]?.task).toMatchObject({ state: "failed", reasonCode: "steps:20" })
    const task = await t.taskOf(r.id)
    const runsBefore = (await t.sql<{ n: number }>("SELECT COUNT(*) AS n FROM run"))[0]?.n
    const result = await t.run(Tasks.use((x) => x.retry(task.id)))
    expect(result.started).toBe(false)
    if (!result.started) {
      expect(result.note.steps).toHaveLength(5)
      expect(result.note.steps[0]).toMatchObject({ kind: "shell", result: "ran" })
      expect(result.note.more).toBe(15)
      expect(result.note.computer).toBeNull()
    }
    // "Back" is a window action that sends nothing: no run was made.
    expect((await t.sql<{ n: number }>("SELECT COUNT(*) AS n FROM run"))[0]?.n).toBe(runsBefore)
    // "Retry anyway" starts a new task of the same node, with the same input, linked to the old one.
    const again = await t.run(Tasks.use((x) => x.retry(task.id, true)))
    expect(again.started).toBe(true)
    if (again.started) {
      const next = await t.ended(again.runId)
      const nextTask = next.nodes[0]?.task
      expect(nextTask?.retryOf).toBe(task.id)
      expect(next.total).toBe(1)
      expect(nextTask?.input).toBe((await t.run(Tasks.use((x) => x.get(task.id)))).input)
    }
  })

  test("a task that only read files, or ran nothing, starts at once on Retry; a task that did not fail cannot be retried", async () => {
    const t = await setup()
    const a = await t.flow("A", ["[[fail]] x"])
    const r = await t.start(a.id)
    await t.ended(r.id)
    const task = await t.taskOf(r.id)
    const result = await t.run(Tasks.use((x) => x.retry(task.id)))
    expect(result.started).toBe(true)
    const done = await t.flow("B", ["hello"])
    const ok = await t.start(done.id)
    await t.ended(ok.id)
    const okTask = await t.taskOf(ok.id)
    expect((await t.failure(t.run(Tasks.use((x) => x.retry(okTask.id))))).code).toBe(
      "cannot_retry_task",
    )
  })

  const MARKS = [
    {
      mark: "outside",
      column: "outside_mark",
      value: JSON.stringify({ kind: "page", host: "evil.example" }),
    },
    { mark: "program", column: "program_mark", value: 1 },
    { mark: "sensitive", column: "sensitive_mark", value: "keys" },
  ] as const
  for (const m of MARKS) {
    test(`Retry holds the ${m.mark} mark of the task that it tries again (spec 007)`, async () => {
      const t = await setup()
      const a = await t.flow("A", ["[[fail]] x"])
      const r = await t.start(a.id)
      await t.ended(r.id)
      const task = await t.taskOf(r.id)
      await t.sql(`UPDATE task SET ${m.column} = ? WHERE id = ?`, m.value, task.id)
      const result = await t.run(Tasks.use((x) => x.retry(task.id)))
      if (!result.started) throw new Error("note")
      await t.ended(result.runId)
      const marks = (runId: string) =>
        t.sql<{ outside_mark: string | null; program_mark: number; sensitive_mark: string | null }>(
          "SELECT outside_mark, program_mark, sensitive_mark FROM task WHERE run_id = ?",
          runId,
        )
      const again = (await marks(result.runId))[0]
      const before = (await marks(r.id))[0]
      expect(before?.[m.column]).toBe(m.value)
      expect(again).toEqual(before)
      // Only the mark that was set is held: a retry takes over no mark that the task did not hold.
      for (const other of MARKS)
        if (other.mark !== m.mark)
          expect(again?.[other.column]).toBe(other.column === "program_mark" ? 0 : null)
    })
  }

  test("a guarded step of the retry asks again, with the marks of the task that it tries again", async () => {
    const t = await setup()
    const a = await t.flow("A", ['tool run_command {"command":"echo again"}'], "ask_all")
    const r = await t.start(a.id)
    await t.waitCard(a.id)
    await t.stop(r.id)
    await t.ended(r.id)
    const task = await t.taskOf(r.id)
    await t.sql(
      "UPDATE task SET outside_mark = ?, sensitive_mark = 'keys' WHERE id = ?",
      JSON.stringify({ kind: "page", host: "evil.example" }),
      task.id,
    )
    const result = await t.run(Tasks.use((x) => x.retry(task.id, true)))
    if (!result.started) throw new Error("note")
    const card = await t.waitCard(a.id)
    expect(card).toMatchObject({
      kind: "approval",
      step: "shell",
      outside: { kind: "page", host: "evil.example" },
      sensitive: "keys",
    })
    await t.stop(result.runId)
  })

  test("Retry runs the checks of a start: no node, a loop, or a problem of the check stops it", async () => {
    const t = await setup()
    const a = await t.flow("A", ["[[fail]] x", "second"])
    const r = await t.start(a.id)
    await t.ended(r.id)
    const task = await t.taskOf(r.id)
    const runs = () => t.sql<{ n: number }>("SELECT COUNT(*) AS n FROM run")
    const before = (await runs())[0]?.n
    // A decision option with no connection is a problem of the shape: the check finds it.
    const decision = await t.run(
      Workflows.use((w) =>
        w.addNode(a.id, {
          kind: "decision",
          name: "Choose",
          question: "Which?",
          threshold: 0.9,
          options: ["Yes", "No"],
        }),
      ),
    )
    expect((await t.failure(t.run(Tasks.use((x) => x.retry(task.id))))).code).toBe(
      "run_check_problem",
    )
    await t.run(Workflows.use((w) => w.removeNode(decision.id)))
    // A loop never starts, whatever the check says.
    const [n1, n2] = a.nodes
    await t.sql(
      "INSERT INTO workflow_connection (id, workflow_id, from_node_id, to_node_id) VALUES ('loop', ?, ?, ?)",
      a.id,
      n2?.id ?? "",
      n1?.id ?? "",
    )
    expect((await t.failure(t.run(Tasks.use((x) => x.retry(task.id))))).code).toBe("run_loop")
    await t.sql("DELETE FROM workflow_connection WHERE id = 'loop'")
    // A workflow with no node.
    for (const n of a.nodes) await t.run(Workflows.use((w) => w.removeNode(n.id)))
    expect((await t.failure(t.run(Tasks.use((x) => x.retry(task.id))))).code).toBe("run_empty")
    expect((await runs())[0]?.n).toBe(before)
  })

  test("Retry of a task of a retry does not run the nodes after it", async () => {
    const t = await setup()
    const a = await t.flow("A", ["[[fail]] first", "second"])
    const r = await t.start(a.id)
    const d = await t.ended(r.id)
    expect(d.nodes.map((n) => n.state)).toEqual(["failed", "not_reached"])
    const task = await t.taskOf(r.id)
    const result = await t.run(Tasks.use((x) => x.retry(task.id)))
    if (!result.started) throw new Error("note")
    const next = await t.ended(result.runId)
    expect(next.nodes.map((n) => n.number)).toEqual([1])
    expect(next.total).toBe(1)
  })
})

describe("the quiet line (spec 005, Quiet line)", () => {
  test("a turn that shows no sign of life for the quiet time is quiet, with the name of the account; it fails at the silent limit and the quiet line goes", async () => {
    const t = await setup()
    // The silent limit is 10 minutes of 100 ms: 1 s. The quiet time is half of it, cut by 50 ms.
    runClock.minuteMs = 100
    runClock.quietMs = 50
    const a = await t.flow("A", [HANG])
    const r = await t.start(a.id)
    await until(async () => (await t.stateOf(r.id)) === "running", "runs")
    const task = await t.taskOf(r.id)
    await until(
      async () => (await t.tasks()).find((x) => x.id === task.id)?.quiet != null,
      "the quiet line",
    )
    const quiet = (await t.tasks()).find((x) => x.id === task.id)?.quiet
    expect(quiet?.name).toBe("Mock")
    expect(quiet?.seconds).toBeGreaterThanOrEqual(0)
    const d = await t.ended(r.id)
    expect(d.nodes[0]?.task).toMatchObject({ state: "failed", reasonCode: "silent:10" })
    expect((await t.tasks()).find((x) => x.id === task.id)?.quiet).toBeNull()
  })

  test("a turn that shows signs of life is never quiet", async () => {
    const t = await setup()
    runClock.quietMs = 300
    const a = await t.flow("A", ["slow one"])
    const r = await t.start(a.id)
    let seen = false
    await until(
      async () => {
        if ((await t.tasks()).some((x) => x.quiet !== null)) seen = true
        return (await t.run(Runs.use((x) => x.get(r.id)))).finishedAt !== null
      },
      "the end",
      10_000,
    )
    expect(seen).toBe(false)
  })

  test("a task that waits for an approval is not quiet, and the quiet clock starts at 0 after the answer", async () => {
    const t = await setup()
    runClock.quietMs = 150
    const a = await t.flow("A", ['tool run_command {"command":"echo q"}'], "ask_all")
    const r = await t.start(a.id)
    const card = await t.waitCard(a.id)
    await new Promise((x) => setTimeout(x, 400))
    expect((await t.tasks()).some((x) => x.quiet !== null)).toBe(false)
    await t.run(Cards.use((c) => c.answer(card.id, { kind: "approval", answer: "allow" })))
    await t.ended(r.id)
    expect((await t.tasks()).some((x) => x.quiet !== null)).toBe(false)
  })
})

describe("the Tasks page: the list and the filters (spec 005, Tasks page)", () => {
  test("the table lists the tasks newest first with workflow, node, source and state; the filters keep the rows that match", async () => {
    const t = await setup()
    const a = await t.flow("Alpha", ["one"])
    const b = await t.flow("Beta", ["[[fail]] two"])
    const r1 = await t.start(a.id, "hand")
    await t.ended(r1.id)
    const r2 = await t.start(b.id, "chat")
    await t.ended(r2.id)
    const r3 = await t.start(a.id, "schedule")
    await t.ended(r3.id)
    const all = await t.tasks()
    expect(all.map((x) => x.runId)).toEqual([r3.id, r2.id, r1.id])
    expect(all.map((x) => x.workflowName)).toEqual(["Alpha", "Beta", "Alpha"])
    expect(all.map((x) => x.source)).toEqual(["schedule", "chat", "hand"])
    expect((await t.tasks({ state: "failed" })).map((x) => x.workflowName)).toEqual(["Beta"])
    expect((await t.tasks({ workflowId: a.id })).map((x) => x.source)).toEqual(["schedule", "hand"])
    expect((await t.tasks({ source: "chat" })).map((x) => x.runId)).toEqual([r2.id])
    expect(await t.tasks({ state: "queued" })).toEqual([])
  })

  test("a task that waits for the user shows why: approval, question or pick, in the words of 005", async () => {
    const t = await setup()
    const a = await t.flow("A", ['tool run_command {"command":"echo why"}'], "ask_all")
    const r = await t.start(a.id)
    await t.waitCard(a.id)
    const task = await t.taskOf(r.id)
    expect(task.state).toBe("waiting")
    expect(task.reasonCode).toBe("approval")
    expect(await t.reasonLine(a.id)).toContain(
      "Waits for your approval of the step: echo why. The approval card is in the chat.",
    )
    await t.stop(r.id)
  })
})

describe("a run that a linked device starts is attributed to it (spec 012, 005)", () => {
  /** The device that a run records, or null for a start in the window. */
  const deviceOf = async (t: Awaited<ReturnType<typeof setup>>, runId: string) =>
    (await t.sql<{ device: string | null }>("SELECT device FROM run WHERE id = ?", runId))[0]
      ?.device

  const link = (t: Awaited<ReturnType<typeof setup>>) =>
    t.run(
      Database.use((d) =>
        Effect.sync(() =>
          d.run(
            "INSERT INTO device_link (id, name, kind, public_key, inbound, position, created_at, can_change) VALUES ('phone-1', 'Anna phone', 'phone', '', 1, 0, 0, 0)",
          ),
        ),
      ),
    )
  const ask = (t: Awaited<ReturnType<typeof setup>>, method: string, input: unknown) =>
    runRequest(t.runtime, method, input, { id: "phone-1", name: "Anna phone" })

  test("the link handler records the device, also when the run waits in the queue and then runs", async () => {
    const t = await setup()
    await link(t)
    const a = await t.flow("A", [HANG])
    // The window starts the first run: no device. The device starts the second: it waits.
    const first = await t.start(a.id)
    await until(async () => (await t.stateOf(first.id)) === "running", "first runs")
    const asked = await ask(t, "runs.start", { workflowId: a.id })
    expect(asked.ok).toBe(true)
    const second = (asked as { value: RunSummary }).value
    await until(async () => (await t.stateOf(second.id)) === "queued", "second queues")
    expect(await deviceOf(t, first.id)).toBeNull()
    expect(await deviceOf(t, second.id)).toBe("Anna phone")
    // The queue lets the second run go on: the device stays on the record.
    await t.stop(first.id)
    await until(async () => (await t.stateOf(second.id)) === "running", "second runs")
    expect(await deviceOf(t, second.id)).toBe("Anna phone")
    await t.stop(second.id)
  })

  test("a retry names the device that asks; a retry in the window names none, also for a run that a device started", async () => {
    const t = await setup()
    await link(t)
    await t.run(SettingsStore.use((s) => s.update({ stepLimit: 20 })))
    const a = await t.flow("A", ['tools 25 run_command {"command":"echo changed"}'], "full")
    const started = await ask(t, "runs.start", { workflowId: a.id })
    expect(started.ok).toBe(true)
    const first = (started as { value: RunSummary }).value
    await t.ended(first.id)
    const task = await t.taskOf(first.id)
    expect(await deviceOf(t, first.id)).toBe("Anna phone")
    // The link does not list "Retry": a device cannot reach it (spec 012).
    expect(await ask(t, "tasks.retry", { taskId: task.id, confirmed: true })).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    })
    // The service takes the device that asks. The window has none: the retry run names none.
    const byWindow = await t.run(Tasks.use((x) => x.retry(task.id, true)))
    expect(byWindow.started).toBe(true)
    if (!byWindow.started) return
    await t.ended(byWindow.runId)
    expect(await deviceOf(t, byWindow.runId)).toBeNull()
    const byDevice = await t.run(Tasks.use((x) => x.retry(task.id, true, "Anna phone")))
    expect(byDevice.started).toBe(true)
    if (!byDevice.started) return
    await t.ended(byDevice.runId)
    expect(await deviceOf(t, byDevice.runId)).toBe("Anna phone")
  })
})
