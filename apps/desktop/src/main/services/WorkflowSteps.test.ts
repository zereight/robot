import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { Edge, Step } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Notifier } from "./Notifier.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { fakeClock } from "./silence.testing.ts"
import { useClockForTests } from "./silence.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

interface Seen {
  readonly key: string
  readonly body: {
    messages: { role: string; content: string }[]
    reasoning_effort?: string
    output_config?: { effort?: string }
  }
}
const seen: Seen[] = []
const failedOnce = new Set<string>()
/** The model list that the Claude account of a test gets. */
let claudeModels: unknown[] = []

const sse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models")
      return Response.json({
        data: req.headers.get("x-api-key") ? claudeModels : [{ id: "mock" }, { id: "o3-mini" }],
      })
    const body = (await req.json()) as Seen["body"]
    if (url.pathname === "/v1/messages") {
      seen.push({ key: req.headers.get("x-api-key") ?? "", body })
      return new Response(
        [
          { type: "message_start", message: { usage: { input_tokens: 1 } } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
          { type: "message_stop" },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    const key = req.headers.get("authorization")?.replace("Bearer ", "") ?? ""
    seen.push({ key, body })
    const last = body.messages.at(-1)?.content ?? ""
    // A model that opens the answer and then sends nothing.
    if (last.includes("HANG"))
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
    if (last.includes("Reply with yes or no only.")) {
      if (last.includes("BUSY"))
        return Response.json({ error: { message: "The engine is overloaded" } }, { status: 503 })
      if (last.includes("LIMIT"))
        return Response.json({ error: { message: "slow" } }, { status: 429 })
      if (last.includes("AUTH")) return Response.json({ error: { message: "no" } }, { status: 401 })
      if (last.includes("ONCE") && !failedOnce.has(last)) {
        failedOnce.add(last)
        return Response.json({ error: { message: "boom" } }, { status: 500 })
      }
      if (last.includes("MAYBE")) return sse(`Maybe,\nit depends. ${"x".repeat(400)}`)
      return sse(last.includes("NOPE") ? "No." : "Yes")
    }
    return sse(`Done(${last.split("\n")[0]})`)
  },
})
afterAll(() => server.stop(true))
afterEach(() => useClockForTests(undefined))

const until = async (check: () => Promise<boolean> | boolean, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const setup = async () => {
  seen.length = 0
  const t = testRuntime()
  const run = t.runtime.runPromise
  const connect = (name: string, apiKey: string) =>
    run(
      Providers.use((p) =>
        p.connect({
          kind: "openai",
          name,
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey,
        }),
      ),
    )
  const first = await connect("First", "sk-first-account-key")
  const local = await run(Servers.use((s) => s.local))
  const agent = (
    name: string,
    accountId = first.id,
    model = "o3-mini",
    effort: string | null = "high",
  ) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: "Work.",
          model: { accountId, model, effort },
        }),
      ),
    )
  const ada = await agent("Ada")
  const agentStep = (
    id: string,
    agentId: string,
    prompt: string,
    extra: Partial<Step> = {},
  ): Step =>
    ({
      id,
      kind: "agent",
      name: id,
      x: 0,
      y: 0,
      agentId,
      prompt,
      continueOnFailure: false,
      ...extra,
    }) as Step
  const ask = (id: string, question: string, extra: Partial<Step> = {}): Step =>
    ({
      id,
      kind: "condition",
      name: id,
      x: 0,
      y: 0,
      contains: question,
      mode: "ask",
      ...extra,
    }) as Step
  /** A step at the end of a path: a notice with the text as its title. */
  const post = (id: string, text: string): Step => ({
    id,
    kind: "notify",
    name: id,
    x: 0,
    y: 0,
    title: text,
  })
  const notify = (id: string, title: string): Step => ({
    id,
    kind: "notify",
    name: id,
    x: 0,
    y: 0,
    title,
  })
  const edge = (from: string, to: string, branch?: "yes" | "no"): Edge => ({
    id: `${from}-${to}`,
    from,
    to,
    ...(branch ? { branch } : {}),
  })
  const create = (steps: Step[], edges: Edge[], notes: never[] = []) =>
    run(
      Workflows.use((w) =>
        w.create({
          serverId: local.id,
          name: "Flow",
          trigger: { kind: "manual" },
          steps,
          edges,
          notes,
        }),
      ),
    )
  const finished = async (workflowId: string) => {
    const started = await run(Workflows.use((w) => w.run(workflowId)))
    await until(
      async () =>
        (await run(Workflows.use((w) => w.runDetail(started.id)))).run.state !== "running",
    )
    return run(Workflows.use((w) => w.runDetail(started.id)))
  }
  const states = (d: { steps: readonly { stepId: string; state: string }[] }) =>
    Object.fromEntries(d.steps.map((s) => [s.stepId, s.state]))
  const asked = () => seen.filter((s) => s.body.messages.at(-1)?.content.includes("yes or no only"))
  return {
    t,
    run,
    local,
    ada,
    first,
    connect,
    agent,
    agentStep,
    ask,
    post,
    notify,
    edge,
    create,
    finished,
    states,
    asked,
  }
}

describe("notify step", () => {
  test("shows a notice with the title and the first 200 characters, and passes the input on", async () => {
    const s = await setup()
    s.t.shell.focused = false
    const prompt = `${"a".repeat(150)}${"b".repeat(150)}`
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, prompt),
        s.notify("n", "Finished"),
        s.post("p", "After: {{input}}"),
      ],
      [s.edge("a", "n"), s.edge("n", "p")],
    )
    const detail = await s.finished(wf.id)
    expect(detail.run.state).toBe("done")
    expect(s.states(detail)).toEqual({ a: "done", n: "done", p: "done" })
    const a = detail.steps.find((x) => x.stepId === "a")
    const n = detail.steps.find((x) => x.stepId === "n")
    const p = detail.steps.find((x) => x.stepId === "p")
    // The reply of the agent notifies too; the notice of the step is the one with its title.
    const notices = s.t.shell.notices.filter((x) => x.title === "Finished")
    expect(notices).toHaveLength(1)
    // The body is the first 200 characters of the input. The input is longer.
    expect((a?.result ?? "").length).toBeGreaterThan(200)
    expect(notices[0]?.body).toBe((a?.result ?? "").slice(0, 200))
    // The run view holds the whole input, and the step passes it on unchanged.
    expect(n?.input).toBe(a?.result ?? "?")
    expect(n?.result).toBe(a?.result ?? "?")
    expect(p?.input).toBe(a?.result ?? "?")
  })

  test("a window with focus shows no notice, and a notice follows the settings and the mutes", async () => {
    const s = await setup()
    const wf = await s.create(
      [s.agentStep("a", s.ada.id, "Hi"), s.notify("n", "T")],
      [s.edge("a", "n")],
    )
    await s.finished(wf.id)
    expect(s.t.shell.notices).toHaveLength(0)

    s.t.shell.focused = false
    // The kind can be turned off.
    await s.run(
      SettingsStore.use((x) =>
        x.update({
          notifyKinds: {
            reply: true,
            mention: true,
            approval: true,
            question: true,
            task_failed: true,
            routine_failed: true,
            workflow_notice: false,
          },
        }),
      ),
    )
    await s.finished(wf.id)
    expect(s.t.shell.notices.filter((n) => n.title === "T")).toHaveLength(0)
    // A setting that was saved before the kind existed has no value for it: the kind is on.
    await s.run(
      SettingsStore.use((x) =>
        x.update({
          notifyKinds: {
            reply: true,
            mention: true,
            approval: true,
            question: true,
            task_failed: true,
            routine_failed: true,
          },
        }),
      ),
    )
    await s.finished(wf.id)
    expect(s.t.shell.notices.filter((n) => n.title === "T")).toHaveLength(1)
    // A muted server gets none.
    await s.run(Notifier.use((n) => n.setMute("server", s.local.id, "1h")))
    await s.finished(wf.id)
    expect(s.t.shell.notices.filter((n) => n.title === "T")).toHaveLength(1)
  })

  test("a click on the notice opens the page of workflows", async () => {
    const s = await setup()
    s.t.shell.focused = false
    const wf = await s.create([s.notify("n", "Click me")], [])
    await s.finished(wf.id)
    s.t.shell.notices.find((x) => x.title === "Click me")?.click()
    expect(s.t.shell.shown).toBe(1)
    const opened = s.t.events.find((e) => e.event === "app.openPage")
    expect(opened?.payload).toEqual({ page: "workflows" })
  })

  test("a notify step without a title uses the name of the step", async () => {
    const s = await setup()
    s.t.shell.focused = false
    const wf = await s.create([s.notify("Tell me", "  ")], [])
    await s.finished(wf.id)
    expect(s.t.shell.notices[0]?.title).toBe("Tell me")
  })
})

describe("notes", () => {
  const note = (id: string, text: string, tone: "yellow" | "blue" | "green" | "pink") => ({
    id,
    text,
    tone,
    x: 10,
    y: 20,
  })

  test("a workflow keeps its notes: text, tone and place; they can be changed and removed", async () => {
    const s = await setup()
    const wf = await s.run(
      Workflows.use((w) =>
        w.create({
          serverId: s.local.id,
          name: "Noted",
          trigger: { kind: "manual" },
          steps: [s.post("p", "x")],
          edges: [],
          notes: [note("n1", "Read me", "pink")],
        }),
      ),
    )
    expect(wf.notes).toEqual([note("n1", "Read me", "pink")])
    const moved = await s.run(
      Workflows.use((w) =>
        w.update(wf.id, {
          notes: [
            { ...note("n1", "Read me again", "green"), x: 300, y: 40 },
            note("n2", "", "blue"),
          ],
        }),
      ),
    )
    expect(moved.notes.map((n) => [n.id, n.text, n.tone, n.x, n.y])).toEqual([
      ["n1", "Read me again", "green", 300, 40],
      ["n2", "", "blue", 10, 20],
    ])
    // An update without notes leaves them; an empty list removes them.
    expect(
      (await s.run(Workflows.use((w) => w.update(wf.id, { name: "Other" })))).notes,
    ).toHaveLength(2)
    expect((await s.run(Workflows.use((w) => w.update(wf.id, { notes: [] })))).notes).toEqual([])
  })

  test("notes have no effect on a run and no node number in it", async () => {
    const s = await setup()
    const plain = await s.create(
      [s.agentStep("a", s.ada.id, "Hi"), s.post("p", "{{input}}")],
      [s.edge("a", "p")],
    )
    const noted = await s.run(
      Workflows.use((w) =>
        w.create({
          serverId: s.local.id,
          name: "Noted",
          trigger: { kind: "manual" },
          steps: [s.agentStep("a", s.ada.id, "Hi"), s.post("p", "{{input}}")],
          edges: [s.edge("a", "p")],
          notes: [note("n1", "Hi", "yellow"), note("n2", "There", "blue")],
        }),
      ),
    )
    const [one, two] = [await s.finished(plain.id), await s.finished(noted.id)]
    expect(two.steps.map((x) => [x.stepId, x.state])).toEqual(
      one.steps.map((x) => [x.stepId, x.state]),
    )
    expect(two.steps).toHaveLength(2)
  })

  test("a workflow that was stored before notes existed has none", async () => {
    const s = await setup()
    const wf = await s.create([s.post("p", "x")], [])
    expect(wf.notes).toEqual([])
  })
})

describe("a condition in mode Ask a model", () => {
  const flow = async (s: Awaited<ReturnType<typeof setup>>, question: string, input: string) => {
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, input),
        s.ask("c", question),
        s.post("yes", "YES"),
        s.post("no", "NO"),
      ],
      [s.edge("a", "c"), s.edge("c", "yes", "yes"), s.edge("c", "no", "no")],
    )
    return s.finished(wf.id)
  }

  test("yes takes the Yes branch, no takes the No branch; the input goes on", async () => {
    const s = await setup()
    const yes = await flow(s, "Is it a greeting?", "Hello")
    expect(s.states(yes)).toEqual({ a: "done", c: "done", yes: "done", no: "skipped" })
    const c = yes.steps.find((x) => x.stepId === "c")
    expect(c?.result).toBe(c?.input ?? "?")
    expect(s.asked()).toHaveLength(1)
    // The model got the question and the input, and no tools.
    const content = s.asked()[0]?.body.messages.at(-1)?.content ?? ""
    expect(content).toContain("Is it a greeting?")
    expect(content).toContain(c?.input ?? "?")
    expect(s.asked()[0]?.body).not.toHaveProperty("tools")

    const no = await flow(s, "Is it a greeting? NOPE", "Hello")
    expect(s.states(no)).toEqual({ a: "done", c: "done", yes: "skipped", no: "done" })
  })

  test("a condition from before the second mode keeps testing for text", async () => {
    const s = await setup()
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, "Say haiku"),
        { id: "c", kind: "condition", name: "c", x: 0, y: 0, contains: "HAIKU" },
        s.post("yes", "YES"),
        s.post("no", "NO"),
      ],
      [s.edge("a", "c"), s.edge("c", "yes", "yes"), s.edge("c", "no", "no")],
    )
    const detail = await s.finished(wf.id)
    expect(s.states(detail)).toEqual({ a: "done", c: "done", yes: "done", no: "skipped" })
    expect(s.asked()).toHaveLength(0)
  })

  test("an answer that is not yes or no fails; the error holds its start on one line", async () => {
    const s = await setup()
    const detail = await flow(s, "Is it fine? MAYBE", "Hello")
    expect(detail.run.state).toBe("failed")
    const c = detail.steps.find((x) => x.stepId === "c")
    expect(c?.state).toBe("failed")
    expect(c?.error.startsWith("answer_not_yes_no: Maybe, it depends. xxx")).toBe(true)
    expect(c?.error).not.toContain("\n")
    expect(c?.error.length).toBe("answer_not_yes_no: ".length + 240)
    // Not asked again: the answer came, it was only the wrong one.
    expect(s.asked()).toHaveLength(1)
    expect(s.states(detail)).toEqual({ a: "done", c: "failed", yes: "skipped", no: "skipped" })
  })

  test("a plain failure is tried again after 2 seconds, and the step works on the second try", async () => {
    const s = await setup()
    const began = Date.now()
    const detail = await flow(s, "Is it a greeting? ONCE", "Hello")
    expect(detail.run.state).toBe("done")
    expect(s.asked()).toHaveLength(2)
    expect(Date.now() - began).toBeGreaterThanOrEqual(1900)
    expect(s.states(detail).c).toBe("done")
  }, 15_000)

  for (const [marker, code] of [
    ["BUSY", "provider_busy"],
    ["LIMIT", "provider_limit"],
    ["AUTH", "provider_auth"],
  ] as const) {
    test(`${code} ends the step at once, with no new try`, async () => {
      const s = await setup()
      const began = Date.now()
      const detail = await flow(s, `Is it a greeting? ${marker}`, "Hello")
      expect(detail.run.state).toBe("failed")
      expect(detail.steps.find((x) => x.stepId === "c")?.error).toBe(code)
      expect(s.asked()).toHaveLength(1)
      expect(Date.now() - began).toBeLessThan(1500)
    })
  }

  test("a condition with no question fails; one with no account fails", async () => {
    const s = await setup()
    const wf = await s.create([s.ask("c", "  "), s.post("p", "x")], [s.edge("c", "p", "yes")])
    const blank = await s.finished(wf.id)
    expect(blank.steps.find((x) => x.stepId === "c")?.error).toBe("no_question")
    const bare = testRuntime()
    const local = await bare.runtime.runPromise(Servers.use((x) => x.local))
    const created = await bare.runtime.runPromise(
      Workflows.use((w) =>
        w.create({
          serverId: local.id,
          name: "Bare",
          trigger: { kind: "manual" },
          steps: [s.ask("c", "Is it?")],
          edges: [],
        }),
      ),
    )
    const started = await bare.runtime.runPromise(Workflows.use((w) => w.run(created.id)))
    await until(
      async () =>
        (await bare.runtime.runPromise(Workflows.use((w) => w.runDetail(started.id)))).run.state !==
        "running",
    )
    const detail = await bare.runtime.runPromise(Workflows.use((w) => w.runDetail(started.id)))
    expect(detail.steps[0]?.error).toBe("provider_not_connected")
  })

  test("with no model named, the model of the agent before it answers; then the first account", async () => {
    const s = await setup()
    const second = await s.connect("Second", "sk-second-account-key")
    const bo = await s.agent("Bo", second.id, "mock", null)
    // The agent before the condition uses the second account: it answers, not the first one.
    const wf = await s.create(
      [s.agentStep("a", bo.id, "Hello"), s.ask("c", "Is it a greeting?")],
      [s.edge("a", "c")],
    )
    await s.finished(wf.id)
    const afterAgent = s.asked()
    expect(afterAgent).toHaveLength(1)
    expect(afterAgent[0]?.key).toBe("sk-second-account-key")
    expect(afterAgent[0]?.body).toMatchObject({ model: "mock" })
    expect(afterAgent[0]?.body.reasoning_effort).toBeUndefined()

    // No agent before it: the first account that is connected, with its first model.
    seen.length = 0
    const alone = await s.create([s.ask("c", "Is it a greeting?")], [])
    await s.finished(alone.id)
    expect(s.asked()[0]?.key).toBe("sk-first-account-key")
    expect(s.asked()[0]?.body).toMatchObject({ model: "mock" })

    // A step that names a model gets that one.
    seen.length = 0
    const named = await s.create(
      [s.ask("c", "Is it a greeting?", { provider: { accountId: second.id, model: "o3-mini" } })],
      [],
    )
    await s.finished(named.id)
    expect(s.asked()[0]?.key).toBe("sk-second-account-key")
    expect(s.asked()[0]?.body).toMatchObject({ model: "o3-mini" })

    // A named model that is not there fails at the step, where the user made the choice.
    const wrong = await s.create(
      [s.ask("c", "Is it a greeting?", { provider: { accountId: "gone", model: "x" } })],
      [],
    )
    const failed = await s.finished(wrong.id)
    expect(failed.steps[0]?.error).toBe("provider_not_found")
  })
})

describe("effort of an agent step", () => {
  const effortOf = (index: number) => seen[index]?.body.reasoning_effort

  test("the step runs one turn with its effort; the next chat turn has the effort of the agent", async () => {
    const s = await setup()
    const wf = await s.create([s.agentStep("a", s.ada.id, "Hello", { effort: "low" })], [])
    await s.finished(wf.id)
    expect(effortOf(0)).toBe("low")
    // The agent has not changed.
    expect((await s.run(Agents.use((a) => a.get(s.ada.id)))).model?.effort).toBe("high")
    await s.run(Chat.use((c) => c.send({ agentId: s.ada.id, text: "Next turn", replyTo: null })))
    await until(() => seen.length >= 2)
    expect(effortOf(1)).toBe("high")
  })

  test("a step without effort follows the agent", async () => {
    const s = await setup()
    const wf = await s.create([s.agentStep("a", s.ada.id, "Hello")], [])
    await s.finished(wf.id)
    expect(effortOf(0)).toBe("high")
  })

  test("a model that does not offer the effort gets the effort of the agent, and a retry decides again", async () => {
    const s = await setup()
    // The model "mock" offers no effort level at all, so "low" is not offered.
    const quiet = await s.agent("Quiet", s.first.id, "mock", null)
    const wf = await s.create([s.agentStep("a", quiet.id, "Hello", { effort: "low" })], [])
    await s.finished(wf.id)
    expect(effortOf(0)).toBeUndefined()
    // "max" is not offered by o3-mini either: the agent keeps its own "high".
    const loud = await s.create([s.agentStep("a", s.ada.id, "Hello", { effort: "max" })], [])
    await s.finished(loud.id)
    expect(effortOf(1)).toBe("high")
    // The agent changes to a model that offers the effort. The next run of the step uses the
    // effort of the step: it is not the state of the first try that counts.
    await s.run(
      Agents.use((a) =>
        a.update(quiet.id, { model: { accountId: s.first.id, model: "o3-mini", effort: null } }),
      ),
    )
    await s.finished(wf.id)
    expect(effortOf(2)).toBe("low")
  })
})

describe("effort of an agent step on a Claude model", () => {
  const levels = ["low", "medium", "high", "xhigh", "max"] as const
  /** A model of the Anthropic list, with the effort levels that it says it takes. */
  const listed = (id: string, takes: readonly string[]) => ({
    id,
    display_name: id,
    capabilities: {
      effort: {
        supported: takes.length > 0,
        ...Object.fromEntries(levels.map((l) => [l, { supported: takes.includes(l) }])),
      },
    },
  })
  /** Runs a workflow of one step with the effort `step` for a Claude agent. Gives the effort sent. */
  const claudeRun = async (model: string, step: "xhigh" | "max") => {
    const s = await setup()
    const account = await s.run(
      Providers.use((p) =>
        p.connect({
          kind: "anthropic",
          name: "Claude",
          baseUrl: `http://127.0.0.1:${server.port}`,
          apiKey: "sk-ant-test-key",
        }),
      ),
    )
    const agent = await s.agent("Claude agent", account.id, model, "high")
    const wf = await s.create([s.agentStep("a", agent.id, "Hello", { effort: step })], [])
    await s.finished(wf.id)
    return seen[0]?.body.output_config?.effort
  }

  test("a model whose list holds the level gets the level, with five levels up to extra high", async () => {
    claudeModels = [listed("claude-opus-5-5", levels)]
    expect(await claudeRun("claude-opus-5-5", "xhigh")).toBe("xhigh")
  })

  test("a model whose list lacks the level gets the effort of the agent", async () => {
    claudeModels = [listed("claude-sonnet-4-6", ["low", "medium", "high", "max"])]
    expect(await claudeRun("claude-sonnet-4-6", "xhigh")).toBe("high")
    expect(await claudeRun("claude-sonnet-4-6", "max")).toBe("max")
  })

  test("a model that the list does not name has the levels that the vendor documents for it", async () => {
    // The list holds another model, so the name of the model decides, as for the effort of an agent.
    claudeModels = [listed("claude-haiku-5-5", levels)]
    expect(await claudeRun("claude-opus-5-5", "xhigh")).toBe("xhigh")
    // Claude Opus 4.5 takes three levels: "max" is not offered, the agent keeps its own "high".
    expect(await claudeRun("claude-opus-4-5", "max")).toBe("high")
  })
})

describe("a step that still needs its agent", () => {
  test("it saves; a run fails at that step with the reason", async () => {
    const s = await setup()
    const wf = await s.create([s.agentStep("a", "", "Hello")], [])
    const detail = await s.finished(wf.id)
    expect(detail.run.state).toBe("failed")
    expect(detail.steps.find((x) => x.stepId === "a")?.error).toBe("no_agent")
    // An id that names nothing is still refused when the workflow is saved.
    const refused = await s.create([s.agentStep("a", "nope", "x")], []).then(
      () => "ok",
      (e) => e,
    )
    expect(refused).toMatchObject({ code: "agent_not_found" })
  })
})

describe("the silent limit in a workflow (spec 005)", () => {
  const started = async (s: Awaited<ReturnType<typeof setup>>, wf: { id: string }) => {
    const run = await s.run(Workflows.use((w) => w.run(wf.id)))
    const detail = () => s.run(Workflows.use((w) => w.runDetail(run.id)))
    return { run, detail }
  }
  const waitForRequest = async (count: number) => {
    await until(() => seen.length >= count)
    // The turn has handed the request over and waits for the model.
    await Bun.sleep(50)
  }

  test("an agent step that gets no answer fails with the minutes; the step keeps them", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ silentLimit: 5 })))
    const wf = await s.create(
      [s.agentStep("a", s.ada.id, "HANG now"), s.post("p", "after")],
      [s.edge("a", "p")],
    )
    const { detail } = await started(s, wf)
    await waitForRequest(1)
    fake.advance(4 * 60_000)
    expect(s.states(await detail()).a).toBe("running")
    fake.advance(60_000)
    await until(async () => (await detail()).run.state === "failed")
    const done = await detail()
    expect(s.states(done)).toEqual({ a: "failed", p: "skipped" })
    expect(done.steps.find((x) => x.stepId === "a")?.error).toBe("silent_limit:5")
    // The task of the step shows how far it went.
    const taskId = done.steps.find((x) => x.stepId === "a")?.taskId ?? ""
    const { task } = await s.run(Tasks.use((x) => x.get(taskId)))
    expect(task.error).toEqual({ code: "silent_limit", detail: "5" })
    expect(task.progress).toBe("sent")
  })

  test("one minute has its own words", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ silentLimit: 1 })))
    const wf = await s.create([s.agentStep("a", s.ada.id, "HANG now")], [])
    const { detail } = await started(s, wf)
    await waitForRequest(1)
    fake.advance(60_000)
    await until(async () => (await detail()).run.state === "failed")
    expect((await detail()).steps[0]?.error).toBe("silent_limit_1")
  })

  test("a condition in mode Ask a model is stopped by the limit, with no new try", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ silentLimit: 10 })))
    const wf = await s.create(
      [
        s.agentStep("a", s.ada.id, "Hello"),
        s.ask("c", "Is it quiet? HANG"),
        s.post("yes", "YES"),
        s.post("no", "NO"),
      ],
      [s.edge("a", "c"), s.edge("c", "yes", "yes"), s.edge("c", "no", "no")],
    )
    const { detail } = await started(s, wf)
    await until(() => s.asked().length >= 1)
    await Bun.sleep(50)
    fake.advance(10 * 60_000)
    await until(async () => (await detail()).run.state === "failed")
    const done = await detail()
    expect(s.states(done)).toEqual({ a: "done", c: "failed", yes: "skipped", no: "skipped" })
    expect(done.steps.find((x) => x.stepId === "c")?.error).toBe("silent_limit:10")
    expect(s.asked()).toHaveLength(1)
  })

  test("with the limit set to Never, a quiet model is not stopped", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ silentLimit: 0 })))
    const wf = await s.create([s.agentStep("a", s.ada.id, "HANG now")], [])
    const { run, detail } = await started(s, wf)
    await waitForRequest(1)
    fake.advance(24 * 60 * 60_000)
    await Bun.sleep(100)
    expect(s.states(await detail()).a).toBe("running")
    await s.run(Workflows.use((w) => w.stop(run.id)))
    await until(async () => (await detail()).run.state === "cancelled")
  })
})
