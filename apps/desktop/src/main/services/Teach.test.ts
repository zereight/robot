import { afterAll, describe, expect, test } from "bun:test"
import {
  messageSkill,
  newTurnMark,
  TEACH_STEPS_MAX,
  type TeachEvent,
  type TeachState,
} from "@robot/shared"
import { Effect, Exit } from "effect"
import { runRequest } from "../rpc.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Teach, teachAddress } from "./Teach.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

const KEY = "sk-teach-test"
/** The bodies of the requests that the fake model got. */
const asked: string[] = []
let failNext = false

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
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const raw = await req.text()
    asked.push(raw)
    if (failNext) {
      failNext = false
      return Response.json({ error: { message: "boom" } }, { status: 500 })
    }
    const body = JSON.parse(raw) as { messages: { content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    if (last.endsWith("Reply with the JSON object only."))
      return sse(
        JSON.stringify({
          name: "Weekly report",
          description: "When the user wants the report",
          instructions: "1. Open the page.\n2. Press the button.",
        }),
      )
    return sse(`Echo: ${last}`)
  },
})
afterAll(() => server.stop())

const until = async (check: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
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
        apiKey: KEY,
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const make = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: "",
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  const ada = await make("Ada")
  const bo = await make("Bo")
  const state = () => run(Teach.use((x) => x.state))
  const phase = async () => (await state()).phase
  /** Acts as the user in the browser of the agent. */
  const act = (agentId: string, event: TeachEvent) => {
    const recorder = t.recorders.get(agentId)
    if (!recorder) throw new Error("no recorder")
    recorder(event)
  }
  const fails = async <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const exit = await t.runtime.runPromiseExit(effect as never)
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    const reason = exit.cause.reasons.find((r) => r._tag === "Fail") as
      | { error: { code: string } }
      | undefined
    return reason?.error.code
  }
  const skills = () =>
    run(
      Database.use((db) =>
        Effect.sync(() =>
          db.all<{ id: string; name: string; agents: string; enabled: number }>(
            "SELECT id, name, agents, enabled FROM skill",
          ),
        ),
      ),
    )
  return { ...t, run, ada, bo, state, phase, act, fails, skills }
}

const doTheTask = (t: Awaited<ReturnType<typeof setup>>) => {
  t.act(t.ada.id, { kind: "page", url: "http://127.0.0.1/test", title: "Test page" })
  t.act(t.ada.id, { kind: "click", role: "button", label: "Press" })
  t.act(t.ada.id, {
    kind: "type",
    label: "Name",
    text: "hello",
    password: false,
    autocomplete: "",
  })
  t.act(t.ada.id, {
    kind: "type",
    label: "Password",
    text: "hunter2-very-secret",
    password: true,
    autocomplete: "",
  })
}

describe("Teach a task", () => {
  test("record, stop, draft, save: the model gets the steps and never the password", async () => {
    const t = await setup()
    const started = await t.run(Teach.use((x) => x.start(t.ada.id, "  Get the weekly report  ")))
    expect(started).toMatchObject({ phase: "recording", result: "Get the weekly report" })
    // The browser opens with the user in control, and the agent waits.
    expect(t.browserLog).toContain(`${t.ada.id}:open about:blank`)
    expect(t.browserInput.at(-1)).toBe(`${t.ada.id}:on`)
    expect(await t.run(Tools.use((x) => Effect.succeed(x.browserState(t.ada.id))))).toEqual({
      open: true,
      control: true,
    })
    doTheTask(t)
    expect(((await t.state()) as { steps: number }).steps).toBe(4)

    // Paused: nothing is recorded.
    await t.run(Teach.use((x) => x.pause(true)))
    t.act(t.ada.id, { kind: "click", role: "button", label: "While paused" })
    await t.run(Teach.use((x) => x.pause(false)))
    expect(((await t.state()) as { steps: number }).steps).toBe(4)

    asked.length = 0
    expect(await t.run(Teach.use((x) => x.stop))).toEqual({ empty: false })
    // The recorder stops and the agent gets its browser back.
    expect(t.recorders.has(t.ada.id)).toBe(false)
    expect(t.browserInput.at(-1)).toBe(`${t.ada.id}:off`)
    await until(async () => (await t.phase()) === "draft")
    expect(asked.length).toBe(1)
    const request = asked[0] as string
    expect(request).toContain('Clicked the button \\"Press\\"')
    expect(request).toContain("hello")
    expect(request).toContain("Typed a secret into Password")
    expect(request).not.toContain("hunter2-very-secret")
    expect(request).not.toContain("While paused")
    const draft = (await t.state()) as Exclude<TeachState, { phase: "idle" | "recording" }>
    expect(draft.draft?.name).toBe("Weekly report")
    expect(draft.steps).toBe(4)

    const skill = await t.run(
      Teach.use((x) =>
        x.save({ name: "Weekly report", description: "Get it", instructions: "1. Do it" }),
      ),
    )
    expect(skill.agentIds).toEqual([t.ada.id])
    expect(skill.enabled).toBe(true)
    expect(await t.skills()).toEqual([
      { id: skill.id, name: "Weekly report", agents: JSON.stringify([t.ada.id]), enabled: 1 },
    ])
    expect(await t.state()).toMatchObject({
      phase: "saved",
      skill: { id: skill.id, name: "Weekly report" },
    })
    await t.run(Teach.use((x) => x.discard))
    expect(await t.phase()).toBe("idle")
    await t.runtime.dispose()
  })

  test("one recording at a time; the other agent is refused with the name", async () => {
    const t = await setup()
    await t.run(Teach.use((x) => x.start(t.ada.id, "A")))
    expect(await t.fails(Teach.use((x) => x.start(t.bo.id, "B")))).toBe("teach_busy")
    await t.run(Teach.use((x) => x.cancel))
    await t.run(Teach.use((x) => x.start(t.bo.id, "B")))
    expect(await t.state()).toMatchObject({ phase: "recording", agentName: "Bo" })
    await t.runtime.dispose()
  })

  test("the result holds 1 to 500 characters", async () => {
    const t = await setup()
    expect(await t.fails(Teach.use((x) => x.start(t.ada.id, "   ")))).toBe("teach_result_invalid")
    expect(await t.fails(Teach.use((x) => x.start(t.ada.id, "x".repeat(501))))).toBe(
      "teach_result_invalid",
    )
    await t.run(Teach.use((x) => x.start(t.ada.id, "x".repeat(500))))
    await t.runtime.dispose()
  })

  test("cancel keeps nothing: no draft, no skill, no request", async () => {
    const t = await setup()
    await t.run(Teach.use((x) => x.start(t.ada.id, "Get it")))
    doTheTask(t)
    asked.length = 0
    await t.run(Teach.use((x) => x.cancel))
    expect(await t.phase()).toBe("idle")
    expect(asked.length).toBe(0)
    expect(await t.skills()).toEqual([])
    expect(t.recorders.has(t.ada.id)).toBe(false)
    await t.runtime.dispose()
  })

  test("stop with no steps makes no draft and ends", async () => {
    const t = await setup()
    await t.run(Teach.use((x) => x.start(t.ada.id, "Get it")))
    asked.length = 0
    expect(await t.run(Teach.use((x) => x.stop))).toEqual({ empty: true })
    expect(await t.phase()).toBe("idle")
    expect(asked.length).toBe(0)
    await t.runtime.dispose()
  })

  test("a failed request shows the reason; Try again asks once more", async () => {
    const t = await setup()
    await t.run(Teach.use((x) => x.start(t.ada.id, "Get it")))
    doTheTask(t)
    failNext = true
    await t.run(Teach.use((x) => x.stop))
    await until(async () => (await t.phase()) === "failed")
    expect(((await t.state()) as { error: string }).error).toBeTruthy()
    await t.run(Teach.use((x) => x.retry))
    await until(async () => (await t.phase()) === "draft")
    await t.runtime.dispose()
  })

  test("the recording stops by itself at 300 steps and the steps make the draft", async () => {
    const t = await setup()
    await t.run(Teach.use((x) => x.start(t.ada.id, "Click a lot")))
    // Steps after the limit find no recorder: it stopped by itself.
    for (let i = 0; i < TEACH_STEPS_MAX + 5; i++)
      t.recorders.get(t.ada.id)?.({ kind: "click", role: "button", label: `B${i}` })
    expect(t.recorders.has(t.ada.id)).toBe(false)
    await until(async () => (await t.phase()) === "draft")
    expect(await t.state()).toMatchObject({ limit: "steps", steps: TEACH_STEPS_MAX })
    await t.runtime.dispose()
  })

  test("a save keeps the limits of a skill; a taken name is refused", async () => {
    const t = await setup()
    for (const name of ["Report", "report"]) {
      await t.run(Teach.use((x) => x.start(t.ada.id, "Get it")))
      doTheTask(t)
      await t.run(Teach.use((x) => x.stop))
      await until(async () => (await t.phase()) === "draft")
      if (name === "Report") {
        await t.run(Teach.use((x) => x.save({ name, description: "", instructions: "x" })))
        await t.run(Teach.use((x) => x.discard))
      } else {
        expect(
          await t.fails(Teach.use((x) => x.save({ name, description: "", instructions: "x" }))),
        ).toBe("skill_name_taken")
        expect(
          await t.fails(
            Teach.use((x) => x.save({ name: "Other", description: "", instructions: "" })),
          ),
        ).toBe("skill_empty")
        // The draft stays until the user saves or discards.
        expect(await t.phase()).toBe("draft")
      }
    }
    await t.runtime.dispose()
  })

  test("a browser step of the agent waits while the user teaches", async () => {
    const t = await setup()
    await t.run(Teach.use((x) => x.start(t.ada.id, "Get it")))
    t.act(t.ada.id, { kind: "click", role: "button", label: "Press" })
    let done = false
    const controller = new AbortController()
    const step = t
      .run(
        Tools.use((x) =>
          Effect.promise(() =>
            x.execute(
              {
                agentId: t.ada.id,
                workspace: t.dataDir,
                permission: "full",
                signal: controller.signal,
                onWaiting: () => {},
                onMemory: () => {},
                onKnowledge: () => {},
                knowledgeChanges: { count: 0 },
                turn: newTurnMark("user"),
                taskId: null,
              },
              { id: "c1", name: "browser_click", input: JSON.stringify({ selector: "#go" }) },
            ),
          ),
        ),
      )
      .then(() => {
        done = true
      })
    await Bun.sleep(400)
    expect(done).toBe(false)
    expect(t.browserLog).not.toContain(`${t.ada.id}:click #go`)
    await t.run(Teach.use((x) => x.cancel))
    await step
    expect(t.browserLog).toContain(`${t.ada.id}:click #go`)
    await t.runtime.dispose()
  })

  test("a linked device cannot teach", async () => {
    const t = await setup()
    const result = await runRequest(t.runtime, "teach.start", { agentId: t.ada.id, result: "x" }, {
      id: "device",
      name: "Phone",
    } as never)
    expect(result).toEqual({ ok: false, error: { code: "not_allowed", message: "Not allowed" } })
    expect(await t.phase()).toBe("idle")
    await t.runtime.dispose()
  })

  test("Try it: a message with the chip gives the agent the instructions before the text", async () => {
    const t = await setup()
    await t.run(Teach.use((x) => x.start(t.ada.id, "Get the report")))
    doTheTask(t)
    await t.run(Teach.use((x) => x.stop))
    await until(async () => (await t.phase()) === "draft")
    const skill = await t.run(
      Teach.use((x) =>
        x.save({ name: "Weekly report", description: "", instructions: "Step one. Step two." }),
      ),
    )
    asked.length = 0
    await t.run(
      Chat.use((c) =>
        c.send({ agentId: t.ada.id, text: "Get the report", replyTo: null, skillId: skill.id }),
      ),
    )
    await until(() => asked.length > 0)
    const body = JSON.parse(asked[0] as string) as { messages: { content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    expect(last.indexOf("Step one. Step two.")).toBeGreaterThanOrEqual(0)
    expect(last.indexOf("Step one.")).toBeLessThan(last.indexOf("Get the report"))
    const history = await t.run(Chat.use((c) => c.history(t.ada.id)))
    expect(messageSkill(history.messages[0] as never)).toEqual({
      kind: "skill",
      name: "Weekly report",
      instructions: "Step one. Step two.",
    })
    // The skill is for Ada only: Bo cannot send its chip.
    expect(
      await t.fails(
        Chat.use((c) => c.send({ agentId: t.bo.id, text: "x", replyTo: null, skillId: skill.id })),
      ),
    ).toBe("skill_unavailable")
    await t.runtime.dispose()
  })
})

describe("teach addresses", () => {
  test("a typed address gets https; other schemes are refused", () => {
    expect(teachAddress("example.com/a")).toBe("https://example.com/a")
    expect(teachAddress("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/")
    expect(teachAddress("file:///etc/passwd")).toBeUndefined()
    expect(teachAddress("javascript:alert(1)")).toBeUndefined()
    expect(teachAddress("two words")).toBeUndefined()
  })
})
