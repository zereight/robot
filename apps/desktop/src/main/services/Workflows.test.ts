import { afterAll, describe, expect, test } from "bun:test"
import type { Edge, Step, Trigger } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

/** The last message of each request that the model got. */
const asked: string[] = []

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    asked.push(last)
    if (last.includes("FAIL")) return Response.json({ error: { message: "boom" } }, { status: 500 })
    // A reply that ends with a Blocked line (spec 005).
    if (last.includes("BLOCKME"))
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "I looked.\nBlocked: no access to the folder" } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: `Done(${last.split("\n")[0]})` } }] })}\n\ndata: [DONE]\n\n`
    return new Response(chunk, { headers: { "content-type": "text/event-stream" } })
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
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-workflow-test-key",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: "Work.",
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  const [ada, bo] = await Promise.all([agent("Ada"), agent("Bo")])
  const channel = await run(
    Channels.use((c) =>
      c.create({ serverId: local.id, name: "Out", topic: "", memberIds: [ada.id], leadId: null }),
    ),
  )
  const agentStep = (
    id: string,
    agentId: string,
    prompt: string,
    continueOnFailure = false,
  ): Step => ({
    id,
    kind: "agent",
    name: id,
    x: 0,
    y: 0,
    agentId,
    prompt,
    continueOnFailure,
  })
  const post = (id: string, text: string): Step => ({
    id,
    kind: "post",
    name: id,
    x: 0,
    y: 0,
    channelId: channel.id,
    text,
  })
  const edge = (from: string, to: string, branch?: "yes" | "no"): Edge => ({
    id: `${from}-${to}`,
    from,
    to,
    ...(branch ? { branch } : {}),
  })
  const create = (steps: Step[], edges: Edge[], trigger: Trigger = { kind: "manual" }) =>
    run(Workflows.use((w) => w.create({ serverId: local.id, name: "Flow", trigger, steps, edges })))
  const start = (id: string, text?: string) => run(Workflows.use((w) => w.run(id, text)))
  const finished = async (runId: string) => {
    await until(
      async () => (await run(Workflows.use((w) => w.runDetail(runId)))).run.state !== "running",
    )
    return run(Workflows.use((w) => w.runDetail(runId)))
  }
  const posted = async () =>
    (await run(Channels.use((c) => c.history(channel.id)))).filter((m) => m.author === "user")
  return { run, local, ada, bo, channel, agentStep, post, edge, create, start, finished, posted }
}

const states = (d: { steps: readonly { stepId: string; state: string }[] }) =>
  Object.fromEntries(d.steps.map((s) => [s.stepId, s.state]))

describe("workflows", () => {
  test("a two-step flow passes the first result to the second and posts the final message", async () => {
    const s = await setup()
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, "Write a haiku"),
        s.agentStep("b", s.bo.id, "Translate this: {{input}}"),
        s.post("p", "Final: {{input}}"),
      ],
      [s.edge("a", "b"), s.edge("b", "p")],
    )
    const detail = await s.finished((await s.start(wf.id)).id)
    expect(detail.run.state).toBe("done")
    expect(states(detail)).toEqual({ a: "done", b: "done", p: "done" })
    const a = detail.steps.find((x) => x.stepId === "a")
    const b = detail.steps.find((x) => x.stepId === "b")
    expect(a?.result).toContain("Write a haiku")
    expect(b?.input).toBe(a?.result ?? "?")
    const messages = await s.posted()
    expect(JSON.stringify(messages.at(-1)?.parts)).toContain(`Final: ${b?.result}`)
    expect(a?.taskId).toBeTruthy()
  })

  test("a condition takes one branch and skips the other", async () => {
    const s = await setup()
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, "Say haiku"),
        { id: "c", kind: "condition", name: "c", x: 0, y: 0, contains: "haiku" },
        s.post("yes", "YES"),
        s.post("no", "NO"),
      ],
      [s.edge("a", "c"), s.edge("c", "yes", "yes"), s.edge("c", "no", "no")],
    )
    const detail = await s.finished((await s.start(wf.id)).id)
    expect(states(detail)).toEqual({ a: "done", c: "done", yes: "done", no: "skipped" })
    expect(detail.run.state).toBe("done")
  })

  test("a failed step stops the run; with continue on failure the flow goes on", async () => {
    const s = await setup()
    const stop = await s.create(
      [s.agentStep("a", s.ada.id, "FAIL now"), s.post("p", "after")],
      [s.edge("a", "p")],
    )
    const failed = await s.finished((await s.start(stop.id)).id)
    expect(failed.run.state).toBe("failed")
    expect(states(failed)).toEqual({ a: "failed", p: "skipped" })

    const goOn = await s.create(
      [s.agentStep("a", s.ada.id, "FAIL now", true), s.post("p", "after")],
      [s.edge("a", "p")],
    )
    const ok = await s.finished((await s.start(goOn.id)).id)
    expect(states(ok)).toEqual({ a: "failed", p: "done" })
    expect(ok.run.state).toBe("done")
  })

  test("an approval step waits; approve goes on, reject fails; the editor is locked while it waits", async () => {
    const s = await setup()
    const wf = await s.create(
      [
        { id: "g", kind: "approval", name: "g", x: 0, y: 0, message: "Go?" },
        s.post("p", "approved"),
      ],
      [s.edge("g", "p")],
    )
    const first = await s.start(wf.id)
    await until(
      async () => states(await s.run(Workflows.use((w) => w.runDetail(first.id)))).g === "waiting",
    )
    const locked = await s.run(Workflows.use((w) => w.update(wf.id, { name: "New" }))).then(
      () => "ok",
      (e) => e,
    )
    expect(locked).toMatchObject({ code: "workflow_running" })
    expect((await s.run(Workflows.use((w) => w.list(s.local.id))))[0]?.running).toBe(true)
    await s.run(Workflows.use((w) => w.approve(first.id, "g", true)))
    expect((await s.finished(first.id)).run.state).toBe("done")

    const second = await s.start(wf.id)
    await until(
      async () => states(await s.run(Workflows.use((w) => w.runDetail(second.id)))).g === "waiting",
    )
    await s.run(Workflows.use((w) => w.approve(second.id, "g", false)))
    const rejected = await s.finished(second.id)
    expect(rejected.run.state).toBe("failed")
    expect(states(rejected)).toEqual({ g: "failed", p: "skipped" })
    // The editor opens again after the run.
    const renamed = await s.run(Workflows.use((w) => w.update(wf.id, { name: "New" })))
    expect(renamed.name).toBe("New")
  })

  test("stop cancels a waiting run", async () => {
    const s = await setup()
    const wf = await s.create(
      [{ id: "g", kind: "approval", name: "g", x: 0, y: 0, message: "" }, s.post("p", "x")],
      [s.edge("g", "p")],
    )
    const r = await s.start(wf.id)
    await until(
      async () => states(await s.run(Workflows.use((w) => w.runDetail(r.id)))).g === "waiting",
    )
    await s.run(Workflows.use((w) => w.stop(r.id)))
    const detail = await s.finished(r.id)
    expect(detail.run.state).toBe("cancelled")
    expect(states(detail)).toEqual({ g: "failed", p: "skipped" })
  })

  test("a message in the trigger channel starts the flow, and the text reaches the prompt", async () => {
    const s = await setup()
    const wf = await s.create([s.agentStep("a", s.ada.id, "Handle: {{trigger}}")], [], {
      kind: "channel",
      channelId: s.channel.id,
      contains: "deploy",
    })
    await s.run(Channels.use((c) => c.send(s.channel.id, "@Ada please deploy now")))
    await until(async () => (await s.run(Workflows.use((w) => w.runs(wf.id)))).length === 1)
    const [run] = await s.run(Workflows.use((w) => w.runs(wf.id)))
    const detail = await s.finished(run?.id ?? "")
    expect(detail.run.trigger).toBe("channel")
    expect(detail.steps[0]?.result).toContain("Handle: @Ada please deploy now")
    // A message without the text starts nothing.
    await s.run(Channels.use((c) => c.send(s.channel.id, "@Ada hello")))
    await Bun.sleep(100)
    expect(await s.run(Workflows.use((w) => w.runs(wf.id)))).toHaveLength(1)
  })

  test('"Record only": a message trigger records the run, runs no step and asks no model; Run now still runs', async () => {
    const s = await setup()
    asked.length = 0
    const wf = await s.create([s.agentStep("a", s.ada.id, "Handle: {{trigger}}")], [], {
      kind: "channel",
      channelId: s.channel.id,
      contains: "deploy",
      recordOnly: true,
    })
    await s.run(Channels.use((c) => c.send(s.channel.id, "@Ada please deploy now")))
    await until(async () => (await s.run(Workflows.use((w) => w.runs(wf.id)))).length === 1)
    const [recorded] = await s.run(Workflows.use((w) => w.runs(wf.id)))
    expect(recorded?.state).toBe("recorded")
    expect(recorded?.triggerText).toBe("@Ada please deploy now")
    expect(recorded?.finishedAt).not.toBeNull()
    const detail = await s.run(Workflows.use((w) => w.runDetail(recorded?.id ?? "")))
    expect(detail.steps).toEqual([])
    expect(asked.some((m) => m.includes("Handle:"))).toBe(false)
    // A recorded run is not a running one: Run now works and runs the steps.
    const now = await s.finished((await s.start(wf.id, "by hand")).id)
    expect(now.run.state).toBe("done")
    expect(now.steps[0]?.result).toContain("Handle: by hand")
  })

  test("a schedule trigger fires on the tick", async () => {
    const s = await setup()
    const wf = await s.create([s.agentStep("a", s.ada.id, "Tick")], [], {
      kind: "schedule",
      schedule: { kind: "every", minutes: 5, from: Date.now() },
    })
    await s.run(Workflows.use((w) => w.tick(Date.now() + 5 * 60_000 + 1000)))
    await until(async () => (await s.run(Workflows.use((w) => w.runs(wf.id)))).length === 1)
    const [run] = await s.run(Workflows.use((w) => w.runs(wf.id)))
    expect(run?.trigger).toBe("schedule")
  })

  test("a cycle, a bad edge, or a missing agent is refused", async () => {
    const s = await setup()
    const cycle = await s
      .create([s.post("a", "x"), s.post("b", "y")], [s.edge("a", "b"), s.edge("b", "a")])
      .then(
        () => "ok",
        (e) => e,
      )
    expect(cycle).toMatchObject({ code: "graph_cycle" })
    const missing = await s.create([s.agentStep("a", "nope", "x")], []).then(
      () => "ok",
      (e) => e,
    )
    expect(missing).toMatchObject({ code: "agent_not_found" })
    const empty = await s.create([], [])
    const refused = await s.start(empty.id).then(
      () => "ok",
      (e) => e,
    )
    expect(refused).toMatchObject({ code: "graph_no_steps" })
  })
  test("an agent step whose task ends as Blocked is a failed step, with the reason (spec 005, 010)", async () => {
    const s = await setup()
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, "BLOCKME in the folder"),
        s.agentStep("b", s.bo.id, "Never runs"),
      ],
      [s.edge("a", "b")],
    )
    const detail = await s.finished((await s.start(wf.id)).id)
    expect(detail.run.state).toBe("failed")
    expect(states(detail)).toEqual({ a: "failed", b: "skipped" })
    expect(detail.steps.find((x) => x.stepId === "a")?.error).toBe("no access to the folder")
  })

  test("a blocked step with Continue on failure lets the next step run", async () => {
    const s = await setup()
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, "BLOCKME in the folder", true),
        s.agentStep("b", s.bo.id, "Go on"),
      ],
      [s.edge("a", "b")],
    )
    const detail = await s.finished((await s.start(wf.id)).id)
    expect(states(detail)).toEqual({ a: "failed", b: "done" })
  })
})
