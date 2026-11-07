import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  GO_ON_MESSAGE,
  HOLD_MAX_MS,
  HOLD_UNKNOWN_MS,
  type NodeHold,
  type RunDetail,
  type WorkflowNode,
} from "@robot/shared"
import { Effect } from "effect"
import { makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import { GOOD_KEY, type MockProvider, startMockProvider } from "../../../e2e/mock-provider.ts"
import { busyClock } from "../providers/busyRetry.ts"
import { ProviderFailure } from "../providers/client.ts"
import { handlers, runRequest } from "../rpc.ts"
import { CurrentActor } from "./actor.ts"
import { isBackupChoice, limitSwitch, modelUsageOf } from "./backupRun.ts"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { holdClock, ModelHolds } from "./ModelHolds.ts"
import { Providers } from "./Providers.ts"
import { Runs, runClock } from "./Runs.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

// The backup model of a text node (spec 006, "Backup model"). The services, the tables and the engine
// are the real ones. The only stand-ins are the two model providers: the main one can be made to fail
// with a spent limit, the backup one answers.

const PLAN = "Plan limit reached for this account."
const real = holdClock.now
const mocks: MockProvider[] = []
runClock.retryWaitMs = 10
runClock.minuteMs = 60
afterAll(async () => {
  for (const m of mocks) await m.close()
})
afterEach(() => {
  holdClock.now = real
})

const until = async (ok: () => boolean | Promise<boolean>, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error("timeout")
}

const setup = async (options: { databaseFile?: string; prompt?: string } = {}) => {
  const main = await startMockProvider()
  const backup = await startMockProvider()
  mocks.push(main, backup)
  const t = testRuntime({
    check: { auto: false },
    ...(options.databaseFile ? { databaseFile: options.databaseFile } : {}),
  })
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const connect = (name: string, url: string) =>
    run(Providers.use((p) => p.connect({ kind: "openai", name, baseUrl: url, apiKey: GOOD_KEY })))
  const mainAccount = await connect("Main", main.openaiUrl)
  const backupAccount = await connect("Backup", backup.openaiUrl)
  const flow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Report" })))
  await run(Workflows.use((w) => w.setSelfImprovement(flow.id, false)))
  await run(Memory.use((m) => m.setEnabled(flow.id, false)))
  const node = await run(
    Workflows.use((w) =>
      w.addNode(flow.id, {
        kind: "text",
        name: "Draft",
        prompt: options.prompt ?? "write it",
        accountId: mainAccount.id,
        model: "mock-fast",
      }),
    ),
  )
  const pick = { accountId: backupAccount.id, model: "gpt-5", effort: null }
  /** The main choice of the node. */
  const mainPick = { accountId: mainAccount.id, model: "mock-fast", effort: null }
  /** The editor of this computer sets the backup (the same path as the window). */
  const setBackup = (id: string, value: typeof pick | null = pick) =>
    runRequest(t.runtime, "workflows.node.update", { id, patch: { backup: value } })
  const start = () => run(Runs.use((r) => r.start({ workflowId: flow.id })))
  const get = (id: string) => run(Runs.use((r) => r.get(id)))
  const ended = async (id: string): Promise<RunDetail> => {
    await until(async () => (await get(id)).finishedAt !== null)
    return get(id)
  }
  const go = async () => ended((await start()).id)
  const holds = (): Promise<readonly NodeHold[]> =>
    runRequest(t.runtime, "workflows.holds", { workflowId: flow.id }).then((r) =>
      r.ok ? (r.value as readonly NodeHold[]) : [],
    )
  const rows = <T>(statement: string, ...params: (string | number | null)[]) =>
    run(Database.use((d) => Effect.sync(() => d.all<T>(statement, ...params))))
  return {
    ...t,
    run,
    main,
    backup,
    mainAccount,
    backupAccount,
    flow,
    node,
    pick,
    mainPick,
    setBackup,
    go,
    start,
    ended,
    get,
    holds,
    rows,
    server,
  }
}

const task = (d: RunDetail) => d.nodes[0]?.task

describe("the choice of the backup model (spec 006, 010)", () => {
  test("the editor saves a backup, and the node holds it; it starts as none", async () => {
    const t = await setup()
    expect(t.node.backup).toBeNull()
    expect(await t.setBackup(t.node.id)).toMatchObject({ ok: true })
    const g = await t.run(Workflows.use((w) => w.graph(t.flow.id)))
    expect(g.nodes[0]?.backup).toEqual(t.pick)
    // The earlier graph is kept as a version, and a version from before the field reads as none.
    const versions = await t.run(Workflows.use((w) => w.versions(t.flow.id)))
    expect(versions[0]?.graph.nodes[0]?.backup).toBeNull()
    await t.setBackup(t.node.id, null)
    expect((await t.run(Workflows.use((w) => w.graph(t.flow.id)))).nodes[0]?.backup).toBeNull()
  })

  test("the same account, model and reasoning level as the main choice is refused, with the reason", async () => {
    const t = await setup()
    const same = { accountId: t.mainAccount.id, model: "mock-fast", effort: null }
    expect(await t.setBackup(t.node.id, same)).toMatchObject({
      ok: false,
      error: { code: "backup_same" },
    })
    // Another model of the same account is a different choice.
    expect(
      await t.setBackup(t.node.id, { accountId: t.mainAccount.id, model: "gpt-5", effort: null }),
    ).toMatchObject({ ok: true })
  })

  test("a change of the main choice to the backup is refused too", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    const r = await runRequest(t.runtime, "workflows.node.update", {
      id: t.node.id,
      patch: { accountId: t.backupAccount.id, model: "gpt-5" },
    })
    expect(r).toMatchObject({ ok: false, error: { code: "backup_same" } })
  })

  test("a backup needs a main choice, an account of this computer and a model of its real list", async () => {
    const t = await setup()
    const bare = await t.run(
      Workflows.use((w) => w.addNode(t.flow.id, { kind: "text", name: "Bare", prompt: "x" })),
    )
    expect(await t.setBackup(bare.id)).toMatchObject({
      ok: false,
      error: { code: "backup_no_main" },
    })
    expect(
      await t.setBackup(t.node.id, { accountId: "nobody", model: "gpt-5", effort: null }),
    ).toMatchObject({ ok: false, error: { code: "backup_not_offered" } })
    expect(
      await t.setBackup(t.node.id, { accountId: t.backupAccount.id, model: "nope", effort: null }),
    ).toMatchObject({ ok: false, error: { code: "backup_not_offered" } })
  })

  test("a decision node has no backup model", async () => {
    const t = await setup()
    const decision = await t.run(
      Workflows.use((w) =>
        w.addNode(t.flow.id, {
          kind: "decision",
          name: "Pick",
          question: "Which?",
          options: ["a", "b"],
        }),
      ),
    )
    expect(await t.setBackup(decision.id)).toMatchObject({
      ok: false,
      error: { code: "decision_backup" },
    })
    // A hold row that names the decision node counts for nothing: it has no backup.
    const holds = await t.run(ModelHolds.use((h) => Effect.succeed(h)))
    holds.start(decision.id, t.mainPick, t.pick, Date.now() + 60_000)
    expect(holds.active(decision.id, t.mainPick, null)).toBeNull()
    expect(await t.holds()).toEqual([])
  })

  test("a linked device cannot set a backup, and its restore of a version leaves the backups as they are", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    const phone = { id: "phone-1", name: "Anna's phone" }
    const asDevice = <A, E>(effect: Effect.Effect<A, E, never>) =>
      t.runtime.runPromiseExit(Effect.provideService(effect as never, CurrentActor, phone))
    // The handler refuses, whatever the switch of the device says.
    const exit = await asDevice(
      handlers["workflows.node.update"]({
        id: t.node.id,
        patch: { backup: null },
      }) as Effect.Effect<never, never, never>,
    )
    expect(exit._tag).toBe("Failure")
    expect((await t.run(Workflows.use((w) => w.graph(t.flow.id)))).nodes[0]?.backup).toEqual(t.pick)
    // The link lists no method for the hold: a device gets "Not allowed" before any handler runs.
    expect(
      await runRequest(t.runtime, "workflows.holds", { workflowId: t.flow.id }, phone),
    ).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    })
    // Restoring the version from before the backup, as a device, keeps the backup of the node.
    const versions = await t.run(Workflows.use((w) => w.versions(t.flow.id)))
    const before = versions.find((v) => v.graph.nodes[0]?.backup === null)
    expect(before).toBeDefined()
    await t.run(
      Workflows.use((w) => w.restoreVersion(t.flow.id, before?.id ?? "", { keepBackups: true })),
    )
    expect((await t.run(Workflows.use((w) => w.graph(t.flow.id)))).nodes[0]?.backup).toEqual(t.pick)
    // The user at this computer restores it as it was: no backup.
    await t.run(Workflows.use((w) => w.restoreVersion(t.flow.id, before?.id ?? "")))
    expect((await t.run(Workflows.use((w) => w.graph(t.flow.id)))).nodes[0]?.backup).toBeNull()
  })
})

describe("a limit of the main model moves the turn to the backup (spec 006)", () => {
  test("a spent plan limit before any step: the backup runs the turn from the start, with one line, and the node shows the hold", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 7200 })
    const before = Date.now()
    const d = await t.go()
    expect(d.state).toBe("done")
    expect(task(d)?.result).toContain("You said: write it")
    // The main model was asked once, the backup once, with the request from its start.
    expect(t.main.requests).toHaveLength(1)
    expect(t.backup.requests).toHaveLength(1)
    expect(JSON.stringify(t.backup.requests[0]?.body.messages)).not.toContain(GO_ON_MESSAGE)
    // The line names both models and the reset time.
    const note = task(d)?.backupNote
    expect(note).toMatchObject({ main: "mock-fast", backup: "gpt-5" })
    expect(note?.resetsAt).toBeGreaterThan(before + 7_100_000)
    // The node shows the hold and its end.
    const holds = await t.holds()
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({ nodeId: t.node.id, main: "mock-fast", backup: t.pick })
    expect(holds[0]?.until).toBeGreaterThan(before + 7_100_000)
    // The next task goes to the backup at once: the main model is not asked again, and no line.
    const second = await t.go()
    expect(second.state).toBe("done")
    expect(t.main.requests).toHaveLength(1)
    expect(t.backup.requests).toHaveLength(2)
    expect(task(second)?.backupNote).toBeNull()
  })

  test("a limit after 2 tool steps: the backup gets a short message that asks it to go on, not the first request again; one task, one end", async () => {
    const t = await setup({ prompt: 'tools 2 list_files {"path":"."}' })
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 }, 2)
    const run = await t.start()
    const d = await t.ended(run.id)
    expect(d.state).toBe("done")
    // The main model ran 2 steps and failed on its third request; the backup was asked once.
    expect(t.main.requests).toHaveLength(3)
    expect(t.backup.requests).toHaveLength(1)
    const messages = t.backup.requests[0]?.body.messages ?? []
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(2)
    expect(JSON.stringify(messages.at(-1))).toContain(GO_ON_MESSAGE.slice(0, 40))
    // The first request is in the history once: it is not sent again as a request of its own.
    expect(
      messages.filter((m) => JSON.stringify(m.content).includes("tools 2 list_files")),
    ).toHaveLength(1)
    // One task for the node, and it ended once.
    const tasks = await t.rows<{ id: string; state: string }>("SELECT id, state FROM task")
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.state).toBe("done")
    expect(task(d)?.backupNote?.backup).toBe("gpt-5")
    // The tokens count for the model that made them.
    const usage = await t.run(
      Database.use((db) => Effect.sync(() => modelUsageOf(db, tasks[0]?.id ?? ""))),
    )
    expect(usage).toHaveLength(2)
    const byAccount = new Map(usage.map((u) => [u.accountId, u]))
    expect(byAccount.get(t.mainAccount.id)?.input).toBeGreaterThan(
      byAccount.get(t.backupAccount.id)?.input ?? 0,
    )
    expect((byAccount.get(t.backupAccount.id)?.input ?? 0) > 0).toBe(true)
    // The sum of the rows is the usage of the task.
    expect(task(d)?.usage.input).toBe(usage.reduce((sum, u) => sum + (u.input ?? 0), 0))
  })

  test("Use the main model now: the next task goes to the main model; a limit again starts the hold again and shows no second line", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    expect(task(await t.go())?.backupNote).not.toBeNull()
    expect(await t.holds()).toHaveLength(1)
    const released = await runRequest(t.runtime, "workflows.hold.release", { nodeId: t.node.id })
    expect(released).toMatchObject({ ok: true })
    expect(await t.holds()).toEqual([])
    const mainBefore = t.main.requests.length
    const d = await t.go()
    expect(d.state).toBe("done")
    // The main model was tried, failed with the limit again, and the backup went on: no second line.
    expect(t.main.requests.length - mainBefore).toBe(1)
    expect(task(d)?.backupNote).toBeNull()
    expect(await t.holds()).toHaveLength(1)
  })

  test("after Use the main model now, a main model that answers ends the episode: the next limit shows its line again", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    await t.go()
    await runRequest(t.runtime, "workflows.hold.release", { nodeId: t.node.id })
    t.main.setFailure(null)
    const answered = await t.go()
    expect(answered.state).toBe("done")
    expect(task(answered)?.result).toContain("You said: write it")
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    expect(task(await t.go())?.backupNote).not.toBeNull()
  })

  test("a key that is not valid does not move the turn: no switch, the task fails with that reason", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 401, message: "Invalid API key." })
    const d = await t.go()
    expect(d.state).toBe("failed")
    expect(task(d)?.reasonCode).toBe("provider_auth")
    expect(t.backup.requests).toHaveLength(0)
    expect(await t.holds()).toEqual([])
  })

  test("a request that the provider refuses, and a model that does not exist, do not move the turn", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    for (const failure of [
      { status: 400, message: "This request is not valid." },
      { status: 404, message: "The model `mock-fast` does not exist." },
    ]) {
      t.main.setFailure(failure)
      const d = await t.go()
      expect(d.state).toBe("failed")
      expect(t.backup.requests).toHaveLength(0)
    }
    expect(await t.holds()).toEqual([])
  })

  test("a busy provider is tried again three times and then fails with its reason: no backup (the spec names a limit reason only)", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    const busy = { status: 503, message: "The model is overloaded." }
    t.main.setFailure(busy)
    // The waits are short here: 2, 4 and 8 seconds would pass the silent limit of this test.
    const waits = [...busyClock.waitsMs]
    busyClock.waitsMs = [5, 5, 5]
    const d = await t.go().finally(() => {
      busyClock.waitsMs = waits
    })
    expect(t.main.requests).toHaveLength(4)
    expect(d.state).toBe("failed")
    expect(task(d)?.reasonCode).toBe("provider_busy")
    expect(t.backup.requests).toHaveLength(0)
    expect(await t.holds()).toEqual([])
  })

  test("both models fail with a limit: the turn fails with the reason of the backup model", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    t.backup.setFailure({ status: 402, message: "Your credit balance is too low to go on." })
    const d = await t.go()
    expect(d.state).toBe("failed")
    expect(task(d)?.reasonCode).toBe("provider_limit")
    expect(task(d)?.reasonText).toContain("credit balance")
    expect(t.main.requests).toHaveLength(1)
    expect(t.backup.requests).toHaveLength(1)
  })

  test("a backup that is not ready does not take the turn: the turn fails with the limit reason and no hold starts", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    await t.run(Providers.use((p) => p.disconnect(t.backupAccount.id)))
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    const d = await t.go()
    expect(d.state).toBe("failed")
    expect(task(d)?.reasonCode).toBe("provider_limit")
    expect(t.backup.requests).toHaveLength(0)
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
  })

  test("a synced backup that names an account this computer lacks is not ready: the turn fails with the limit reason", async () => {
    const t = await setup()
    // The choice arrives with the workflow from another computer: it names an account that is not here.
    await t.rows("SELECT 1")
    await t.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.run(
            "UPDATE workflow_node SET backup_account_id = 'other-computer', backup_model = 'gpt-5' WHERE id = ?",
            t.node.id,
          ),
        ),
      ),
    )
    t.main.setFailure({ status: 429, message: PLAN })
    const d = await t.go()
    expect(d.state).toBe("failed")
    expect(task(d)?.reasonCode).toBe("provider_limit")
    expect(await t.holds()).toEqual([])
  })

  test("the backup becomes not ready during a hold: the hold ends at once and the next task tries the main model", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    await t.go()
    expect(await t.holds()).toHaveLength(1)
    await t.run(Providers.use((p) => p.disconnect(t.backupAccount.id)))
    // The editor and the run view see no hold any more.
    expect(await t.holds()).toEqual([])
    const mainBefore = t.main.requests.length
    const d = await t.go()
    expect(t.main.requests.length - mainBefore).toBe(1)
    expect(d.state).toBe("failed")
    expect(task(d)?.reasonCode).toBe("provider_limit")
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
  })

  test("a node with no backup fails with the limit reason as before", async () => {
    const t = await setup()
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    const d = await t.go()
    expect(d.state).toBe("failed")
    expect(task(d)?.reasonCode).toBe("provider_limit")
    expect(task(d)?.backupNote).toBeNull()
  })

  test("another node of the same workflow keeps its own main model while the first is held", async () => {
    const t = await setup()
    const other = await t.run(
      Workflows.use((w) =>
        w.addNode(t.flow.id, {
          kind: "text",
          name: "Edit",
          prompt: "edit {{input}}",
          accountId: t.mainAccount.id,
          model: "mock-fast",
        }),
      ),
    )
    await t.run(Workflows.use((w) => w.connect(t.flow.id, t.node.id, other.id, null)))
    await t.setBackup(t.node.id)
    // Node 1 is held; the stand-in answers node 2 again (it is on the same account as node 1's main).
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    const first = await t.go()
    expect(first.nodes[0]?.task?.backupNote).not.toBeNull()
    expect(first.nodes[1]?.state).toBe("failed")
    // Node 2 has no backup of its own and uses its main model, which is still at its limit.
    expect(first.nodes[1]?.task?.reasonCode).toBe("provider_limit")
    expect(first.nodes[1]?.task?.backupNote).toBeNull()
    expect(await t.holds()).toHaveLength(1)
    expect((await t.holds())[0]?.nodeId).toBe(t.node.id)
  })
})

describe("a vendor program reports a limit in its own form (spec 006)", () => {
  const withCodex = async (
    run: (t: Awaited<ReturnType<typeof setup>>, nodeId: string) => Promise<void>,
    prompt: string,
  ) => {
    const fake = makeFakeRuntimes()
    const saved = process.env.ROBOT_CODEX_BIN
    process.env.ROBOT_CODEX_BIN = fake.codex
    try {
      fake.setCodex({ loggedIn: true, method: "chatgpt" })
      const t = await setup()
      const codex = await t.run(Providers.use((p) => p.connect({ kind: "codex", name: "Codex" })))
      const node = await t.run(
        Workflows.use((w) =>
          w.addNode(t.flow.id, {
            kind: "text",
            name: "Program",
            prompt,
            accountId: codex.id,
            model: "default",
          }),
        ),
      )
      // The first node of the setup is on the stand-in API account: it has no part in this test.
      await t.run(Workflows.use((w) => w.removeNode(t.node.id)))
      await run(t, node.id)
    } finally {
      if (saved === undefined) delete process.env.ROBOT_CODEX_BIN
      else process.env.ROBOT_CODEX_BIN = saved
    }
  }

  test("a spent plan limit in the form of the program: the turn goes to the backup", async () => {
    await withCodex(async (t, nodeId) => {
      expect(await t.setBackup(nodeId)).toMatchObject({ ok: true })
      const d = await t.go()
      expect(d.state).toBe("done")
      expect(t.backup.requests).toHaveLength(1)
      expect(task(d)?.backupNote).toMatchObject({ main: "default", backup: "gpt-5" })
      expect(await t.holds()).toHaveLength(1)
    }, "FAIL do the work")
  })

  test("a report that the app cannot read is no limit: the turn fails and the backup is not asked", async () => {
    await withCodex(async (t, nodeId) => {
      expect(await t.setBackup(nodeId)).toMatchObject({ ok: true })
      const d = await t.go()
      expect(d.state).toBe("failed")
      expect(task(d)?.reasonCode).toBe("provider_error")
      expect(t.backup.requests).toHaveLength(0)
      expect(await t.holds()).toEqual([])
    }, "UNREADABLE do the work")
  })
})

describe("the hold ends at its time (spec 006)", () => {
  test("with a fake clock past the reset time, the next task goes to the main model", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    const base = Date.now()
    holdClock.now = () => base
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 7200 })
    await t.go()
    expect(await t.holds()).toHaveLength(1)
    // One hour on: still held.
    holdClock.now = () => base + 3_600_000
    const mainBefore = t.main.requests.length
    await t.go()
    expect(t.main.requests.length).toBe(mainBefore)
    // Past the reset time, and the main model answers again.
    holdClock.now = () => base + 7_200_000 + 1000
    t.main.setFailure(null)
    expect(await t.holds()).toEqual([])
    const d = await t.go()
    expect(d.state).toBe("done")
    expect(t.main.requests.length - mainBefore).toBe(1)
    expect(task(d)?.backupNote).toBeNull()
  })

  test("a limit that names no reset time holds for 15 minutes", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    const base = Date.now()
    holdClock.now = () => base
    t.main.setFailure({ status: 429, message: PLAN })
    await t.go()
    expect((await t.holds())[0]?.until).toBe(base + HOLD_UNKNOWN_MS)
    holdClock.now = () => base + HOLD_UNKNOWN_MS - 60_000
    const mainBefore = t.main.requests.length
    await t.go()
    expect(t.main.requests.length).toBe(mainBefore)
    holdClock.now = () => base + HOLD_UNKNOWN_MS + 60_000
    t.main.setFailure(null)
    await t.go()
    expect(t.main.requests.length - mainBefore).toBe(1)
  })

  test("the hold stays after the app is closed and opened again", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-hold-")), "robot.db")
    const t = await setup({ databaseFile: file })
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    await t.go()
    const [hold] = await t.holds()
    expect(hold).toBeDefined()
    await t.runtime.dispose()
    const again = testRuntime({ databaseFile: file, check: { auto: false } })
    const stored = await again.runtime.runPromise(
      ModelHolds.use((h) => Effect.sync(() => h.stored(t.node.id))),
    )
    expect(stored?.until).toBe(hold?.until ?? 0)
    expect(stored?.released).toBe(false)
    expect(stored?.backup).toEqual(t.pick)
    expect(stored?.main).toEqual(t.mainPick)
    // A valid hold still counts after the restart, and the node shows it.
    const kept = await again.runtime.runPromise(
      ModelHolds.use((h) => Effect.sync(() => h.active(t.node.id, t.mainPick, t.pick))),
    )
    expect(kept?.until).toBe(hold?.until ?? 0)
    await again.runtime.dispose()
  })

  test("a hold does not pass to another backup, and it is gone when the node is removed", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    await t.go()
    expect(await t.holds()).toHaveLength(1)
    await t.setBackup(t.node.id, {
      accountId: t.backupAccount.id,
      model: "mock-fast",
      effort: null,
    })
    expect(await t.holds()).toEqual([])
    const holds = await t.run(ModelHolds.use((h) => Effect.succeed(h)))
    expect(
      holds.active(t.node.id, t.mainPick, {
        accountId: t.backupAccount.id,
        model: "mock-fast",
        effort: null,
      }),
    ).toBeNull()
    // The hold is dropped, not only ignored.
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
  })

  test("a graph change of the whole graph keeps the hold of a node that stays", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    await t.go()
    const graph = await t.run(Workflows.use((w) => w.graph(t.flow.id)))
    await t.run(Workflows.use((w) => w.applyGraph(t.flow.id, graph, "proposal")))
    expect(await t.holds()).toHaveLength(1)
  })
})

describe("no proposal and no tool of the chat sets or changes a backup (spec 006; docs/spec-questions.md, B6)", () => {
  const withBackup = (node: WorkflowNode, pick: WorkflowNode["backup"]): WorkflowNode => ({
    ...node,
    backup: pick,
  })

  test("a change of the whole graph that sets, moves or clears a backup is refused, whatever built it", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    const graph = await t.run(Workflows.use((w) => w.graph(t.flow.id)))
    const node = graph.nodes[0] as WorkflowNode
    const edit = (backup: WorkflowNode["backup"]) =>
      t.runtime.runPromiseExit(
        Workflows.use((w) =>
          w.applyGraph(t.flow.id, { ...graph, nodes: [withBackup(node, backup)] }, "chat"),
        ),
      )
    for (const backup of [
      null,
      { accountId: t.mainAccount.id, model: "gpt-5", effort: null },
      { ...t.pick, effort: "high" },
    ]) {
      const exit = await edit(backup)
      expect(exit._tag).toBe("Failure")
    }
    expect((await t.run(Workflows.use((w) => w.graph(t.flow.id)))).nodes[0]?.backup).toEqual(t.pick)
    // A new node with a backup is refused too.
    const fresh = { ...node, id: "new-node", number: 2, backup: t.pick }
    const exit = await t.runtime.runPromiseExit(
      Workflows.use((w) => w.applyGraph(t.flow.id, { ...graph, nodes: [node, fresh] }, "proposal")),
    )
    expect(exit._tag).toBe("Failure")
    // The graph as it is applies.
    await t.run(Workflows.use((w) => w.applyGraph(t.flow.id, graph, "proposal")))
  })
})

describe("a hold has a longest time, and a bad row never stops the app (spec 006; docs/spec-questions.md, B6)", () => {
  test("a reset time that is far away holds for 24 hours at most, and the node still shows it", async () => {
    // 1e14 s is 1e17 ms. 9e12 s is 9e15 ms: past the range of a date. 86401 s is one second over.
    for (const retryAfter of [100_000_000_000_000, 9_000_000_000_000, 86_401 * 365]) {
      const t = await setup()
      await t.setBackup(t.node.id)
      t.main.setFailure({ status: 429, message: PLAN, retryAfter })
      const before = Date.now()
      const d = await t.go()
      expect(d.state).toBe("done")
      const [hold] = await t.holds()
      expect(hold).toBeDefined()
      expect(hold?.until).toBeLessThanOrEqual(Date.now() + HOLD_MAX_MS)
      expect(hold?.until).toBeGreaterThan(before + HOLD_MAX_MS - 60_000)
      // The line of the task view names a time that a date can hold.
      const at = task(d)?.backupNote?.resetsAt
      expect(at).toBe(hold?.until)
      expect(Number.isNaN(new Date(at ?? 0).getTime())).toBe(false)
      const [row] = await t.rows<{ ends_at: number }>("SELECT ends_at FROM model_hold")
      expect(row?.ends_at).toBe(hold?.until ?? 0)
      await t.runtime.dispose()
    }
  })

  test("a limit that names no usable time holds for 15 minutes", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    // A header that is not a number is ignored: the hold has the default time.
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: -5 })
    const before = Date.now()
    const d = await t.go()
    expect(task(d)?.backupNote?.resetsAt).toBeNull()
    const [hold] = await t.holds()
    expect(hold?.until).toBeGreaterThanOrEqual(before + HOLD_UNKNOWN_MS)
    expect(hold?.until).toBeLessThan(before + HOLD_UNKNOWN_MS + 60_000)
  })

  test("rows of the store with a time that no hold can have are dropped and logged; the app starts and the good hold stays", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "robot-hold-bad-")), "robot.db")
    const t = await setup({ databaseFile: file })
    await t.setBackup(t.node.id)
    const others = []
    for (const name of ["Huge", "Negative", "Text", "Edge"])
      others.push(
        await t.run(
          Workflows.use((w) =>
            w.addNode(t.flow.id, {
              kind: "text",
              name,
              prompt: "x",
              accountId: t.mainAccount.id,
              model: "mock-fast",
            }),
          ),
        ),
      )
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    await t.go()
    const good = await t.holds()
    expect(good.map((h) => h.nodeId)).toEqual([t.node.id])
    await t.runtime.dispose()
    // Write the bad rows into the file while no app has it open.
    const raw = new DatabaseSync(file)
    const insert = (id: string | undefined, endsAt: string) =>
      raw.exec(
        `INSERT OR REPLACE INTO model_hold (node_id, ends_at, released, main_account_id, main_model,
           backup_account_id, backup_model)
         VALUES ('${id}', ${endsAt}, 0, 'a', 'm', 'b', 'n')`,
      )
    insert(others[0]?.id, "100000000000000000")
    insert(others[1]?.id, "-5")
    insert(others[2]?.id, "'soon'")
    insert(others[3]?.id, `${Date.now() + HOLD_MAX_MS * 2}`)
    raw.close()
    const again = testRuntime({ databaseFile: file, check: { auto: false } })
    // The app starts: the layer of the holds is built, and the good hold is read.
    const stored = await again.runtime.runPromise(
      ModelHolds.use((h) => Effect.sync(() => h.stored(t.node.id))),
    )
    expect(stored?.until).toBe(good[0]?.until ?? 0)
    const left = await again.runtime.runPromise(
      Database.use((d) =>
        Effect.sync(() => d.all<{ node_id: string }>("SELECT node_id FROM model_hold")),
      ),
    )
    expect(left.map((r) => r.node_id)).toEqual([t.node.id])
    const log = join(again.dataDir, "logs", "workflows.log")
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log, "utf8").match(/hold_dropped/g)).toHaveLength(4)
    await again.runtime.dispose()
  })

  test("a table that cannot be read does not stop the app either", async () => {
    // Nothing can be read as a number past 2^53, so the test of the row must not read it.
    const file = join(mkdtempSync(join(tmpdir(), "robot-hold-huge-")), "robot.db")
    const t = await setup({ databaseFile: file })
    await t.runtime.dispose()
    const raw = new DatabaseSync(file)
    raw.exec(
      `INSERT INTO model_hold (node_id, ends_at, released, main_account_id, main_model,
         backup_account_id, backup_model)
       VALUES ('gone', 9223372036854775807, 0, 'a', 'm', 'b', 'n')`,
    )
    raw.close()
    const again = testRuntime({ databaseFile: file, check: { auto: false } })
    const rows = await again.runtime.runPromise(
      Database.use((d) => Effect.sync(() => d.all("SELECT node_id FROM model_hold"))),
    )
    expect(rows).toEqual([])
    await again.runtime.dispose()
  })
})

describe('the hold is of the main choice and the backup that it began with (spec 006: "it holds the main model")', () => {
  const limited = async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    t.main.setFailure({ status: 429, message: PLAN, retryAfter: 3600 })
    await t.go()
    expect(await t.holds()).toHaveLength(1)
    return t
  }

  test("another main model on the node: the next task tries it, the hold is dropped and the button is gone", async () => {
    const t = await limited()
    t.main.setFailure(null)
    const r = await runRequest(t.runtime, "workflows.node.update", {
      id: t.node.id,
      patch: { model: "mock-smart" },
    })
    expect(r).toMatchObject({ ok: true })
    // The editor and the run view show no hold, and the row is gone.
    expect(await t.holds()).toEqual([])
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
    const backupBefore = t.backup.requests.length
    const mainBefore = t.main.requests.length
    const d = await t.go()
    expect(d.state).toBe("done")
    expect(t.main.requests.length - mainBefore).toBe(1)
    expect(t.backup.requests.length).toBe(backupBefore)
  })

  test("another main model: the engine ignores and drops a hold that nobody listed", async () => {
    const t = await limited()
    t.main.setFailure(null)
    // The node changes under the engine without a call that lists the holds first.
    await t.run(
      Database.use((d) =>
        Effect.sync(() =>
          d.run("UPDATE workflow_node SET effort = 'high' WHERE id = ?", t.node.id),
        ),
      ),
    )
    const mainBefore = t.main.requests.length
    await t.go()
    expect(t.main.requests.length - mainBefore).toBe(1)
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
  })

  test("a changed backup drops the hold, also when the same backup is chosen again later", async () => {
    const t = await limited()
    await t.setBackup(t.node.id, {
      accountId: t.backupAccount.id,
      model: "mock-fast",
      effort: null,
    })
    expect(await t.holds()).toEqual([])
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
    await t.setBackup(t.node.id)
    expect(await t.holds()).toEqual([])
  })

  test("the button names the model that reached its limit, and a valid hold is kept for the same choice", async () => {
    const t = await limited()
    const [hold] = await t.holds()
    expect(hold?.main).toBe("mock-fast")
    // An edit of a field that is not a model choice leaves the hold.
    await runRequest(t.runtime, "workflows.node.update", {
      id: t.node.id,
      patch: { prompt: "write it again" },
    })
    expect(await t.holds()).toHaveLength(1)
  })

  test("a main choice that came back is a new episode: a hold of the old main choice is not used", async () => {
    const t = await limited()
    // The hold is of mock-fast. Another model is asked and answers; the hold is gone for good.
    await runRequest(t.runtime, "workflows.node.update", {
      id: t.node.id,
      patch: { model: "mock-smart" },
    })
    await t.holds()
    await runRequest(t.runtime, "workflows.node.update", {
      id: t.node.id,
      patch: { model: "mock-fast" },
    })
    expect(await t.holds()).toEqual([])
  })

  test("the holds of a workflow leave with the workflow", async () => {
    const t = await limited()
    await t.run(Workflows.use((w) => w.remove(t.flow.id)))
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
  })

  test("the holds of a node leave with the node", async () => {
    const t = await limited()
    await t.run(Workflows.use((w) => w.removeNode(t.node.id)))
    expect(await t.rows("SELECT node_id FROM model_hold")).toEqual([])
  })
})

describe("small points of the backup engine", () => {
  const node = (over: Partial<WorkflowNode> = {}): WorkflowNode =>
    ({
      id: "n1",
      number: 1,
      kind: "text",
      name: "n",
      prompt: "",
      accountId: "a",
      model: "m",
      effort: null,
      backup: { accountId: "a", model: "m", effort: "high" },
      ...over,
    }) as WorkflowNode

  test("a backup that differs from the main choice only by its level is a backup", () => {
    const n = node()
    expect(isBackupChoice({ accountId: "a", model: "m", effort: "high" }, n)).toBe(true)
    expect(isBackupChoice({ accountId: "a", model: "m", effort: null }, n)).toBe(false)
    expect(isBackupChoice({ accountId: "b", model: "m", effort: null }, n)).toBe(true)
  })

  test("a task that ended while the backup was checked starts no hold and leaves no line", async () => {
    const started: unknown[] = []
    const controller = new AbortController()
    const deps = {
      holds: { start: (...args: unknown[]) => started.push(args) } as never,
      // The check of the backup takes time. The task is stopped meanwhile.
      ready: async () => {
        controller.abort()
        return true
      },
    }
    const limit = new ProviderFailure("provider_limit", PLAN, undefined, "plan")
    expect(await limitSwitch(deps, node(), limit, false, controller.signal)).toBeNull()
    expect(started).toEqual([])
    // The same call with a task that goes on starts the hold.
    const live = {
      holds: {
        start: (...args: unknown[]) => {
          started.push(args)
          return { fresh: true }
        },
      } as never,
      ready: async () => true,
    }
    expect(
      await limitSwitch(live, node(), limit, false, new AbortController().signal),
    ).toMatchObject({
      fresh: true,
    })
    expect(started).toHaveLength(1)
  })
})

describe("a linked device restores a version without changing a backup (rpc wiring)", () => {
  test("the actor of a linked device keeps the backups, and the user of this computer does not", async () => {
    const t = await setup()
    await t.setBackup(t.node.id)
    const versions = await t.run(Workflows.use((w) => w.versions(t.flow.id)))
    const before = versions.find((v) => v.graph.nodes[0]?.backup === null)
    expect(before).toBeDefined()
    const phone = { id: "phone-2", name: "Anna's phone" }
    // The handler itself, with the actor of a linked device (the list of the link is another test).
    const exit = await t.runtime.runPromiseExit(
      Effect.provideService(
        handlers["workflows.versions.restore"]({
          id: t.flow.id,
          versionId: before?.id ?? "",
        }) as Effect.Effect<unknown, never, never>,
        CurrentActor,
        phone,
      ),
    )
    expect(exit._tag).toBe("Success")
    // The backup of this computer stayed.
    expect((await t.run(Workflows.use((w) => w.graph(t.flow.id)))).nodes[0]?.backup).toEqual(t.pick)
    const own = await runRequest(t.runtime, "workflows.versions.restore", {
      id: t.flow.id,
      versionId: before?.id ?? "",
    })
    expect(own).toMatchObject({ ok: true })
    expect((await t.run(Workflows.use((w) => w.graph(t.flow.id)))).nodes[0]?.backup).toBeNull()
  })
})
