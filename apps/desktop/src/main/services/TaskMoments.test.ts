import { afterAll, describe, expect, test } from "bun:test"
import { RECENT_WORK_MAX, taskMoments } from "@robot/shared"
import { Deferred, Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { AppError } from "./errors.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// The work record (spec 002 "Recent work", spec 005 "Moments"): when the turn of a task ended and
// how, what the user decided on a part, the lead that gave a part, and the last tasks of an agent.

const sse = (text: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const send = (data: unknown) =>
          controller.enqueue(
            enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`),
          )
        send({ choices: [{ delta: { content: text } }] })
        send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })
        send("[DONE]")
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const last = (body.messages.at(-1)?.content ?? "").split("\n").at(-1) ?? ""
    if (last.includes("split two"))
      return sse(
        JSON.stringify({
          plan: "Split in parts",
          parts: [
            { member: "Bo", label: "Intro", prompt: "Write the intro" },
            { member: "Cy", label: "Facts", prompt: "Check the facts" },
          ],
        }),
      )
    if (last.includes("All parts have ended")) return sse("Summary done.")
    return sse(`Echo: ${last}`)
  },
})
afterAll(() => server.stop())

const until = async (check: () => Promise<boolean> | boolean, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string, model?: { accountId: string }) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: `You are ${name}.`,
          model: model ? { accountId: model.accountId, model: "mock", effort: null } : null,
        }),
      ),
    )
  const make = (
    agentId: string,
    prompt: string,
    source: "chat" | "channel" = "chat",
    id?: string,
  ) =>
    run(
      Tasks.use((x) =>
        x.create({ agentId, prompt, source, sourceId: id ?? agentId, parentId: null }),
      ),
    )
  const get = async (id: string) => (await run(Tasks.use((x) => x.get(id)))).task
  const recent = (agentId: string) => run(Tasks.use((x) => Effect.sync(() => x.recent(agentId))))
  return { run, local, agent, make, get, recent }
}

describe("the end of the turn of a task", () => {
  test("a task that finishes has the moment and the way it ended, between its start and its close", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    await s.run(Tasks.use((x) => x.run(task.id, ada.id, Effect.sleep(5))))
    const done = await s.get(task.id)
    expect(done.state).toBe("done")
    expect(done.endedAs).toBe("done")
    expect(done.startedAt).not.toBeNull()
    expect(done.endedAt).not.toBeNull()
    expect(done.startedAt ?? 0).toBeLessThanOrEqual(done.endedAt ?? 0)
    expect(done.endedAt ?? 0).toBeLessThanOrEqual(done.finishedAt ?? 0)
    expect(taskMoments(done, null).map((m) => m.id)).toEqual([
      "given",
      "started",
      "ended",
      "closed",
    ])
  })

  test("a failed task and a cancelled task say how they ended; a queued task that is stopped never ended", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const failing = await s.make(ada.id, "failing")
    await s
      .run(
        Tasks.use((x) =>
          x.run(failing.id, ada.id, Effect.fail(new AppError({ code: "boom", detail: "why" }))),
        ),
      )
      .catch(() => {})
    expect((await s.get(failing.id)).endedAs).toBe("failed")

    const running = await s.make(ada.id, "running")
    const queued = await s.make(ada.id, "queued")
    const one = s.run(Tasks.use((x) => x.run(running.id, ada.id, Effect.never)))
    await until(async () => (await s.get(running.id)).state === "running")
    const two = s.run(Tasks.use((x) => x.run(queued.id, ada.id, Effect.void)))
    await until(async () => (await s.get(queued.id)).state === "queued")
    await s.run(Tasks.use((x) => x.stop(queued.id)))
    await s.run(Tasks.use((x) => x.stop(running.id)))
    await Promise.allSettled([one, two])
    const stoppedRunning = await s.get(running.id)
    expect(stoppedRunning.state).toBe("cancelled")
    expect(stoppedRunning.endedAs).toBe("cancelled")
    const stoppedQueued = await s.get(queued.id)
    expect(stoppedQueued.state).toBe("cancelled")
    // It never started, so it has no turn and no such moment; it was given and closed.
    expect(stoppedQueued.endedAt).toBeNull()
    expect(taskMoments(stoppedQueued, null).map((m) => m.id)).toEqual(["given", "closed"])
  })

  test("the first end of the turn is kept: a later change of the state does not move it", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    await s.run(
      Tasks.use((x) =>
        x.run(task.id, ada.id, Effect.sleep(5), { finish: () => ({ state: "review" }) }),
      ),
    )
    const review = await s.get(task.id)
    expect(review.state).toBe("review")
    expect(review.endedAs).toBe("review")
    expect(review.finishedAt).toBeNull()
    expect(taskMoments(review, null).map((m) => m.id)).toEqual(["given", "started", "ended"])
  })
})

describe("the parts of a request and the decisions of the user", () => {
  const withChannel = async () => {
    const s = await setup()
    const account = await s.run(
      Providers.use((p) =>
        p.connect({
          kind: "custom",
          name: "M",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "sk-moments-test-key",
        }),
      ),
    )
    const [lead, bo, cy] = await Promise.all([
      s.agent("Lia", { accountId: account.id }),
      s.agent("Bo", { accountId: account.id }),
      s.agent("Cy", { accountId: account.id }),
    ])
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Launch",
          topic: "Ship it",
          memberIds: [lead.id, bo.id, cy.id],
          leadId: lead.id,
        }),
      ),
    )
    await s.run(Channels.use((c) => c.update(channel.id, { reviewParts: true })))
    const parts = async () =>
      (await s.run(Tasks.use((x) => x.list(s.local.id)))).filter((t) => t.parentId !== null)
    return { ...s, lead, bo, cy, channel, parts }
  }

  test("a part names the lead that gave it; accepting and asking for changes are kept with their text", async () => {
    const s = await withChannel()
    await s.run(Channels.use((c) => c.send(s.channel.id, "split two things")))
    await until(async () => (await s.parts()).filter((t) => t.state === "review").length === 2)
    const parts = await s.parts()
    const first = parts.find((t) => t.label === "Intro")
    const second = parts.find((t) => t.label === "Facts")
    const detail = await s.run(Tasks.use((x) => x.get(first?.id ?? "")))
    expect(detail.leadName).toBe("Lia")
    // A task that is not a part has no lead.
    const plain = await s.make(s.bo.id, "p")
    expect((await s.run(Tasks.use((x) => x.get(plain.id)))).leadName).toBeNull()

    const waiting = await s.get(first?.id ?? "")
    expect(waiting.endedAs).toBe("review")
    expect(waiting.decision).toBeNull()
    expect(taskMoments(waiting, "Lia").map((m) => m.id)).toEqual(["given", "started", "ended"])

    await s.run(Tasks.use((x) => x.accept(first?.id ?? "")))
    const accepted = await s.get(first?.id ?? "")
    expect(accepted.state).toBe("done")
    expect(accepted.decision).toBe("accepted")
    expect(accepted.decisionText).toBeNull()
    expect(accepted.decidedAt).not.toBeNull()
    // The turn ended in review: that moment stays.
    expect(accepted.endedAs).toBe("review")
    expect(taskMoments(accepted, "Lia").map((m) => m.id)).toEqual([
      "given",
      "started",
      "ended",
      "decided",
      "closed",
    ])

    await s.run(Tasks.use((x) => x.requestChanges(second?.id ?? "", "Add a title")))
    const changed = await s.get(second?.id ?? "")
    expect(changed.decision).toBe("changes")
    expect(changed.decisionText).toBe("Add a title")
    const decided = taskMoments(changed, "Lia").find((m) => m.id === "decided")
    expect(decided).toMatchObject({ decision: "changes", text: "Add a title" })
    // The new part is a new task with its own moments.
    await until(async () => (await s.parts()).some((t) => t.label === "Changes: Facts"))
    const next = (await s.parts()).find((t) => t.label === "Changes: Facts")
    expect(next?.decision).toBeNull()
    // Finish: accept the new part so the request ends.
    await until(async () =>
      (await s.parts()).some((t) => t.label === "Changes: Facts" && t.state === "review"),
    )
    await s.run(Tasks.use((x) => x.accept(next?.id ?? "")))
  })
})

describe("recent work of an agent", () => {
  test("it lists the tasks of one agent, newest first, and no more than 20", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    for (let i = 1; i <= RECENT_WORK_MAX + 3; i++) await s.make(ada.id, `task ${i}`)
    await s.make(bo.id, "other")
    const rows = await s.recent(ada.id)
    expect(rows).toHaveLength(RECENT_WORK_MAX)
    expect(rows[0]?.task.prompt).toBe(`task ${RECENT_WORK_MAX + 3}`)
    expect(rows.at(-1)?.task.prompt).toBe("task 4")
    expect(rows.every((r) => r.task.agentId === ada.id)).toBe(true)
    expect((await s.recent(bo.id)).map((r) => r.task.prompt)).toEqual(["other"])
    // An agent with no task has an empty list.
    const cy = await s.agent("Cy")
    expect(await s.recent(cy.id)).toEqual([])
  })

  test("a row says when the task last changed, and that is its latest moment", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    await s.run(Tasks.use((x) => x.run(task.id, ada.id, Effect.sleep(5))))
    const [row] = await s.recent(ada.id)
    const done = await s.get(task.id)
    expect(row?.changedAt).toBe(done.finishedAt ?? 0)
    expect(row?.wait).toBeNull()
    expect(row?.behind).toBeNull()
  })

  test("a queued task names the channel that its agent works for", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Launch",
          topic: "",
          memberIds: [ada.id, bo.id],
          leadId: ada.id,
        }),
      ),
    )
    const gate = Deferred.makeUnsafe<void>()
    const busy = await s.make(ada.id, "busy", "channel", channel.id)
    const first = s.run(Tasks.use((x) => x.run(busy.id, ada.id, Deferred.await(gate))))
    await until(async () => (await s.get(busy.id)).state === "running")
    const waiting = await s.make(ada.id, "next")
    const second = s.run(Tasks.use((x) => x.run(waiting.id, ada.id, Effect.void)))
    await until(async () => (await s.get(waiting.id)).state === "queued")
    let rows = await s.recent(ada.id)
    expect(rows.find((r) => r.task.id === waiting.id)?.behind).toEqual({
      kind: "channel",
      name: "Launch",
    })
    // The running task itself waits behind nothing.
    expect(rows.find((r) => r.task.id === busy.id)?.behind).toBeNull()
    await s.run(Deferred.succeed(gate, undefined))
    await Promise.all([first, second])
    rows = await s.recent(ada.id)
    expect(rows.every((r) => r.behind === null)).toBe(true)
  })

  test("a task of a chat that runs makes the next one wait behind its own chat", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const gate = Deferred.makeUnsafe<void>()
    const busy = await s.make(ada.id, "busy")
    const first = s.run(Tasks.use((x) => x.run(busy.id, ada.id, Deferred.await(gate))))
    await until(async () => (await s.get(busy.id)).state === "running")
    const waiting = await s.make(ada.id, "next")
    const second = s.run(Tasks.use((x) => x.run(waiting.id, ada.id, Effect.void)))
    await until(async () => (await s.get(waiting.id)).state === "queued")
    expect((await s.recent(ada.id)).find((r) => r.task.id === waiting.id)?.behind).toEqual({
      kind: "chat",
    })
    await s.run(Deferred.succeed(gate, undefined))
    await Promise.all([first, second])
  })

  test("a task that waits says what it waits for; with no request it says that it waits for the user", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const task = await s.make(ada.id, "p")
    const gate = Deferred.makeUnsafe<void>()
    const running = s.run(Tasks.use((x) => x.run(task.id, ada.id, Deferred.await(gate))))
    await until(async () => (await s.get(task.id)).state === "running")
    await s.run(Tasks.use((x) => Effect.sync(() => x.setWaiting(task.id, true))))
    const [row] = await s.recent(ada.id)
    expect(row?.task.state).toBe("waiting")
    expect(row?.wait).toBe("user")
    await s.run(Tasks.use((x) => Effect.sync(() => x.setWaiting(task.id, false))))
    expect((await s.recent(ada.id))[0]?.wait).toBeNull()
    await s.run(Deferred.succeed(gate, undefined))
    await running
  })
})
