import { afterAll, describe, expect, test } from "bun:test"
import { SKILLS_MAX, skillNameKey } from "@robot/shared"
import { Effect, Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Knowledge } from "./Knowledge.ts"
import { Memory } from "./Memory.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SkillDrafts } from "./SkillDrafts.ts"
import { Skills } from "./Skills.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

const KEY = "sk-skill-draft-test"
/** The bodies of the requests that the stand-in model got. */
const asked: string[] = []
let mode: "answer" | "fail" | "slow" | "empty" | "plain" = "answer"
/** Set while a slow request waits. */
let waiting: (() => void) | undefined

const sse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const raw = await req.text()
    const body = JSON.parse(raw) as { messages: { content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    if (!last.endsWith("Reply with the JSON object only.")) return sse(`Echo: ${last}`)
    asked.push(raw)
    if (mode === "fail") return Response.json({ error: { message: "boom" } }, { status: 500 })
    if (mode === "slow") {
      await new Promise<void>((done) => {
        waiting = done
        req.signal.addEventListener("abort", () => done())
      })
      return sse(JSON.stringify({ name: "Late", description: "", instructions: "Late." }))
    }
    if (mode === "empty") return sse("")
    if (mode === "plain") return sse("1. Open the page.\n2. Press the button.")
    return sse(
      JSON.stringify({
        name: "Weekly report",
        description: "When the user wants the report",
        instructions: "1. Get the file.\n2. Put it in the reports folder.",
      }),
    )
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
  const make = (name: string, model = true) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: "",
          model: model ? { accountId: account.id, model: "mock", effort: null } : null,
        }),
      ),
    )
  const ada = await make("Ada")
  const bo = await make("Bo", false)
  const fails = async <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const exit = await t.runtime.runPromiseExit(effect as never)
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    const reason = exit.cause.reasons.find((r) => r._tag === "Fail") as
      | { error: { code: string } }
      | undefined
    return reason?.error.code
  }
  const db = <T>(read: (db: Parameters<Parameters<typeof Database.use>[0]>[0]) => T) =>
    run(Database.use((d) => Effect.sync(() => read(d))))
  const draft = (source: Parameters<SkillDraftsApi["draft"]>[1], id = crypto.randomUUID()) =>
    run(SkillDrafts.use((d) => d.draft(id, source)))
  /** A task of a chat that is done: a prompt, a reply and two steps of the action log. */
  const doneTask = async (prompt = "Get the weekly report") => {
    await run(Chat.use((c) => c.send({ agentId: ada.id, text: prompt, replyTo: null })))
    await until(async () => {
      const tasks = await run(Tasks.use((x) => x.list(local.id)))
      return tasks.some((x) => x.prompt === prompt && x.state === "done")
    })
    const task = (await run(Tasks.use((x) => x.list(local.id)))).find((x) => x.prompt === prompt)
    if (!task) throw new Error("no task")
    const step = (kind: "shell" | "file", target: string, result: "ran" | "refused" = "ran") =>
      run(
        Tasks.use((x) =>
          Effect.sync(() =>
            x.recordStep({
              agentId: ada.id,
              taskId: task.id,
              kind,
              access: kind === "file" ? "write" : null,
              target,
              result,
              decidedBy: "level",
              outside: null,
              sensitive: null,
            }),
          ),
        ),
      )
    await step("shell", "curl -O https://example.com/report.csv")
    await step("file", "reports/week.md")
    await step("shell", "rm -rf /", "refused")
    return task
  }
  return { ...t, run, local, ada, bo, account, fails, db, draft, doneTask }
}

type SkillDraftsApi = Parameters<typeof SkillDrafts.of>[0]

describe("Make a skill from work: a task", () => {
  test("the request holds the prompt, the steps and the reply, and no output of a tool", async () => {
    mode = "answer"
    const t = await setup()
    const task = await t.doneTask()
    // The reply holds a tool part with an output and a thinking part: neither may reach the model.
    const reply = (await t.run(Tasks.use((x) => x.get(task.id)))).task.messageId
    await t.db((d) =>
      d.run(
        "UPDATE message SET parts = ? WHERE id = ?",
        JSON.stringify([
          { kind: "thinking", text: "THINKING-SENTINEL" },
          {
            kind: "tool",
            id: "c1",
            name: "read_file",
            input: '{"path":"notes.md"}',
            output: "TOOL-OUTPUT-SENTINEL",
            state: "done",
          },
          { kind: "text", text: "Done. The report is in reports/week.md" },
        ]),
        reply,
      ),
    )
    asked.length = 0
    const result = await t.draft({ kind: "task", id: task.id })
    expect(result).toMatchObject({
      agentId: t.ada.id,
      agentName: "Ada",
      outside: false,
      draft: {
        name: "Weekly report",
        description: "When the user wants the report",
        instructions: "1. Get the file.\n2. Put it in the reports folder.",
      },
    })
    expect(asked).toHaveLength(1)
    const request = (JSON.parse(asked[0] as string) as { messages: { content: string }[] }).messages
    const text = request.at(-1)?.content ?? ""
    expect(text).toContain("Get the weekly report")
    expect(text).toContain("- shell: curl -O https://example.com/report.csv")
    expect(text).toContain("- file: reports/week.md")
    expect(text).toContain("Done. The report is in reports/week.md")
    // A refused step did not run.
    expect(text).not.toContain("rm -rf")
    for (const left of ["TOOL-OUTPUT-SENTINEL", "THINKING-SENTINEL"])
      expect(text).not.toContain(left)
    expect(text.length).toBeLessThanOrEqual(20_000)
    await t.runtime.dispose()
  })

  test("it makes no task and no message, and saves no skill", async () => {
    mode = "answer"
    const t = await setup()
    const task = await t.doneTask()
    const before = {
      tasks: (await t.run(Tasks.use((x) => x.list(t.local.id)))).length,
      messages: await t.db((d) => d.get<{ n: number }>("SELECT COUNT(*) AS n FROM message")?.n),
    }
    await t.draft({ kind: "task", id: task.id })
    expect((await t.run(Tasks.use((x) => x.list(t.local.id)))).length).toBe(before.tasks)
    expect(await t.db((d) => d.get<{ n: number }>("SELECT COUNT(*) AS n FROM message")?.n)).toBe(
      before.messages,
    )
    expect(await t.run(Skills.use((s) => s.list(t.local.id)))).toEqual([])
    await t.runtime.dispose()
  })

  test("only a task that is done can make a skill", async () => {
    mode = "answer"
    const t = await setup()
    const task = await t.run(
      Tasks.use((x) =>
        x.create({ agentId: t.ada.id, prompt: "Wait", source: "chat", sourceId: t.ada.id }),
      ),
    )
    expect(await t.fails(SkillDrafts.use((d) => d.draft("a", { kind: "task", id: task.id })))).toBe(
      "skill_task_not_done",
    )
    expect(await t.fails(SkillDrafts.use((d) => d.draft("a", { kind: "task", id: "none" })))).toBe(
      "task_not_found",
    )
    await t.runtime.dispose()
  })

  test("a turn that held outside content sets the flag", async () => {
    mode = "answer"
    const t = await setup()
    const task = await t.doneTask()
    // A step of the action log that was taken while the turn held outside content.
    await t.run(
      Tasks.use((x) =>
        Effect.sync(() =>
          x.recordStep({
            agentId: t.ada.id,
            taskId: task.id,
            kind: "shell",
            access: null,
            target: "echo hi",
            result: "ran",
            decidedBy: "level",
            outside: { kind: "page", host: "example.com" },
            sensitive: null,
          }),
        ),
      ),
    )
    expect((await t.draft({ kind: "task", id: task.id })).outside).toBe(true)
    await t.runtime.dispose()
  })

  test("the outside flag also comes from a step that ended in the reply", async () => {
    mode = "answer"
    const t = await setup()
    const task = await t.doneTask()
    const reply = (await t.run(Tasks.use((x) => x.get(task.id)))).task.messageId
    await t.db((d) =>
      d.run(
        "UPDATE message SET parts = ? WHERE id = ?",
        JSON.stringify([
          {
            kind: "tool",
            id: "c1",
            name: "fetch_url",
            input: '{"url":"https://example.com/p"}',
            output: "page text",
            state: "done",
          },
          { kind: "text", text: "Read it." },
        ]),
        reply,
      ),
    )
    expect((await t.draft({ kind: "task", id: task.id })).outside).toBe(true)
    await t.runtime.dispose()
  })
})

describe("Make a skill from work: an article and a memory item", () => {
  test("an article gives its title, summary and body, for the agent of the article", async () => {
    mode = "answer"
    const t = await setup()
    await t.run(
      Knowledge.use((k) =>
        k.save(t.ada.id, {
          file: null,
          title: "Release steps",
          summary: "How a release goes",
          body: "1. Tag the commit.\n2. Build.",
        }),
      ),
    )
    const list = await t.run(Knowledge.use((k) => k.list(t.ada.id)))
    const file = list.articles[0]?.file as string
    asked.length = 0
    const result = await t.draft({ kind: "article", agentId: t.ada.id, file })
    expect(result.agentId).toBe(t.ada.id)
    const text =
      (JSON.parse(asked[0] as string) as { messages: { content: string }[] }).messages.at(-1)
        ?.content ?? ""
    expect(text).toContain("Release steps")
    expect(text).toContain("How a release goes")
    expect(text).toContain("1. Tag the commit.")
    await t.runtime.dispose()
  })

  test("a memory item gives its text", async () => {
    mode = "answer"
    const t = await setup()
    const item = await t.run(
      Memory.use((m) => m.add(t.ada.id, "Run the linter before a commit", "user")),
    )
    asked.length = 0
    const result = await t.draft({ kind: "memory", id: item.id })
    expect(result.agentId).toBe(t.ada.id)
    const text =
      (JSON.parse(asked[0] as string) as { messages: { content: string }[] }).messages.at(-1)
        ?.content ?? ""
    expect(text).toContain("Run the linter before a commit")
    expect(
      await t.fails(SkillDrafts.use((d) => d.draft("m", { kind: "memory", id: "none" }))),
    ).toBe("memory_not_found")
    await t.runtime.dispose()
  })

  test("a text that looks like a secret is hidden in the request", async () => {
    mode = "answer"
    const t = await setup()
    const item = await t.run(
      Memory.use((m) =>
        m.add(t.ada.id, "Deploy with sk-abcdefghijklmnopqrstuvwxyz123456 always", "user"),
      ),
    )
    asked.length = 0
    await t.draft({ kind: "memory", id: item.id })
    expect(asked[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
    expect(asked[0]).toContain("[redacted]")
    await t.runtime.dispose()
  })

  test("the key of the model account is hidden in the request", async () => {
    mode = "answer"
    const t = await setup()
    const item = await t.run(
      Memory.use((m) => m.add(t.ada.id, `The key is ${KEY} for tests`, "user")),
    )
    asked.length = 0
    await t.draft({ kind: "memory", id: item.id })
    expect(asked[0]).not.toContain(KEY)
    await t.runtime.dispose()
  })
})

describe("Make a skill from work: the answer", () => {
  test("a taken name gets a number", async () => {
    mode = "answer"
    const t = await setup()
    const item = await t.run(Memory.use((m) => m.add(t.ada.id, "A fact", "user")))
    await t.run(
      Skills.use((s) =>
        s.create(t.local.id, { name: "weekly REPORT", description: "", instructions: "x" }, null),
      ),
    )
    const result = await t.draft({ kind: "memory", id: item.id })
    expect(result.draft.name).toBe("Weekly report 2")
    expect(skillNameKey(result.draft.name)).not.toBe(skillNameKey("weekly report"))
    await t.runtime.dispose()
  })

  test("an answer that is not the asked form becomes the instructions", async () => {
    mode = "plain"
    const t = await setup()
    const item = await t.run(
      Memory.use((m) => m.add(t.ada.id, "Open the page and press it", "user")),
    )
    const result = await t.draft({ kind: "memory", id: item.id })
    expect(result.draft.instructions).toBe("1. Open the page.\n2. Press the button.")
    expect(result.draft.name).toBe("Open the page and press it")
    await t.runtime.dispose()
  })

  test("an empty answer fails", async () => {
    mode = "empty"
    const t = await setup()
    const item = await t.run(Memory.use((m) => m.add(t.ada.id, "A fact", "user")))
    expect(
      await t.fails(SkillDrafts.use((d) => d.draft("e", { kind: "memory", id: item.id }))),
    ).toBe("teach_draft_empty")
    await t.runtime.dispose()
  })

  test("a failed request fails with a reason, saves nothing, and can be asked again", async () => {
    mode = "fail"
    const t = await setup()
    const item = await t.run(Memory.use((m) => m.add(t.ada.id, "A fact", "user")))
    const code = await t.fails(
      SkillDrafts.use((d) => d.draft("f", { kind: "memory", id: item.id })),
    )
    expect(code).toBeTruthy()
    expect(await t.run(Skills.use((s) => s.list(t.local.id)))).toEqual([])
    mode = "answer"
    expect((await t.draft({ kind: "memory", id: item.id })).draft.name).toBe("Weekly report")
    await t.runtime.dispose()
  })

  test("an agent with no model account fails the way Teach a task does", async () => {
    mode = "answer"
    const t = await setup()
    const item = await t.run(Memory.use((m) => m.add(t.bo.id, "A fact", "user")))
    expect(
      await t.fails(SkillDrafts.use((d) => d.draft("n", { kind: "memory", id: item.id }))),
    ).toBe("provider_not_connected")
    await t.runtime.dispose()
  })

  test("cancel drops the request: it fails with cancelled and the model call is aborted", async () => {
    mode = "slow"
    waiting = undefined
    const t = await setup()
    const item = await t.run(Memory.use((m) => m.add(t.ada.id, "A fact", "user")))
    const pending = t.runtime.runPromiseExit(
      SkillDrafts.use((d) => d.draft("slow-1", { kind: "memory", id: item.id })),
    )
    await until(() => waiting !== undefined)
    await t.run(SkillDrafts.use((d) => d.cancel("slow-1")))
    const exit = await pending
    expect(Exit.isFailure(exit)).toBe(true)
    const reason = Exit.isFailure(exit)
      ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: { code: string } })
      : undefined
    expect(reason?.error.code).toBe("cancelled")
    expect(await t.run(Skills.use((s) => s.list(t.local.id)))).toEqual([])
    mode = "answer"
    await t.runtime.dispose()
  })
})

describe("Skills: create, list, switch and delete", () => {
  test("a skill for the chosen agents is on, and the picker lists it for those agents only", async () => {
    mode = "answer"
    const t = await setup()
    const made = await t.run(
      Skills.use((s) =>
        s.create(t.local.id, { name: "/Only Ada", description: "d", instructions: "Do it." }, [
          t.ada.id,
        ]),
      ),
    )
    expect(made).toMatchObject({ name: "Only Ada", enabled: true, agentIds: [t.ada.id] })
    await t.run(
      Skills.use((s) =>
        s.create(t.local.id, { name: "For all", description: "", instructions: "x" }, null),
      ),
    )
    const names = async (agentId: string) =>
      (await t.run(Skills.use((s) => s.forAgent(agentId)))).map((s) => s.name)
    expect(await names(t.ada.id)).toEqual(["For all", "Only Ada"])
    expect(await names(t.bo.id)).toEqual(["For all"])
    await t.run(Skills.use((s) => s.setEnabled(made.id, false)))
    expect(await names(t.ada.id)).toEqual(["For all"])
    await t.run(Skills.use((s) => s.remove(made.id)))
    expect((await t.run(Skills.use((s) => s.list(t.local.id)))).map((s) => s.name)).toEqual([
      "For all",
    ])
    await t.runtime.dispose()
  })

  test("the checks of the form: a taken name, an empty list of agents, and 100 skills", async () => {
    mode = "answer"
    const t = await setup()
    const input = { name: "One", description: "", instructions: "x" }
    await t.run(Skills.use((s) => s.create(t.local.id, input, null)))
    expect(
      await t.fails(Skills.use((s) => s.create(t.local.id, { ...input, name: "ONE" }, null))),
    ).toBe("skill_name_taken")
    expect(
      await t.fails(Skills.use((s) => s.create(t.local.id, { ...input, name: "Two" }, []))),
    ).toBe("skill_agents_invalid")
    expect(
      await t.fails(Skills.use((s) => s.create(t.local.id, { ...input, name: "Two" }, ["nobody"]))),
    ).toBe("skill_agents_invalid")
    expect(
      await t.fails(Skills.use((s) => s.create(t.local.id, { ...input, instructions: " " }, null))),
    ).toBeTruthy()
    for (let i = 1; i < SKILLS_MAX; i++)
      await t.run(Skills.use((s) => s.create(t.local.id, { ...input, name: `S${i}` }, null)))
    expect(
      await t.fails(Skills.use((s) => s.create(t.local.id, { ...input, name: "Over" }, null))),
    ).toBe("skills_full")
    await t.runtime.dispose()
  })

  test("the draft request still works with 100 skills; only Save refuses", async () => {
    mode = "answer"
    const t = await setup()
    const item = await t.run(Memory.use((m) => m.add(t.ada.id, "A fact", "user")))
    for (let i = 0; i < SKILLS_MAX; i++)
      await t.run(
        Skills.use((s) =>
          s.create(t.local.id, { name: `S${i}`, description: "", instructions: "x" }, null),
        ),
      )
    const result = await t.draft({ kind: "memory", id: item.id })
    expect(result.draft.name).toBe("Weekly report")
    expect(
      await t.fails(Skills.use((s) => s.create(t.local.id, result.draft, [result.agentId]))),
    ).toBe("skills_full")
    await t.runtime.dispose()
  })
})

describe("the request waits for nobody", () => {
  test("the draft event is not needed: a call returns when the model has answered", async () => {
    mode = "answer"
    const t = await setup()
    const item = await t.run(Memory.use((m) => m.add(t.ada.id, "A fact", "user")))
    const result = await t.draft({ kind: "memory", id: item.id })
    expect(result.draft.instructions).toContain("reports folder")
    await t.runtime.dispose()
  })
})
