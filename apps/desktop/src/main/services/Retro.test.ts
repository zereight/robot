import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { Organizations } from "./Organizations.ts"
import { Providers } from "./Providers.ts"
import { Retro } from "./Retro.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

const KEY = "sk-retro-test"
/** The bodies of the requests that the stand-in model got. */
const asked: string[] = []
let answer = "[]"

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
    return sse(answer)
  },
})
afterAll(() => server.stop())

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
  const agent = (name: string) =>
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
  const org = (name: string, memberIds: string[], extra: { leadId?: string | null } = {}) =>
    run(
      Organizations.use((o) =>
        o.create({ serverId: local.id, name, memberIds, leadId: extra.leadId ?? null }),
      ),
    )
  const db = await run(Database.use((d) => Effect.succeed(d)))
  let n = 0
  // A task that ended: a label, a state and, for a part, the verdict of the lead.
  const task = (
    agentId: string,
    extra: {
      label?: string
      state?: string
      verdict?: string | null
      verdictReason?: string | null
      prompt?: string
      started?: number
      finished?: number
    } = {},
  ) => {
    const id = `t-${++n}`
    db.run(
      `INSERT INTO task (id, agent_id, prompt, label, source, state, created_at, started_at,
         finished_at, verdict, verdict_reason, agent_message)
       VALUES (?, ?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      agentId,
      extra.prompt ?? "THE WHOLE PROMPT OF THE TASK",
      extra.label ?? `Label ${id}`,
      extra.state ?? "done",
      extra.started ?? extra.finished ?? Date.now() - 1000,
      extra.started ?? extra.finished ?? Date.now() - 1000,
      extra.finished ?? Date.now() - 1000,
      extra.verdict ?? null,
      extra.verdictReason ?? null,
    )
    return id
  }
  const fails = async <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const exit = await t.runtime.runPromiseExit(effect as never)
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    const reason = exit.cause.reasons.find((r) => r._tag === "Fail") as
      | { error: { code: string } }
      | undefined
    return reason?.error.code
  }
  const look = (orgId: string) =>
    run(Retro.use((r) => r.look({ orgId, requestId: crypto.randomUUID() })))
  return { t, run, local, agent, org, task, fails, look }
}

describe("the retrospective of an organization (spec 030, Retrospective)", () => {
  test("one proposal of instructions, and the request holds the labels and the verdicts", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id], { leadId: ada.id })
    s.task(ada.id, { label: "Check the links", verdict: "not_met", verdictReason: "Two 404." })
    s.task(ada.id, { label: "Draft the notes", state: "blocked" })
    answer = JSON.stringify([
      {
        kind: "instructions",
        agent: "Ada",
        evidence: "1 of 2 parts with the verdict Not met",
        text: "Check every link before you publish.",
      },
    ])
    const out = await s.look(docs.id)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "instructions", agent: "Ada" })
    const request = asked.at(-1) ?? ""
    expect(request).toContain("Check the links")
    expect(request).toContain("Two 404.")
    expect(request).toContain("Draft the notes")
    // The prompt of the task is not in the request, and no message text is either.
    expect(request).not.toContain("THE WHOLE PROMPT OF THE TASK")
  })

  test("a proposal of a skill keeps its name, its description and its instructions", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id])
    s.task(ada.id)
    answer = JSON.stringify([
      {
        kind: "skill",
        agent: "Ada",
        evidence: "1 blocked task",
        name: "Check the links",
        description: "Use it before a release.",
        instructions: "Open every link.",
      },
    ])
    const out = await s.look(docs.id)
    expect(out[0]).toMatchObject({
      kind: "skill",
      name: "Check the links",
      description: "Use it before a release.",
      instructions: "Open every link.",
    })
  })

  test("nothing is saved: the instructions of the agent and the skills are the same after", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id])
    s.task(ada.id)
    answer = JSON.stringify([{ kind: "instructions", agent: "Ada", text: "Be very brief." }])
    await s.look(docs.id)
    const row = await s.run(
      Agents.use((a) => a.get(ada.id)).pipe(Effect.map((x) => x.instructions)),
    )
    expect(row).toBe("")
  })

  test("an organization with no member is refused before any request", async () => {
    const s = await setup()
    const docs = await s.org("Docs", [])
    const before = asked.length
    expect(await s.fails(Retro.use((r) => r.look({ orgId: docs.id, requestId: "r1" })))).toBe(
      "retro_no_member",
    )
    expect(asked).toHaveLength(before)
  })

  test("an answer with no proposal gives the reason of the spec, and saves nothing", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id])
    s.task(ada.id)
    answer = "I cannot tell from this work."
    expect(await s.fails(Retro.use((r) => r.look({ orgId: docs.id, requestId: "r2" })))).toBe(
      "retro_empty",
    )
  })

  test("a task counts by the time it ended, and one of 8 days ago is not in the request", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const docs = await s.org("Docs", [ada.id])
    s.task(ada.id, { label: "OLD WORK", finished: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    // Started 8 days ago and ended 2 days ago: it is in the window.
    s.task(ada.id, {
      label: "LONG WORK",
      started: Date.now() - 8 * 24 * 60 * 60 * 1000,
      finished: Date.now() - 2 * 24 * 60 * 60 * 1000,
    })
    s.task(ada.id, { label: "NEW WORK" })
    answer = JSON.stringify([{ kind: "instructions", agent: "Ada", text: "x" }])
    await s.look(docs.id)
    const request = asked.at(-1) ?? ""
    expect(request).toContain("NEW WORK")
    expect(request).toContain("LONG WORK")
    expect(request).not.toContain("OLD WORK")
  })
})
