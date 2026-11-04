import { afterAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import type { Agent, Channel, PermissionLevel, TeamsJobKind } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Providers } from "./Providers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import {
  calls,
  dispose,
  MARTA,
  PROVIDER_KEY,
  ROOM,
  type S,
  setup,
  startModel,
} from "./teamsHarness.testing.ts"

// The answers for a channel (spec 028, S104, with 004 and 005) with the stand-in Teams and a
// stand-in model. Nothing here calls the real Teams. The checks follow "Acceptance" of the spec.
//
// The stand-in model gives a plan for a job that begins with "PLAN ", and a set summary for the
// request of the lead to sum up the parts. Every other request follows the rules of the shared
// stand-in (`REPLY <text>`, `BREAK`, `FLAKY`, `SLOW`).

const plans = new Map<string, string>()
let summary = "Summary: all parts are done."
const model = startModel((text) => {
  if (text.startsWith("PLAN ")) return plans.get(text) ?? null
  if (text.includes("All parts have ended:")) return summary
  return null
})
afterAll(() => model.stop())

const plan = (...parts: { member: string; label: string; prompt: string }[]) =>
  JSON.stringify({ plan: "Two steps", parts })

/** A step that asks for approval at "Ask for risky steps". The user denies it: nothing runs. */
const risky = () => calls({ name: "run_command", args: { command: "sudo ls" } })

const WAITING = (name: string) => `[ROBot] ${name} waits for you in ROBot. Open the app to answer.`

// --- The set-up ------------------------------------------------------------------------------------

const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

/** A third agent, so that a channel has a lead and two members. */
const newAgent = async (s: S, name: string, permission: PermissionLevel = "ask_risky") => {
  const account = (await s.run(Providers.use((p) => p.list)))[0]
  const agent = await s.run(
    Agents.use((a) =>
      a.create({
        serverId: s.local.id,
        name,
        role: "",
        instructions: "Work.",
        model: { accountId: account?.id as string, model: "mock", effort: null },
      }),
    ),
  )
  await s.run(Agents.use((a) => a.update(agent.id, { permission })))
  mkdirSync(agent.workspace, { recursive: true })
  return agent
}

interface World {
  readonly s: S
  readonly cy: Agent
  readonly channel: Channel
}

/**
 * A running link whose target is the channel "Launch": the lead is Lia, and the members are Cy and
 * Ada. `lead: false` makes a channel with no lead.
 */
const start = async (options: { lead?: boolean; review?: boolean } = {}): Promise<World> => {
  summary = "Summary: all parts are done."
  plans.clear()
  const s = await setup(model)
  const cy = await newAgent(s, "Cy")
  const created = await s.run(
    Channels.use((c) =>
      c.create({
        serverId: s.local.id,
        name: "Launch",
        topic: "Ship it",
        memberIds: [s.lia.id, cy.id, s.ada.id],
        leadId: options.lead === false ? null : s.lia.id,
      }),
    ),
  )
  const channel = options.review
    ? await s.run(Channels.use((c) => c.update(created.id, { reviewParts: true })))
    : created
  await s.prepare({ targetKind: "channel", targetId: channel.id })
  await s.turnOn()
  return { s, cy, channel }
}

const history = (w: World) => w.s.run(Channels.use((c) => c.history(w.channel.id)))
const taskRows = (w: World) =>
  w.s.db.all<{
    id: string
    agent_id: string
    source: string
    source_id: string | null
    parent_id: string | null
    retry_of: string | null
    state: string
    teams_job: string | null
  }>(
    "SELECT id, agent_id, source, source_id, parent_id, retry_of, state, teams_job FROM task ORDER BY created_at, rowid",
  )

/** Moves time on until the work has ended and the outbox has sent what it holds. */
const finish = async (w: World, count: number, ms = 4000) => {
  await w.s.quiet(count)
  await w.s.pass(ms)
}

/**
 * A job in the channel that a message from Teams began and that ends now, with no model: the
 * messages of the task are written first, then the task runs and ends as `end` says. It goes
 * through the real service of tasks, so the link sees the end as it sees any other.
 */
const endJob = async (
  w: World,
  agent: Agent,
  kind: TeamsJobKind | null,
  messages: { kind?: "text" | "plan" | "summary"; text: string; files?: number }[],
  end: "done" | { fail: { code: string; detail?: string } } = "done",
  options: { parentId?: string; retryOf?: string } = {},
) => {
  const task = await w.s.run(
    Tasks.use((x) =>
      x.create({
        agentId: agent.id,
        prompt: "from teams",
        source: "channel",
        sourceId: w.channel.id,
        ...(options.parentId ? { parentId: options.parentId } : {}),
        ...(options.retryOf ? { retryOf: options.retryOf } : {}),
        ...(kind ? { teamsJob: kind } : {}),
      }),
    ),
  )
  for (const m of messages) {
    const parts = [
      { kind: "text", text: m.text },
      ...Array.from({ length: m.files ?? 0 }, (_, i) => ({
        kind: "file",
        name: `f${i}.png`,
        path: `attachments/f${i}.png`,
        size: 1,
      })),
    ]
    w.s.db.run(
      `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, task_id, created_at, finished_at)
       VALUES (?, ?, 'agent', ?, ?, ?, 'done', ?, ?, ?)`,
      randomUUID(),
      w.channel.id,
      agent.id,
      m.kind ?? "text",
      JSON.stringify(parts),
      task.id,
      w.s.clock.now(),
      w.s.clock.now(),
    )
  }
  await w.s.runtime.runPromiseExit(
    Tasks.use((x) =>
      x.run(
        task.id,
        agent.id,
        end === "done"
          ? Effect.void
          : Effect.fail({ code: end.fail.code, detail: end.fail.detail ?? "" }),
      ),
    ),
  )
  return task
}

// --- A lead answers ----------------------------------------------------------------------------------

describe("a channel with a lead", () => {
  test("a call with no mention goes to the lead; a lead that made no parts sends its reply text", async () => {
    const w = await start()
    w.s.chat.say(ROOM, MARTA, "@ROBot REPLY the launch is planned")
    await w.s.pass(3000)
    await finish(w, 1)
    expect(w.s.typedTexts()).toEqual(["[ROBot] the launch is planned"])
    expect(w.s.chat.typed[0]?.chat).toBe(ROOM)
    // The app does not read its own text as a call: more reads, one task, one answer.
    await w.s.pass(12_000)
    expect(await w.s.tasks()).toHaveLength(1)
    await dispose(w.s)
  })

  test("a lead that splits the job into two parts: Teams gets the summary only, not the plan", async () => {
    const w = await start()
    plans.set(
      "PLAN launch",
      plan(
        { member: "Cy", label: "Copy", prompt: "REPLY copy is ready" },
        { member: "Ada", label: "Art", prompt: "REPLY art is ready" },
      ),
    )
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN launch")
    await w.s.pass(3000)
    await finish(w, 3)
    // The channel shows the plan, two replies of the members, and one summary.
    const shown = await history(w)
    expect(shown.filter((m) => m.kind === "plan")).toHaveLength(1)
    expect(shown.filter((m) => m.kind === "summary")).toHaveLength(1)
    // Teams gets one message: the summary. Not the plan, and not the replies of the members.
    expect(w.s.typedTexts()).toEqual(["[ROBot] Summary: all parts are done."])
    expect(w.s.typedTexts().join("")).not.toContain("Two steps")
    expect(w.s.typedTexts().join("")).not.toContain("is ready")
    // The link log names the kind of the answer, with the channel as place, and no text.
    expect(w.s.reasons("answer_made")).toEqual(["summary"])
    expect(w.s.log().find((r) => r.event === "answer_made")?.place).toBe(`channel:${w.channel.id}`)
    await dispose(w.s)
  })

  test("the summary is redacted and split like any answer", async () => {
    const w = await start()
    plans.set("PLAN keys", plan({ member: "Cy", label: "Keys", prompt: "REPLY done" }))
    summary = `Summary: keys sk-abcdefghijklmnopqrstuvwxyz0123 and ${PROVIDER_KEY} end`
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN keys")
    await w.s.pass(3000)
    await finish(w, 2)
    expect(w.s.typedTexts()).toEqual(["[ROBot] Summary: keys [redacted] and [redacted] end"])
    expect(w.s.logText()).not.toContain(PROVIDER_KEY)
    await dispose(w.s)
  })

  test("a summary of 9,000 characters goes out as 3 messages, each with the marker, in order", async () => {
    const w = await start()
    plans.set("PLAN long", plan({ member: "Cy", label: "Long", prompt: "REPLY done" }))
    summary = "abcdefghi ".repeat(900)
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN long")
    await w.s.pass(3000)
    await finish(w, 2, 5000)
    const typed = w.s.typedTexts()
    expect(typed).toHaveLength(3)
    for (const text of typed) {
      expect(text.startsWith("[ROBot] ")).toBe(true)
      expect([...text].length).toBeLessThanOrEqual(4000)
    }
    expect(typed.map((x) => x.slice(8)).join(" ")).toBe(summary.trim())
    await dispose(w.s)
  })
})

// --- Members answer ------------------------------------------------------------------------------------

describe("the replies of the members that a mention chose", () => {
  test("a mention of one member: Teams gets the reply of that member, with the name and a colon", async () => {
    const w = await start()
    w.s.chat.say(ROOM, MARTA, "@ROBot REPLY the copy is ready @Cy")
    await w.s.pass(3000)
    await finish(w, 1)
    expect(w.s.typedTexts()).toEqual(["[ROBot] Cy: the copy is ready @Cy"])
    // The lead does not read it.
    expect((await history(w)).some((m) => m.agentId === w.s.lia.id)).toBe(false)
    expect(w.s.reasons("answer_made")).toEqual(["member_reply"])
    await dispose(w.s)
  })

  test("a mention of two members: both replies go, one answer each, each with its name", async () => {
    const w = await start()
    w.s.chat.say(ROOM, MARTA, "@ROBot REPLY ready @Cy @Ada")
    await w.s.pass(3000)
    await finish(w, 2)
    const typed = w.s.typedTexts()
    expect(typed).toHaveLength(2)
    expect([...typed].sort()).toEqual(["[ROBot] Ada: ready @Cy @Ada", "[ROBot] Cy: ready @Cy @Ada"])
    expect((await history(w)).some((m) => m.agentId === w.s.lia.id)).toBe(false)
    await dispose(w.s)
  })

  test("the answers go in the order in which the tasks ended", async () => {
    const w = await start()
    await endJob(w, w.s.ada, "mention", [{ text: "Ada is first." }])
    await endJob(w, w.cy, "mention", [{ text: "Cy is second." }])
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual(["[ROBot] Ada: Ada is first.", "[ROBot] Cy: Cy is second."])
    await dispose(w.s)
  })

  test("a member with no words sends the line for no reply text; files add one line", async () => {
    const w = await start()
    await endJob(w, w.cy, "mention", [{ text: "  " }])
    await endJob(w, w.s.ada, "mention", [{ text: "Here.", files: 2 }])
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual([
      "[ROBot] Done. There is no reply text.",
      "[ROBot] Ada: Here.",
      "[ROBot] The reply has 2 files or pictures. Open them in ROBot.",
    ])
    await dispose(w.s)
  })

  test("with no lead, the user picks a member and the reply of that member goes out", async () => {
    const w = await start({ lead: false })
    w.s.chat.say(ROOM, MARTA, "@ROBot REPLY picked up")
    await w.s.pass(3000)
    // The job waits: Teams gets the waiting line, and nothing else.
    const job = (await history(w))[0]
    expect(job).toMatchObject({ awaiting: true })
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual([WAITING("Launch")])
    // A long wait does not repeat the line.
    await w.s.pass(30_000)
    expect(w.s.typedTexts()).toHaveLength(1)
    await w.s.run(Channels.use((c) => c.assign(w.channel.id, job?.id as string, w.cy.id)))
    await finish(w, 1)
    expect(w.s.typedTexts()).toEqual([WAITING("Launch"), "[ROBot] Cy: picked up"])
    await dispose(w.s)
  })
})

// --- Lines for a job that failed, was stopped, or waits ---------------------------------------------------

describe("the lines for a job that failed or was stopped", () => {
  test("the lead fails: the line names the channel and the reason", async () => {
    const w = await start()
    w.s.chat.say(ROOM, MARTA, "@ROBot BREAK the lead")
    await w.s.pass(3000)
    await finish(w, 1)
    expect(w.s.typedTexts()).toHaveLength(1)
    expect(w.s.typedTexts()[0]).toMatch(/^\[ROBot\] Launch could not finish: .+/)
    await dispose(w.s)
  })

  test("a member that a mention chose fails: the line names the member", async () => {
    const w = await start()
    await endJob(w, w.cy, "mention", [], { fail: { code: "silent_limit", detail: "5" } })
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual(["[ROBot] Cy could not finish: No answer for 5 minutes."])
    await dispose(w.s)
  })

  test("the user ends the request: the line says that the channel was stopped; no summary goes", async () => {
    const w = await start()
    const release = model.hold()
    plans.set("PLAN slow", plan({ member: "Cy", label: "Slow", prompt: "SLOW REPLY late" }))
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN slow")
    await w.s.pass(3000)
    await until(() => taskRows(w).some((t) => t.parent_id !== null && t.state === "running"))
    const part = taskRows(w).find((t) => t.parent_id !== null)
    await w.s.run(Tasks.use((x) => x.endRequest(part?.id as string)))
    release()
    await w.s.quiet(2)
    await w.s.pass(4000)
    expect(w.s.typedTexts()).toEqual(["[ROBot] Launch was stopped."])
    await dispose(w.s)
  })

  test("the user stops a member that a mention chose: the line names the member", async () => {
    const w = await start()
    const release = model.hold()
    w.s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLY late @Cy")
    await w.s.pass(3000)
    await until(() => taskRows(w).some((t) => t.state === "running"))
    await w.s.run(Tasks.use((x) => x.stop(taskRows(w)[0]?.id as string)))
    release()
    await w.s.quiet(1)
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual(["[ROBot] Cy was stopped."])
    await dispose(w.s)
  })

  test("a task that the restart stopped gets no answer and no record", async () => {
    const w = await start()
    await endJob(w, w.cy, "mention", [], { fail: { code: "app_stopped" } })
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual([])
    expect(await w.s.records()).toEqual([])
    await dispose(w.s)
  })
})

describe("the waiting line for a failed part, a part in review and the request to pick", () => {
  test("a failed part: one waiting line with no text of the part; the summary goes after", async () => {
    const w = await start()
    plans.set(
      "PLAN broken",
      plan(
        { member: "Cy", label: "Copy", prompt: "BREAK secret-prompt-text" },
        { member: "Ada", label: "Art", prompt: "REPLY art is ready" },
      ),
    )
    summary = "Summary: one part failed."
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN broken")
    await w.s.pass(3000)
    await finish(w, 3, 6000)
    const typed = w.s.typedTexts()
    expect(typed).toHaveLength(2)
    expect(typed).toContain(WAITING("Launch"))
    expect(typed).toContain("[ROBot] Summary: one part failed.")
    expect(typed.join("")).not.toContain("secret-prompt-text")
    // The part does not answer for itself while its request is open: the lead sums it up.
    expect(typed.join("")).not.toContain("Cy could not finish")
    // The card waits a long time: no second line for it.
    await w.s.pass(30_000)
    expect(w.s.typedTexts()).toHaveLength(2)
    await dispose(w.s)
  })

  test("a part in review: one waiting line, no summary; after Accept the summary goes", async () => {
    const w = await start({ review: true })
    plans.set("PLAN review", plan({ member: "Cy", label: "Copy", prompt: "REPLY copy is ready" }))
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN review")
    await w.s.pass(3000)
    await until(() => taskRows(w).some((t) => t.state === "review"))
    await w.s.pass(4000)
    expect(w.s.typedTexts()).toEqual([WAITING("Launch")])
    await w.s.pass(30_000)
    expect(w.s.typedTexts()).toHaveLength(1)
    const part = taskRows(w).find((t) => t.state === "review")
    await w.s.run(Tasks.use((x) => x.accept(part?.id as string)))
    await finish(w, 2)
    expect(w.s.typedTexts()).toEqual([WAITING("Launch"), "[ROBot] Summary: all parts are done."])
    await dispose(w.s)
  })

  test("work that the user started in the app sends no waiting line", async () => {
    const w = await start({ lead: false, review: true })
    // No lead and no mention: the job from the app waits for a member. Teams gets nothing.
    await w.s.run(Channels.use((c) => c.send(w.channel.id, "Who takes this?")))
    // A part in review of a job from the app waits too.
    const root = await endJob(w, w.s.lia, null, [])
    await endJob(w, w.cy, null, [{ text: "x" }], "done", { parentId: root.id })
    w.s.db.run("UPDATE task SET state = 'review' WHERE parent_id = ?", root.id)
    await w.s.pass(10_000)
    expect(w.s.typedTexts()).toEqual([])
    await dispose(w.s)
  })

  test("a failed part or a part in review of a job that has ended gives no line (a restart stopped the lead)", async () => {
    const w = await start()
    const root = await endJob(w, w.s.lia, "lead", [], { fail: { code: "app_stopped" } })
    await endJob(
      w,
      w.cy,
      null,
      [],
      { fail: { code: "silent_limit", detail: "5" } },
      { parentId: root.id },
    )
    const review = await endJob(w, w.s.ada, null, [{ text: "x" }], "done", { parentId: root.id })
    w.s.db.run("UPDATE task SET state = 'review' WHERE id = ?", review.id)
    await w.s.pass(10_000)
    expect(w.s.typedTexts()).toEqual([])
    expect(await w.s.records()).toEqual([])
    await dispose(w.s)
  })

  test("an approval of a member in a job from Teams: one waiting line, no text of the step", async () => {
    const w = await start()
    w.s.chat.say(ROOM, MARTA, `@ROBot @Cy\n${risky()}`)
    await w.s.pass(3000)
    await until(() => taskRows(w).some((t) => t.state === "waiting"))
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual([WAITING("Launch")])
    expect(w.s.typedTexts().join("")).not.toContain("sudo")
    await w.s.pass(30_000)
    expect(w.s.typedTexts()).toHaveLength(1)
    // The user answers in the app: the turn goes on and the reply goes out.
    await w.s.run(Tools.use((x) => x.respond(w.cy.id, "call_1", "deny")))
    await finish(w, 1)
    expect(w.s.typedTexts()).toEqual([WAITING("Launch"), "[ROBot] Cy: Done."])
    await dispose(w.s)
  })

  test("an approval of a member in a job that the user started in the app sends no line", async () => {
    const w = await start()
    await w.s.run(Channels.use((c) => c.send(w.channel.id, `@Cy\n${risky()}`)))
    await until(() => w.s.db.get("SELECT 1 AS x FROM task WHERE state = 'waiting'") !== undefined)
    await w.s.pass(10_000)
    expect(w.s.typedTexts()).toEqual([])
    await dispose(w.s)
  })
})

// --- The source of a retry --------------------------------------------------------------------------------

describe("a retry keeps the source", () => {
  test("the lead fails and the user retries: the new task is a job from Teams, and its reply goes out", async () => {
    const w = await start()
    w.s.chat.say(ROOM, MARTA, "@ROBot FLAKY REPLY all good now")
    await w.s.pass(3000)
    await until(() => taskRows(w).some((t) => t.state === "failed"))
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toHaveLength(1)
    expect(w.s.typedTexts()[0]).toMatch(/^\[ROBot\] Launch could not finish: .+/)
    const failed = taskRows(w).find((t) => t.state === "failed")
    await w.s.run(Tasks.use((x) => x.retry(failed?.id as string, { confirmed: true })))
    await finish(w, 2)
    const retried = taskRows(w).find((t) => t.retry_of === failed?.id)
    expect(retried).toMatchObject({ source: "channel", teams_job: "lead", state: "done" })
    expect(w.s.typedTexts().at(-1)).toBe("[ROBot] all good now")
    await dispose(w.s)
  })

  test("a member that a mention chose fails and the user retries: the reply goes out with the name", async () => {
    const w = await start()
    w.s.chat.say(ROOM, MARTA, "@ROBot FLAKY REPLY fixed @Cy")
    await w.s.pass(3000)
    await until(() => taskRows(w).some((t) => t.state === "failed"))
    await w.s.pass(3000)
    expect(w.s.typedTexts()[0]).toMatch(/^\[ROBot\] Cy could not finish: .+/)
    const failed = taskRows(w).find((t) => t.state === "failed")
    await w.s.run(Tasks.use((x) => x.retry(failed?.id as string, { confirmed: true })))
    await finish(w, 2)
    expect(taskRows(w).find((t) => t.retry_of === failed?.id)).toMatchObject({
      teams_job: "mention",
      state: "done",
    })
    expect(w.s.typedTexts().at(-1)).toBe("[ROBot] Cy: fixed @Cy")
    await dispose(w.s)
  })

  test("a part fails, the lead sums up, the user retries the part: the part answers for itself", async () => {
    const w = await start()
    plans.set("PLAN late", plan({ member: "Cy", label: "Copy", prompt: "FLAKY REPLY copy fixed" }))
    summary = "Summary: one part failed."
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN late")
    await w.s.pass(3000)
    await finish(w, 2, 6000)
    expect(w.s.typedTexts()).toHaveLength(2)
    expect(w.s.typedTexts()).toContain("[ROBot] Summary: one part failed.")
    const failed = taskRows(w).find((t) => t.state === "failed")
    expect(failed?.parent_id).not.toBeNull()
    await w.s.run(Tasks.use((x) => x.retry(failed?.id as string, { confirmed: true })))
    await w.s.quiet(3)
    await w.s.pass(4000)
    const retried = taskRows(w).find((t) => t.retry_of === failed?.id)
    expect(retried).toMatchObject({
      source: "channel",
      parent_id: failed?.parent_id,
      teams_job: "lead",
      state: "done",
    })
    expect(w.s.typedTexts().at(-1)).toBe("[ROBot] Cy: copy fixed")
    expect(w.s.typedTexts()).toHaveLength(3)
    await dispose(w.s)
  })

  test("the parts, the retries and the nudges of a job keep its kind; a task with no job has none", async () => {
    const w = await start()
    const root = await endJob(w, w.s.lia, "lead", [])
    const part = await endJob(w, w.cy, null, [], "done", { parentId: root.id })
    const again = await endJob(w, w.cy, null, [], "done", { parentId: root.id, retryOf: part.id })
    const row = (id: string) =>
      w.s.db.get<{ teams_job: string | null }>("SELECT teams_job FROM task WHERE id = ?", id)
    expect(row(root.id)?.teams_job).toBe("lead")
    expect(row(part.id)?.teams_job).toBe("lead")
    expect(row(again.id)?.teams_job).toBe("lead")
    const other = await endJob(w, w.cy, null, [])
    const otherRetry = await endJob(w, w.cy, null, [], "done", { retryOf: other.id })
    expect(row(other.id)?.teams_job).toBeNull()
    expect(row(otherRetry.id)?.teams_job).toBeNull()
    await dispose(w.s)
  })
})

// --- Only work that a Teams message started sends text -----------------------------------------------------

describe("only work that a message from Teams started sends text", () => {
  test("a job that the user posts in the app is answered in the app only", async () => {
    const w = await start()
    await w.s.run(Channels.use((c) => c.send(w.channel.id, "REPLY from the app")))
    await finish(w, 1)
    await w.s.run(Channels.use((c) => c.send(w.channel.id, "REPLY a member answers @Cy")))
    await finish(w, 2)
    expect(w.s.typedTexts()).toEqual([])
    // A job from Teams in the same channel sends text, and only its own.
    w.s.chat.say(ROOM, MARTA, "@ROBot REPLY from Teams")
    await w.s.pass(3000)
    await finish(w, 3)
    expect(w.s.typedTexts()).toEqual(["[ROBot] from Teams"])
    await dispose(w.s)
  })

  test("a job in another channel than the target sends no text", async () => {
    const w = await start()
    const other = await w.s.run(
      Channels.use((c) =>
        c.create({
          serverId: w.s.local.id,
          name: "Other",
          topic: "",
          memberIds: [w.s.lia.id, w.cy.id],
          leadId: w.s.lia.id,
        }),
      ),
    )
    const there = { ...w, channel: other }
    await endJob(there, w.s.lia, "lead", [{ text: "Not for this chat." }])
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual([])
    await dispose(w.s)
  })
})

// --- When the link cannot take an answer ------------------------------------------------------------------

describe("when the link is off or signed out", () => {
  test("turning the switch off while a job runs: the job ends in the app, Teams gets no text, a record shows", async () => {
    const w = await start()
    const release = model.hold()
    w.s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLY late")
    await w.s.pass(3000)
    await until(() => taskRows(w).some((t) => t.state === "running"))
    await w.s.turnOff()
    release()
    await w.s.quiet(1)
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual([])
    const records = await w.s.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      reason: "linkOff",
      placeKind: "channel",
      placeId: w.channel.id,
      placeName: "Launch",
    })
    expect(records[0]?.taskId).toBe(taskRows(w)[0]?.id as string)
    await dispose(w.s)
  })

  test("a job from Teams that ends while the Teams page shows sends its answer after the page hides", async () => {
    const w = await start()
    await w.s.showPage()
    await endJob(w, w.cy, "mention", [{ text: "Waits for the page." }])
    await w.s.pass(5000)
    expect(w.s.typedTexts()).toEqual([])
    await w.s.hidePage()
    await w.s.pass(5000)
    expect(w.s.typedTexts()).toEqual(["[ROBot] Cy: Waits for the page."])
    await dispose(w.s)
  })

  test("the target channel is deleted or archived agent: nothing is read and nothing goes", async () => {
    const w = await start()
    await w.s.run(Channels.use((c) => c.remove(w.channel.id)))
    await w.s.pass(5000)
    expect(w.s.typedTexts()).toEqual([])
    await dispose(w.s)
  })
})

// --- The language of the app and the link log --------------------------------------------------------------

describe("the language of the app", () => {
  test("the lines for a channel are in Korean when the app is in Korean; the reply text is not changed", async () => {
    const w = await start({ lead: false })
    await w.s.run(SettingsStore.use((x) => x.update({ language: "ko" })))
    w.s.chat.say(ROOM, MARTA, "@ROBot REPLY 안녕하세요")
    await w.s.pass(3000)
    const job = (await history(w))[0]
    await w.s.pass(3000)
    await w.s.run(Channels.use((c) => c.assign(w.channel.id, job?.id as string, w.cy.id)))
    await finish(w, 1)
    await endJob(w, w.s.ada, "mention", [], { fail: { code: "silent_limit", detail: "5" } })
    await w.s.pass(3000)
    expect(w.s.typedTexts()).toEqual([
      "[ROBot] Launch이(가) ROBot에서 기다리고 있어요. 앱을 열어 답해 주세요.",
      "[ROBot] Cy: 안녕하세요",
      "[ROBot] Ada이(가) 끝내지 못했어요: 5분 동안 답이 없어요.",
    ])
    await dispose(w.s)
  })
})

describe("the records and the link log hold no text and no name", () => {
  test("a search of the log finds no reply, no member reply, no sender name and no channel text", async () => {
    const w = await start()
    plans.set("PLAN quiet", plan({ member: "Cy", label: "Quiet", prompt: "REPLY hidden words" }))
    summary = "Summary: private summary words"
    w.s.chat.say(ROOM, MARTA, "@ROBot PLAN quiet")
    await w.s.pass(3000)
    await finish(w, 2)
    w.s.chat.say(ROOM, MARTA, "@ROBot REPLY other private reply @Cy")
    await w.s.pass(3000)
    await finish(w, 3)
    expect(w.s.typedTexts()).toHaveLength(2)
    const log = w.s.logText()
    for (const word of [
      "private summary",
      "private reply",
      "hidden words",
      "Marta",
      "Kim",
      "PLAN quiet",
    ])
      expect(log).not.toContain(word)
    await dispose(w.s)
  })
})
