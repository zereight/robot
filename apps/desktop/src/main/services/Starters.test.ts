import { afterAll, describe, expect, test } from "bun:test"
import {
  type Agent,
  type AgentStarterCreate,
  messageText,
  ROUTINES_MAX,
  SKILLS_MAX,
  type StarterId,
  starterText,
} from "@robot/shared"
import { Effect, Exit } from "effect"
import { runRequest } from "../rpc.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Servers } from "./Servers.ts"
import { Starters } from "./Starters.ts"
import { testRuntime } from "./testing.ts"

/** The bodies of the requests that the stand-in model got. */
const requests: string[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    requests.push(await req.text())
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." } }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
afterAll(() => server.stop())

const failCode = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

interface SkillRow {
  id: string
  name: string
  description: string
  instructions: string
  agents: string | null
  enabled: number
}

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  /** The request of the window: the strings of the starter in the language of the pick. */
  const form = (name: string, id: StarterId, locale: "en" | "ko" = "en"): AgentStarterCreate => {
    const text = starterText(locale, id)
    return {
      serverId: local.id,
      name,
      role: text.role,
      instructions: text.instructions,
      starter: { routine: text.routine, skill: text.skill },
    }
  }
  const make = (name: string, id: StarterId, locale: "en" | "ko" = "en") =>
    run(Starters.use((s) => s.create(form(name, id, locale))))
  const routines = () => run(Routines.use((r) => r.list(local.id)))
  const skills = () =>
    run(
      Database.use((db) =>
        Effect.sync(() =>
          db.all<SkillRow>(
            "SELECT id, name, description, instructions, agents, enabled FROM skill ORDER BY created_at, rowid",
          ),
        ),
      ),
    )
  /** The ids of the agents that a skill is for. */
  const agentsOf = (skill: SkillRow) => JSON.parse(skill.agents ?? "null") as string[] | null
  const messages = async (agent: Agent) =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages
  const plain = (name: string) =>
    run(Agents.use((a) => a.create({ serverId: local.id, name, role: "", instructions: "" })))
  /** Fills the server up to `count` routines, all paused, with a plain agent. */
  const fillRoutines = async (count: number) => {
    const filler = await plain("Filler")
    for (let n = 0; n < count; n++)
      await run(
        Routines.use((r) =>
          r.create(
            {
              serverId: local.id,
              agentId: filler.id,
              name: `Filler ${n}`,
              prompt: "x",
              schedule: { kind: "daily", times: ["09:00"] },
              place: { kind: "agent" },
            },
            { paused: true },
          ),
        ),
      )
  }
  /** Fills the server up to `count` skills for all agents. */
  const fillSkills = (count: number) =>
    run(
      Database.use((db) =>
        Effect.sync(() => {
          for (let n = 0; n < count; n++)
            db.run(
              `INSERT INTO skill (id, server_id, name, name_key, description, instructions, agents, enabled, created_at)
               VALUES (?, ?, ?, ?, '', 'x', NULL, 1, ?)`,
              `filler-${n}`,
              local.id,
              `Filler skill ${n}`,
              `filler skill ${n}`,
              n,
            )
        }),
      ),
    )
  return {
    ...t,
    run,
    local,
    form,
    make,
    plain,
    routines,
    skills,
    agentsOf,
    messages,
    fillRoutines,
    fillSkills,
  }
}

describe("a starter makes its extra setup on Create", () => {
  test("the Briefer makes a paused routine and one skill that is for its agent only", async () => {
    const s = await setup()
    const agent = await s.make("Morning", "briefer")
    const text = starterText("en", "briefer")
    expect(agent.role).toBe(text.role)
    expect(agent.instructions).toBe(text.instructions)

    const routines = await s.routines()
    expect(routines).toHaveLength(1)
    expect(routines[0]).toMatchObject({
      agentId: agent.id,
      name: "Weekday briefing",
      prompt: text.routine?.prompt,
      enabled: false,
      place: { kind: "agent" },
      schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
      watch: null,
      model: null,
      nextRuns: [],
    })

    const skills = await s.skills()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: "Brief me now",
      description: text.skill?.description,
      instructions: text.skill?.instructions,
      enabled: 1,
    })
    expect(s.agentsOf(skills[0] as SkillRow)).toEqual([agent.id])
    // Nothing was left out, so the chat holds no note.
    expect(await s.messages(agent)).toEqual([])
    await s.runtime.dispose()
  })

  test("the routine is paused, so it does not run until the user turns it on", async () => {
    const s = await setup()
    await s.make("Morning", "briefer")
    const [routine] = await s.routines()
    // The next Monday after now, at 08:00 and 30 seconds.
    const monday = new Date()
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7))
    monday.setHours(8, 0, 30, 0)
    const traces = () =>
      s.run(
        Database.use((db) =>
          Effect.sync(
            () =>
              (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE source = 'routine'")
                ?.n ?? 0) +
              (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM routine_skip")?.n ?? 0),
          ),
        ),
      )
    await s.run(Routines.use((r) => r.tick(monday.getTime())))
    expect(await traces()).toBe(0)
    // The control: the same tick leaves a trace once the user turns the routine on.
    await s.run(Routines.use((r) => r.update(routine?.id as string, { enabled: true })))
    await s.run(Routines.use((r) => r.tick(monday.getTime())))
    expect(await traces()).toBeGreaterThan(0)
    await s.runtime.dispose()
  })

  test("a starter sets no model, permission level, memory or knowledge", async () => {
    const s = await setup()
    const agent = await s.make("Ada", "reviewer")
    const plain = await s.plain("Plain")
    expect(agent.model).toBeNull()
    expect(agent.permission).toBe(plain.permission)
    expect(agent.memoryEnabled).toBe(plain.memoryEnabled)
    expect(agent.knowledgeEnabled).toBe(plain.knowledgeEnabled)
    expect(agent.workspace).not.toBe("")
    // A starter makes no memory item and no article.
    const counts = await s.run(
      Database.use((db) =>
        Effect.sync(() => ({
          memory: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory")?.n,
          files: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_file")?.n,
        })),
      ),
    )
    expect(counts).toEqual({ memory: 0, files: 0 })
    await s.runtime.dispose()
  })

  test("the Assistant makes no routine and no skill", async () => {
    const s = await setup()
    const agent = await s.make("Helper", "assistant")
    expect(await s.routines()).toEqual([])
    expect(await s.skills()).toEqual([])
    expect(await s.messages(agent)).toEqual([])
    await s.runtime.dispose()
  })

  test("each other starter makes one skill and no routine", async () => {
    const s = await setup()
    const made = [
      ["Rina", "researcher"],
      ["Rex", "reviewer"],
      ["Olive", "organizer"],
    ] as const
    const agents: Agent[] = []
    for (const [name, id] of made) agents.push(await s.make(name, id))
    expect(await s.routines()).toEqual([])
    const skills = await s.skills()
    expect(skills.map((k) => k.name)).toEqual([
      "Check a claim",
      "Review latest change",
      "Tidy a folder",
    ])
    for (const [index, skill] of skills.entries())
      expect(s.agentsOf(skill)).toEqual([agents[index]?.id as string])
    await s.runtime.dispose()
  })

  test("two agents from Researcher: the second skill gets a number, and each is for its own agent", async () => {
    const s = await setup()
    const first = await s.make("Rina", "researcher")
    const second = await s.make("Ruth", "researcher")
    const skills = await s.skills()
    expect(skills.map((k) => k.name)).toEqual(["Check a claim", "Check a claim 2"])
    expect(s.agentsOf(skills[0] as SkillRow)).toEqual([first.id])
    expect(s.agentsOf(skills[1] as SkillRow)).toEqual([second.id])
    await s.runtime.dispose()
  })

  test("a taken skill name gets a number, ignoring case", async () => {
    const s = await setup()
    await s.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.run(
            `INSERT INTO skill (id, server_id, name, name_key, description, instructions, agents, enabled, created_at)
             VALUES ('own', ?, 'CHECK A CLAIM', 'check a claim', '', 'x', NULL, 1, 1)`,
            s.local.id,
          ),
        ),
      ),
    )
    await s.make("Rina", "researcher")
    expect((await s.skills()).map((k) => k.name)).toEqual(["CHECK A CLAIM", "Check a claim 2"])
    await s.runtime.dispose()
  })

  test("the text follows the language of the pick", async () => {
    const s = await setup()
    const agent = await s.make("준비", "briefer", "ko")
    const ko = starterText("ko", "briefer")
    const [routine] = await s.routines()
    expect(routine).toMatchObject({ name: ko.routine?.name, prompt: ko.routine?.prompt })
    const [skill] = await s.skills()
    expect(skill).toMatchObject({ name: ko.skill?.name, instructions: ko.skill?.instructions })
    expect(s.agentsOf(skill as SkillRow)).toEqual([agent.id])
    await s.runtime.dispose()
  })

  test("a form that fails makes no agent, no routine and no skill", async () => {
    const s = await setup()
    await s.make("Rina", "researcher")
    const exit = await s.runtime.runPromiseExit(
      Starters.use((x) => x.create(s.form("rina", "briefer"))) as never,
    )
    expect(failCode(exit as never)).toBe("agent_name_taken")
    expect(await s.routines()).toEqual([])
    expect(await s.skills()).toHaveLength(1)
    await s.runtime.dispose()
  })
})

describe("the request carries the strings, and the main process checks them", () => {
  const send = (s: Awaited<ReturnType<typeof setup>>, input: unknown, actor = null) =>
    runRequest(s.runtime, "agents.createFromStarter", input, actor)
  const names = (s: Awaited<ReturnType<typeof setup>>) =>
    s.run(Agents.use((a) => a.list(s.local.id, false))).then((list) => list.map((x) => x.name))

  test("a request from the window makes the agent, the routine and the skill from its strings", async () => {
    const s = await setup()
    const request = {
      ...s.form("Morning", "briefer"),
      starter: {
        routine: { name: "Own routine", prompt: "Own prompt." },
        skill: { name: "Own skill", description: "Own line.", instructions: "Own steps." },
      },
    }
    const result = await send(s, request)
    expect(result.ok).toBe(true)
    expect(await s.routines()).toMatchObject([
      { name: "Own routine", prompt: "Own prompt.", enabled: false },
    ])
    expect(await s.skills()).toMatchObject([
      { name: "Own skill", description: "Own line.", instructions: "Own steps." },
    ])
    await s.runtime.dispose()
  })

  test("a wrong string makes nothing: no agent, no routine, no skill", async () => {
    const s = await setup()
    const base = s.form("Morning", "briefer")
    const skill = base.starter.skill as NonNullable<typeof base.starter.skill>
    const routine = base.starter.routine as NonNullable<typeof base.starter.routine>
    const wrong = [
      { routine: { ...routine, name: "" }, skill },
      { routine: { ...routine, name: "x".repeat(61) }, skill },
      { routine: { ...routine, prompt: " " }, skill },
      { routine: { ...routine, prompt: "x".repeat(20_001) }, skill },
      { routine, skill: { ...skill, name: "" } },
      { routine, skill: { ...skill, name: "x".repeat(41) } },
      { routine, skill: { ...skill, description: "x".repeat(141) } },
      { routine, skill: { ...skill, instructions: "" } },
      { routine, skill: { ...skill, instructions: "x".repeat(20_001) } },
      { routine: "Weekday briefing", skill },
      { skill },
    ]
    for (const starter of wrong) {
      const result = await send(s, { ...base, starter })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe("invalid_input")
    }
    expect(await names(s)).toEqual([])
    expect(await s.routines()).toEqual([])
    expect(await s.skills()).toEqual([])
    await s.runtime.dispose()
  })

  test("a request cannot make a routine that is on, or change its schedule or place", async () => {
    const s = await setup()
    const base = s.form("Morning", "briefer")
    const result = await send(s, {
      ...base,
      starter: {
        routine: {
          ...base.starter.routine,
          enabled: true,
          schedule: { kind: "every", minutes: 1, from: 0 },
          place: { kind: "channel", channelId: "c" },
        },
        skill: { ...base.starter.skill, enabled: false, agentIds: null },
      },
    })
    expect(result.ok).toBe(true)
    const agent = (await s.run(Agents.use((a) => a.list(s.local.id, false))))[0]
    const [routine] = await s.routines()
    expect(routine).toMatchObject({
      agentId: agent?.id,
      enabled: false,
      place: { kind: "agent" },
      schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
    })
    const [skill] = await s.skills()
    expect(skill?.enabled).toBe(1)
    expect(s.agentsOf(skill as SkillRow)).toEqual([agent?.id as string])
    await s.runtime.dispose()
  })

  test("a linked device cannot send the request", async () => {
    const s = await setup()
    const result = await send(s, s.form("Morning", "briefer"), {
      id: "dev",
      name: "Phone",
    } as never)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("not_allowed")
    expect(await names(s)).toEqual([])
    expect(await s.routines()).toEqual([])
    expect(await s.skills()).toEqual([])
    await s.runtime.dispose()
  })

  test("the note names the part as the app keeps it: trimmed, with no slash", async () => {
    const s = await setup()
    await s.fillRoutines(ROUTINES_MAX)
    await s.fillSkills(SKILLS_MAX)
    const agent = await s.run(
      Starters.use((x) =>
        x.create({
          ...s.form("Morning", "briefer"),
          starter: {
            routine: { name: "  Padded routine  ", prompt: "Go." },
            skill: { name: " /Slash skill ", description: "", instructions: "Go." },
          },
        }),
      ),
    )
    const names = (await s.messages(agent)).flatMap((m) =>
      m.parts.map((p) => (p.kind === "note" && p.note === "starter_not_made" ? p.name : "")),
    )
    expect(names).toEqual(["Padded routine", "Slash skill"])
    await s.runtime.dispose()
  })
})

describe("a limit stops one part, and a note in the chat says why", () => {
  test("at 50 routines the agent is made without its routine, and the skill is made", async () => {
    const s = await setup()
    await s.fillRoutines(ROUTINES_MAX)
    const agent = await s.make("Morning", "briefer")
    expect(agent.name).toBe("Morning")
    expect(await s.routines()).toHaveLength(ROUTINES_MAX)
    expect((await s.skills()).map((k) => k.name)).toEqual(["Brief me now"])

    const messages = await s.messages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.author).toBe("agent")
    expect(messages[0]?.parts).toEqual([
      {
        kind: "note",
        note: "starter_not_made",
        what: "routine",
        name: "Weekday briefing",
        why: "limit",
      },
    ])
    await s.runtime.dispose()
  })

  test("at 49 routines the routine is made", async () => {
    const s = await setup()
    await s.fillRoutines(ROUTINES_MAX - 1)
    const agent = await s.make("Morning", "briefer")
    expect(await s.routines()).toHaveLength(ROUTINES_MAX)
    expect(await s.messages(agent)).toEqual([])
    await s.runtime.dispose()
  })

  test("at 100 skills the agent is made without its skill, and the routine is made", async () => {
    const s = await setup()
    await s.fillSkills(SKILLS_MAX)
    const agent = await s.make("Morning", "briefer")
    expect(agent.name).toBe("Morning")
    expect(await s.skills()).toHaveLength(SKILLS_MAX)
    expect((await s.routines()).map((r) => r.name)).toEqual(["Weekday briefing"])

    const messages = await s.messages(agent)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.parts).toEqual([
      {
        kind: "note",
        note: "starter_not_made",
        what: "skill",
        name: "Brief me now",
        why: "limit",
      },
    ])
    await s.runtime.dispose()
  })

  test("at both limits two notes say what was not made, the routine first", async () => {
    const s = await setup()
    await s.fillRoutines(ROUTINES_MAX)
    await s.fillSkills(SKILLS_MAX)
    const agent = await s.make("Morning", "briefer")
    const messages = await s.messages(agent)
    expect(messages.map((m) => m.parts)).toEqual([
      [
        {
          kind: "note",
          note: "starter_not_made",
          what: "routine",
          name: "Weekday briefing",
          why: "limit",
        },
      ],
      [
        {
          kind: "note",
          note: "starter_not_made",
          what: "skill",
          name: "Brief me now",
          why: "limit",
        },
      ],
    ])
    await s.runtime.dispose()
  })

  test("the note is a message with no model, and the model never reads it", async () => {
    const s = await setup()
    const account = await s.run(
      Providers.use((p) =>
        p.connect({
          kind: "custom",
          name: "M",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: "sk-starters-test",
        }),
      ),
    )
    await s.fillRoutines(ROUTINES_MAX)
    const agent = await s.run(
      Starters.use((x) =>
        x.create({
          ...s.form("Morning", "briefer"),
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
    const [note] = await s.messages(agent)
    expect(note?.model ?? null).toBeNull()

    await s.run(Chat.use((c) => c.send({ agentId: agent.id, text: "Hi there", replyTo: null })))
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 300 && !(await check()); i++) await Bun.sleep(10)
    }
    await until(async () => requests.length > 0)
    await until(async () => (await s.messages(agent)).length >= 3)
    const sent = requests.at(-1) ?? ""
    expect(sent).toContain("Hi there")
    expect(sent).not.toContain("Weekday briefing")
    expect(sent).not.toContain("Not made")
    const history = await s.messages(agent)
    expect(history.map(messageText).join("\n")).toContain("Hello.")
    await s.runtime.dispose()
  })
})
