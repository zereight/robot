import { afterAll, describe, expect, test } from "bun:test"
import { messageSkill, messageText } from "@robot/shared"
import { Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Skills } from "./Skills.ts"
import { testRuntime } from "./testing.ts"

// The skill chip of a message (spec 017, "Rules"): the message stores the name and a copy of the
// instructions at the time of sending. A later edit or delete of the skill does not change it.
// Edit of the last message, Retry and a queued message keep the chip and its copy.

const KEY = "sk-chat-skills-test"
/** The last message of each request that reached the model. */
const asked: string[] = []
/** The system text of each request that reached the model. */
const systems: string[] = []
let failNext = false

const sse = (text: string, slow = false) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        const parts = slow ? Array.from({ length: 30 }, (_, i) => `w${i} `) : [text]
        for (const part of parts) {
          if (slow) await Bun.sleep(25)
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`),
          )
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    asked.push(last)
    systems.push(body.messages.find((m) => m.role === "system")?.content ?? "")
    if (last.endsWith("fail") && failNext) {
      failNext = false
      return Response.json({ error: { message: "boom" } }, { status: 500 })
    }
    return sse(`Echo: ${last}`, last.endsWith("go slow"))
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const setup = async () => {
  asked.length = 0
  systems.length = 0
  failNext = false
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
  const agent = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: { accountId: account.id, model: "mock", effort: null },
      }),
    ),
  )
  const skill = await run(
    Skills.use((s) =>
      s.create(
        local.id,
        { name: "Weekly summary", description: "", instructions: "OLD STEPS" },
        null,
      ),
    ),
  )
  const history = () => run(Chat.use((c) => c.history(agent.id)))
  const send = (text: string, skillId?: string) =>
    run(
      Chat.use((c) =>
        c.send({ agentId: agent.id, text, replyTo: null, ...(skillId ? { skillId } : {}) }),
      ),
    )
  const settled = () =>
    until(async () => {
      const h = await history()
      return (
        h.messages.length > 0 &&
        h.messages.every((m) => m.status !== "streaming") &&
        h.queue.length === 0
      )
    })
  const change = (instructions: string) =>
    run(
      Skills.use((s) =>
        s.update(skill.id, { name: "Weekly summary", description: "", instructions }, null),
      ),
    )
  const remove = () => run(Skills.use((s) => s.remove(skill.id)))
  return { ...t, run, agent, skill, history, send, settled, change, remove, local }
}

/** The chip of a message, without its kind. */
const chipOf = (message: { parts: readonly unknown[] }) => {
  const chip = messageSkill(message as never)
  return chip ? { name: chip.name, instructions: chip.instructions } : undefined
}

describe("the skill chip of a message (spec 017)", () => {
  test("the message keeps the name and the copy; the agent reads the instructions first", async () => {
    const t = await setup()
    await t.send("for the team", t.skill.id)
    await t.settled()
    await t.change("NEW STEPS")
    await t.remove()
    const [user] = (await t.history()).messages
    expect(chipOf(user as never)).toEqual({ name: "Weekly summary", instructions: "OLD STEPS" })
    expect(messageText(user as never)).toBe("for the team")
    const sent = asked[0] as string
    expect(sent.indexOf("OLD STEPS")).toBeGreaterThanOrEqual(0)
    expect(sent.indexOf("OLD STEPS")).toBeLessThan(sent.indexOf("for the team"))
    await t.runtime.dispose()
  })

  test("the chip alone is a message", async () => {
    const t = await setup()
    await t.send("", t.skill.id)
    await t.settled()
    const [user, reply] = (await t.history()).messages
    expect(chipOf(user as never)).toEqual({ name: "Weekly summary", instructions: "OLD STEPS" })
    expect(messageText(user as never)).toBe("")
    expect(reply?.status).toBe("done")
    expect(asked[0]).toContain("OLD STEPS")
    await t.runtime.dispose()
  })

  test("a message with no text, no file and no chip is refused", async () => {
    const t = await setup()
    const exit = await t.runtime.runPromiseExit(
      Chat.use((c) => c.send({ agentId: t.agent.id, text: "  ", replyTo: null })),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect((await t.history()).messages).toHaveLength(0)
    await t.runtime.dispose()
  })

  test("Edit of the last message keeps its chip and its copy, though the skill changed and went", async () => {
    const t = await setup()
    await t.send("plan it", t.skill.id)
    await t.settled()
    await t.change("NEW STEPS")
    await t.remove()
    const [user] = (await t.history()).messages
    await t.run(Chat.use((c) => c.edit(t.agent.id, user?.id ?? "", "plan it better")))
    await t.settled()
    const { messages } = await t.history()
    expect(messages).toHaveLength(2)
    expect(chipOf(messages[0] as never)).toEqual({
      name: "Weekly summary",
      instructions: "OLD STEPS",
    })
    expect(messageText(messages[0] as never)).toBe("plan it better")
    const again = asked.at(-1) as string
    expect(again).toContain("OLD STEPS")
    expect(again).not.toContain("NEW STEPS")
    expect(again.indexOf("OLD STEPS")).toBeLessThan(again.indexOf("plan it better"))
    await t.runtime.dispose()
  })

  test("Retry keeps the chip and its copy, though the skill changed and went", async () => {
    const t = await setup()
    failNext = true
    await t.send("please fail", t.skill.id)
    await t.settled()
    let { messages } = await t.history()
    expect(messages[1]?.status).toBe("failed")
    await t.change("NEW STEPS")
    await t.remove()
    await t.run(Chat.use((c) => c.retry(t.agent.id, messages[1]?.id ?? "")))
    await t.settled()
    ;({ messages } = await t.history())
    expect(messages.map((m) => m.status)).toEqual(["done", "done"])
    expect(chipOf(messages[0] as never)).toEqual({
      name: "Weekly summary",
      instructions: "OLD STEPS",
    })
    const retried = asked.at(-1) as string
    expect(retried).toContain("OLD STEPS")
    expect(retried).not.toContain("NEW STEPS")
    await t.runtime.dispose()
  })

  test("a queued message keeps its chip with the copy of the time of sending", async () => {
    const t = await setup()
    await t.run(SettingsStore.use((s) => s.update({ duringTurn: "queue" })))
    await t.send("go slow")
    expect((await t.send("second", t.skill.id)).queued).toBe(true)
    const { queue } = await t.history()
    expect(queue[0]?.skill).toMatchObject({ name: "Weekly summary", instructions: "OLD STEPS" })
    // The skill changes and goes while the message waits. Edit of the queued text keeps the chip.
    await t.change("NEW STEPS")
    await t.remove()
    await t.run(Chat.use((c) => c.updateQueued(t.agent.id, queue[0]?.id ?? "", "second, edited")))
    await t.settled()
    const { messages } = await t.history()
    const second = messages.find((m) => messageText(m) === "second, edited")
    expect(chipOf(second as never)).toEqual({ name: "Weekly summary", instructions: "OLD STEPS" })
    const got = asked.find((c) => c.includes("second, edited")) as string
    expect(got).toContain("OLD STEPS")
    expect(got).not.toContain("NEW STEPS")
    await t.runtime.dispose()
  })

  test("the turn reads the names and notes of usable skills, never the instructions", async () => {
    const t = await setup()
    await t.run(
      Skills.use((s) =>
        s.create(
          t.local.id,
          { name: "Briefer", description: "Ask for a briefing now.", instructions: "BRIEF STEPS" },
          null,
        ),
      ),
    )
    const other = await t.run(
      Agents.use((a) =>
        a.create({ serverId: t.local.id, name: "Bo", role: "", instructions: "", model: null }),
      ),
    )
    await t.run(
      Skills.use((s) =>
        s.create(
          t.local.id,
          { name: "Foreign", description: "Not yours.", instructions: "FOREIGN STEPS" },
          [other.id],
        ),
      ),
    )
    await t.send("hello", t.skill.id)
    await t.settled()
    const system = systems.at(-1) as string
    expect(system).toContain('"Briefer": Ask for a briefing now.')
    expect(system).not.toContain("BRIEF STEPS")
    expect(system).not.toContain("Foreign")
    expect(system).not.toContain("FOREIGN STEPS")
    // The setup skill has no note: slash only.
    expect(system).not.toContain("Weekly summary")
    // The chip still goes first in the message.
    const sent = asked.at(-1) as string
    expect(sent.indexOf("OLD STEPS")).toBeLessThan(sent.indexOf("hello"))
  })

  test("a chip that is off, deleted or for another agent is refused, and nothing is stored", async () => {
    const t = await setup()
    const code = async (skillId: string) => {
      const exit = await t.runtime.runPromiseExit(
        Chat.use((c) => c.send({ agentId: t.agent.id, text: "x", replyTo: null, skillId })),
      )
      if (Exit.isSuccess(exit)) return "ok"
      return exit.cause.reasons
        .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
        .join()
    }
    await t.run(Skills.use((s) => s.setEnabled(t.skill.id, false)))
    expect(await code(t.skill.id)).toBe("skill_unavailable")
    await t.run(Skills.use((s) => s.setEnabled(t.skill.id, true)))
    const other = await t.run(
      Agents.use((a) =>
        a.create({ serverId: t.local.id, name: "Bo", role: "", instructions: "", model: null }),
      ),
    )
    await t.run(
      Skills.use((s) =>
        s.update(
          t.skill.id,
          { name: "Weekly summary", description: "", instructions: "OLD STEPS" },
          [other.id],
        ),
      ),
    )
    expect(await code(t.skill.id)).toBe("skill_unavailable")
    await t.remove()
    expect(await code(t.skill.id)).toBe("skill_unavailable")
    expect((await t.history()).messages).toHaveLength(0)
    expect(asked).toHaveLength(0)
    await t.runtime.dispose()
  })
})
