import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { endOfTurn, type Task } from "@robot/shared"
import { Deferred, Effect, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Database } from "./Database.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testPlatform, testRuntime } from "./testing.ts"

// Blocked and review (spec 004, 005): how a turn ends a task, and the decisions on a part in review.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: local.id, name, role: "", instructions: "", model: null }),
      ),
    )
  const make = (
    agentId: string,
    prompt: string,
    extra: { parentId?: string | null; source?: Task["source"]; sourceId?: string } = {},
  ) =>
    run(
      Tasks.use((x) =>
        x.create({
          agentId,
          prompt,
          source: extra.source ?? "chat",
          sourceId: extra.sourceId ?? agentId,
          parentId: extra.parentId ?? null,
        }),
      ),
    )
  const get = async (id: string) => (await run(Tasks.use((x) => x.get(id)))).task
  /** Runs a task whose turn ends with this reply text. */
  const finish = (task: Task, text: string, review = false) =>
    run(
      Tasks.use((x) =>
        x.run(task.id, task.agentId, Effect.succeed(text), {
          finish: (reply) => endOfTurn(reply, { review }),
        }),
      ),
    )
  return { ...t, run, local, agent, make, get, finish }
}

describe("Blocked (spec 005)", () => {
  test("a turn with no error whose last line starts with Blocked: ends the task as Blocked", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    const ended: Task[] = []
    await s.run(Tasks.use((x) => Effect.sync(() => x.onEnd((t) => ended.push(t)))))
    await s.finish(task, "I looked.\nblocked: no access to the folder")
    const done = await s.get(task.id)
    expect(done.state).toBe("blocked")
    expect(done.error).toEqual({ code: "blocked", detail: "no access to the folder" })
    expect(done.finishedAt).not.toBeNull()
    // Blocked is final: the end listeners (routines) get it.
    expect(ended.map((t) => t.state)).toEqual(["blocked"])
  })

  test("a reply with no such line ends as Done", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    await s.finish(task, "All done.\nNothing is blocked.")
    expect((await s.get(task.id)).state).toBe("done")
  })

  test("a turn with an error is Failed, and a stopped turn is Cancelled", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const failing = await s.make(ada.id, "failing")
    await s
      .run(
        Tasks.use((x) =>
          x.run(failing.id, ada.id, Effect.fail({ code: "boom", detail: "why" }), {
            finish: () => ({ state: "blocked", reason: "never read" }),
          }),
        ),
      )
      .catch(() => {})
    const failed = await s.get(failing.id)
    expect(failed.state).toBe("failed")
    expect(failed.error).toEqual({ code: "boom", detail: "why" })

    const stopping = await s.make(ada.id, "stopping")
    const running = s.run(
      Tasks.use((x) =>
        x.run(stopping.id, ada.id, Effect.never, {
          finish: () => ({ state: "blocked", reason: "never read" }),
        }),
      ),
    )
    await sleep(20)
    await s.run(Tasks.use((x) => x.stop(stopping.id)))
    await running.catch(() => {})
    expect((await s.get(stopping.id)).state).toBe("cancelled")
  })

  test("a blocked task is a failed task for the notice, with its reason", async () => {
    const s = await setup()
    s.shell.focused = false
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "Fix the build")
    await s.finish(task, "Blocked: the key is missing")
    expect(s.shell.notices.map((n) => n.title)).toEqual(["Ada"])
    expect(s.shell.notices[0]?.body).toBe("Fix the build")
    // The reason reaches the island card as an error of its own.
    expect((await s.get(task.id)).error?.detail).toBe("the key is missing")
  })

  test("a line with no reason keeps an error code of its own, so the text is never empty", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    await s.finish(task, "Blocked:")
    expect((await s.get(task.id)).error).toEqual({ code: "blocked_empty", detail: "" })
  })

  test("retry works for a blocked task as for a failed one", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    const retried: string[] = []
    await s.run(
      Tasks.use((x) =>
        Effect.sync(() =>
          x.onRetry("chat", (t) =>
            Effect.sync(() => {
              retried.push(t.id)
            }),
          ),
        ),
      ),
    )
    await s.finish(task, "Blocked: no key")
    const result = await s.run(Tasks.use((x) => x.retry(task.id)))
    expect(result).toEqual({ started: true })
    expect(retried).toEqual([task.id])
  })
})

describe("Review (spec 004, 005)", () => {
  test("a part that ends well waits in review: not final, and it does not hold the place of its agent", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const lead = await s.agent("Lead")
    const parent = await s.make(lead.id, "job")
    const part = await s.make(ada.id, "part", { parentId: parent.id })
    await s.finish(part, "Here is the result.", true)
    expect((await s.get(part.id)).state).toBe("review")
    expect((await s.get(part.id)).finishedAt).toBeNull()
    // The agent runs another task at once.
    const other = await s.make(ada.id, "other")
    await Promise.race([s.finish(other, "ok"), sleep(1000).then(() => Promise.reject("held"))])
    expect((await s.get(other.id)).state).toBe("done")
    expect((await s.get(part.id)).state).toBe("review")
  })

  test("accept ends it as Done", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const part = await s.make(ada.id, "part")
    await s.finish(part, "result", true)
    await s.run(Tasks.use((x) => x.accept(part.id)))
    const done = await s.get(part.id)
    expect(done.state).toBe("done")
    expect(done.finishedAt).not.toBeNull()
    // A second accept fails: the task is not in review any more.
    const again = await s.run(Tasks.use((x) => x.accept(part.id)).pipe(Effect.flip))
    expect(again.code).toBe("task_not_in_review")
  })

  test("only a task in review can be accepted", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const queued = await s.make(ada.id, "q")
    const refused = await s.run(Tasks.use((x) => x.accept(queued.id)).pipe(Effect.flip))
    expect(refused.code).toBe("task_not_in_review")
    expect((await s.get(queued.id)).state).toBe("queued")
    const missing = await s.run(Tasks.use((x) => x.accept("nope")).pipe(Effect.flip))
    expect(missing.code).toBe("task_not_found")
  })

  test("request changes ends the task as Done and starts a new part with the text", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const part = await s.make(ada.id, "part")
    const started: { old: string; text: string }[] = []
    await s.run(
      Tasks.use((x) =>
        Effect.sync(() =>
          x.onChanges("chat", (old, text) =>
            Effect.sync(() => {
              started.push({ old: old.id, text })
            }),
          ),
        ),
      ),
    )
    await s.finish(part, "result", true)
    await s.run(Tasks.use((x) => x.requestChanges(part.id, "  Add a title  ")))
    expect(started).toEqual([{ old: part.id, text: "Add a title" }])
    expect((await s.get(part.id)).state).toBe("done")
  })

  test("the text of a change request has 1 to 2000 characters; a bad text changes nothing", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const part = await s.make(ada.id, "part")
    const started: string[] = []
    await s.run(
      Tasks.use((x) =>
        Effect.sync(() =>
          x.onChanges("chat", (_old, text) =>
            Effect.sync(() => {
              started.push(text)
            }),
          ),
        ),
      ),
    )
    await s.finish(part, "result", true)
    for (const text of ["", "   ", "x".repeat(2001)]) {
      const refused = await s.run(
        Tasks.use((x) => x.requestChanges(part.id, text)).pipe(Effect.flip),
      )
      expect(refused.code).toBe("invalid_input")
    }
    expect(started).toEqual([])
    expect((await s.get(part.id)).state).toBe("review")
    await s.run(Tasks.use((x) => x.requestChanges(part.id, "x".repeat(2000))))
    expect(started).toHaveLength(1)
  })

  test("Stop does not change a task in review", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const part = await s.make(ada.id, "part")
    await s.finish(part, "result", true)
    await s.run(Tasks.use((x) => x.stop(part.id)))
    expect((await s.get(part.id)).state).toBe("review")
  })

  test("a task in review stays in review after a restart, with no time limit", async () => {
    const { platform, dataDir } = testPlatform()
    const file = join(dataDir, "robot.db")
    const open = () =>
      ManagedRuntime.make(
        appLayer({
          platform,
          databaseFile: file,
          localServerName: "T",
          emit: () => {},
          secrets: Secrets.memory,
        }),
      )
    const first = open()
    const local = await first.runPromise(Servers.use((s) => s.local))
    const ada = await first.runPromise(
      Agents.use((a) =>
        a.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const lead = await first.runPromise(
      Agents.use((a) =>
        a.create({ serverId: local.id, name: "Lead", role: "", instructions: "", model: null }),
      ),
    )
    const parent = await first.runPromise(
      Tasks.use((x) =>
        x.create({ agentId: lead.id, prompt: "job", source: "chat", sourceId: lead.id }),
      ),
    )
    const part = await first.runPromise(
      Tasks.use((x) =>
        x.create({
          agentId: ada.id,
          prompt: "part",
          source: "chat",
          sourceId: ada.id,
          parentId: parent.id,
        }),
      ),
    )
    await first.runPromise(
      Tasks.use((x) =>
        x.run(part.id, ada.id, Effect.succeed("result"), {
          finish: (r) => endOfTurn(r, { review: true }),
        }),
      ),
    )
    // Long ago: the state has no time limit.
    await first.runPromise(
      Database.use((db) =>
        Effect.sync(() =>
          db.run("UPDATE task SET created_at = 1, started_at = 1 WHERE id = ?", part.id),
        ),
      ),
    )
    await first.dispose()

    const second = open()
    const states = await second.runPromise(
      Effect.all([Tasks.use((x) => x.get(parent.id)), Tasks.use((x) => x.get(part.id))]),
    )
    // The work that was running is failed with the restart reason. The part waits on.
    expect(states[0].task.state).toBe("failed")
    expect(states[0].task.error?.code).toBe("app_stopped")
    expect(states[1].task.state).toBe("review")
    expect(states[1].task.error).toBeNull()
    // The user can still decide.
    await second.runPromise(Tasks.use((x) => x.accept(part.id)))
    expect((await second.runPromise(Tasks.use((x) => x.get(part.id)))).task.state).toBe("done")
    await second.dispose()
  })

  test("a part of the other computer is decided there", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const part = await s.make(ada.id, "part")
    await s.finish(part, "result", true)
    await s.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.run("UPDATE task SET origin = 'other-computer' WHERE id = ?", part.id),
        ),
      ),
    )
    const refused = await s.run(Tasks.use((x) => x.accept(part.id)).pipe(Effect.flip))
    expect(refused.code).toBe("task_elsewhere")
    const changes = await s.run(Tasks.use((x) => x.requestChanges(part.id, "x")).pipe(Effect.flip))
    expect(changes.code).toBe("task_elsewhere")
    const ending = await s.run(Tasks.use((x) => x.endRequest(part.id)).pipe(Effect.flip))
    expect(ending.code).toBe("task_elsewhere")
    expect((await s.get(part.id)).state).toBe("review")
  })

  test("a part in review makes one notification of the kind part in review", async () => {
    const s = await setup()
    s.shell.focused = false
    const ada = await s.agent("Ada")
    const lead = await s.agent("Lead")
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Team",
          topic: "",
          memberIds: [ada.id, lead.id],
          leadId: lead.id,
        }),
      ),
    )
    const parent = await s.make(lead.id, "job", { source: "channel", sourceId: channel.id })
    const part = await s.make(ada.id, "Write the intro", {
      source: "channel",
      sourceId: channel.id,
      parentId: parent.id,
    })
    await s.finish(part, "result", true)
    expect(s.shell.notices.map((n) => `${n.title} | ${n.body}`)).toEqual([
      "Ada · Team | Write the intro",
    ])
    // Accepting makes no new notice.
    await s.run(Tasks.use((x) => x.accept(part.id)))
    expect(s.shell.notices).toHaveLength(1)
  })

  test("the kind has the same off switch and mutes as the other kinds", async () => {
    const s = await setup()
    s.shell.focused = false
    const ada = await s.agent("Ada")
    const lead = await s.agent("Lead")
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Team",
          topic: "",
          memberIds: [ada.id, lead.id],
          leadId: lead.id,
        }),
      ),
    )
    const review = async (label: string) => {
      const parent = await s.make(lead.id, "job", { source: "channel", sourceId: channel.id })
      const part = await s.make(ada.id, label, {
        source: "channel",
        sourceId: channel.id,
        parentId: parent.id,
      })
      await s.finish(part, "result", true)
    }
    const { SettingsStore } = await import("./Settings.ts")
    const { Notifier } = await import("./Notifier.ts")
    // The kind is off: no notification.
    await s.run(
      SettingsStore.use((st) => st.update({ notifyKinds: { ...defaults(), part_review: false } })),
    )
    await review("one")
    expect(s.shell.notices).toHaveLength(0)
    // The kind is on, and the channel is muted: no notification.
    await s.run(SettingsStore.use((st) => st.update({ notifyKinds: defaults() })))
    await s.run(Notifier.use((n) => n.setMute("channel", channel.id, "1h")))
    await review("two")
    expect(s.shell.notices).toHaveLength(0)
    await s.run(Notifier.use((n) => n.setMute("channel", channel.id, "off")))
    await review("three")
    expect(s.shell.notices).toHaveLength(1)
  })
})

const defaults = () => ({
  reply: true,
  mention: true,
  approval: true,
  question: true,
  task_failed: true,
  routine_failed: true,
  part_review: true,
  workflow_notice: true,
})

describe("End the request (spec 004, 005)", () => {
  test("it cancels every task of the request that is not final, also one in review", async () => {
    const s = await setup()
    const lead = await s.agent("Lead")
    const a = await s.agent("A")
    const b = await s.agent("B")
    const c = await s.agent("C")
    const d = await s.agent("D")
    const parent = await s.make(lead.id, "job")
    const finished = await s.make(a.id, "finished", { parentId: parent.id })
    const failed = await s.make(b.id, "failed", { parentId: parent.id })
    const reviewed = await s.make(c.id, "reviewed", { parentId: parent.id })
    const running = await s.make(d.id, "running", { parentId: parent.id })
    // The lead waits for the parts, as in a channel.
    const gate = Deferred.makeUnsafe<void>()
    const leadRun = s.run(Tasks.use((x) => x.run(parent.id, lead.id, Deferred.await(gate))))
    await s.finish(finished, "ok")
    await s
      .run(Tasks.use((x) => x.run(failed.id, b.id, Effect.fail({ code: "boom", detail: "" }))))
      .catch(() => {})
    await s.finish(reviewed, "ok", true)
    const runningRun = s.run(Tasks.use((x) => x.run(running.id, d.id, Effect.never)))
    await sleep(30)

    // Ending from the part in review finds the first task of the request.
    await s.run(Tasks.use((x) => x.endRequest(reviewed.id)))
    await Promise.allSettled([leadRun, runningRun])
    const states = Object.fromEntries(
      await Promise.all(
        [parent, finished, failed, reviewed, running].map(
          async (t) => [t.prompt, await s.get(t.id)] as const,
        ),
      ),
    )
    expect(states.job?.state).toBe("cancelled")
    expect(states.reviewed?.state).toBe("cancelled")
    expect(states.running?.state).toBe("cancelled")
    // A task that is done keeps its result. A task that failed is final and stays as it is.
    expect(states.finished?.state).toBe("done")
    expect(states.failed?.state).toBe("failed")
    expect(states.failed?.error?.code).toBe("boom")
    // The cancelled tasks carry no error.
    expect(states.reviewed?.error).toBeNull()
    expect(states.job?.error).toBeNull()
  })

  test("a request whose lead is gone still ends: the part in review is cancelled", async () => {
    const s = await setup()
    const lead = await s.agent("Lead")
    const a = await s.agent("A")
    const parent = await s.make(lead.id, "job")
    const part = await s.make(a.id, "part", { parentId: parent.id })
    await s.finish(part, "ok", true)
    await s.run(Tasks.use((x) => x.endRequest(parent.id)))
    expect((await s.get(part.id)).state).toBe("cancelled")
    expect((await s.get(parent.id)).state).toBe("cancelled")
  })
})
