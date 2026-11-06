import { afterAll, describe, expect, test } from "bun:test"
import { RECENT_WORK_MAX, taskMoments } from "@robot/shared"
import { Deferred, Effect } from "effect"
import { Agents } from "./Agents.ts"
import { AppError } from "./errors.ts"
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
  hostname: "127.0.0.1",
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
  const make = (agentId: string, prompt: string, source: "chat" = "chat", id?: string) =>
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
    expect(taskMoments(done).map((m) => m.id)).toEqual(["given", "started", "ended", "closed"])
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
    expect(taskMoments(stoppedQueued).map((m) => m.id)).toEqual(["given", "closed"])
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
