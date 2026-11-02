import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Notifier } from "./Notifier.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

const sse = (parts: { delay: number; data: unknown }[]) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        for (const p of parts) {
          await Bun.sleep(p.delay)
          controller.enqueue(
            enc.encode(`data: ${typeof p.data === "string" ? p.data : JSON.stringify(p.data)}\n\n`),
          )
        }
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
const text = (content: string, delay = 0) => ({
  delay,
  data: { choices: [{ delta: { content } }] },
})

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      messages: { role: string; content: string }[]
      tools?: unknown[]
    }
    const last = body.messages.at(-1)
    if (last?.role === "tool") return sse([text("ok"), { delay: 0, data: "[DONE]" }])
    const content = last?.content ?? ""
    if (content.includes("FAIL"))
      return Response.json({ error: { message: "boom" } }, { status: 500 })
    const call = /TOOL (\w+) (\{.*\})/.exec(content)
    if (call && body.tools)
      return sse([
        {
          delay: 0,
          data: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: call[1], arguments: call[2] } },
                  ],
                },
              },
            ],
          },
        },
        { delay: 0, data: "[DONE]" },
      ])
    if (content.includes("SLOW"))
      return sse([
        ...Array.from({ length: 40 }, () => text("tick ", 30)),
        { delay: 0, data: "[DONE]" },
      ])
    if (content.includes("PING"))
      return sse([text("Hi @you, I am done"), { delay: 0, data: "[DONE]" }])
    return sse([text("All done"), { delay: 0, data: "[DONE]" }])
  },
})
afterAll(() => server.stop())

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
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
        apiKey: "sk-notify-test-key",
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
        instructions: "Work.",
        model: { accountId: account.id, model: "mock", effort: null },
      }),
    ),
  )
  const send = (message: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text: message, replyTo: null })))
  const idle = () =>
    until(async () =>
      (await run(Tasks.use((x) => x.list(local.id)))).every(
        (x) => !["queued", "running", "waiting"].includes(x.state),
      ),
    )
  const island = () => run(Notifier.use((n) => Effect.succeed(n.island())))
  const addAgent = (name: string) =>
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
  const sendTo = (agentId: string, message: string) =>
    run(Chat.use((c) => c.send({ agentId, text: message, replyTo: null })))
  const setIsland = (island: "off" | "attention" | "always") =>
    run(SettingsStore.use((x) => x.update({ island })))
  return { t, run, local, agent, send, sendTo, addAgent, setIsland, idle, island }
}

describe("system notifications", () => {
  test("a reply shows a notification only while no window has the focus", async () => {
    const s = await setup()
    await s.send("hello")
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(0)
    s.t.shell.focused = false
    await s.send("hello again")
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(1)
    expect(s.t.shell.notices[0]).toMatchObject({ title: "Ada", body: "All done" })
  })

  test("a click shows the window and opens the place at the message", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.send("hello")
    await s.idle()
    s.t.shell.notices[0]?.click()
    expect(s.t.shell.shown).toBe(1)
    const opened = s.t.events.find((e) => e.event === "app.openPlace")
    expect(opened?.payload).toMatchObject({ kind: "agent", id: s.agent.id })
    expect(opened?.payload).toHaveProperty("messageId")
  })

  test("a kind that is off, or a muted server or channel, sends nothing", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(
      SettingsStore.use((x) =>
        x.update({
          notifyKinds: {
            reply: false,
            mention: true,
            approval: true,
            question: true,
            task_failed: true,
            routine_failed: true,
          },
        }),
      ),
    )
    await s.send("one")
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(0)
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
    await s.run(Notifier.use((n) => n.setMute("server", s.local.id, "1h")))
    await s.send("two")
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(0)
    expect((await s.run(Notifier.use((n) => Effect.succeed(n.mutes())))).length).toBe(1)
    await s.run(Notifier.use((n) => n.setMute("server", s.local.id, "off")))
    await s.send("three")
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(1)
  })

  test("a failed task notifies as a task failure", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.send("FAIL please")
    await s.idle()
    expect(s.t.shell.notices.map((n) => n.title)).toEqual(["Ada"])
  })

  test("an agent that mentions @you in a channel notifies", async () => {
    const s = await setup()
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Ops",
          topic: "",
          memberIds: [s.agent.id],
          leadId: null,
        }),
      ),
    )
    s.t.shell.focused = false
    await s.run(Channels.use((c) => c.send(channel.id, "@Ada PING")))
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(1)
    expect(s.t.shell.notices[0]?.title).toContain("Ops")
    await s.run(Notifier.use((n) => n.setMute("channel", channel.id, "forever")))
    await s.run(Channels.use((c) => c.send(channel.id, "@Ada PING again")))
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(1)
  })
})

describe("status island", () => {
  test("it shows working agents and returns to idle", async () => {
    const s = await setup()
    await s.send("SLOW work")
    await until(async () => (await s.island()).count === 1)
    const working = await s.island()
    expect(working.working.map((a) => a.name)).toEqual(["Ada"])
    expect(s.t.shell.shapes.at(-1)).toBe("bar")
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await until(async () => (await s.island()).count === 0)
    expect(s.t.events.some((e) => e.event === "island.state")).toBe(true)
  })

  test("an approval expands the island and notifies; Allow on the island lets the task go on", async () => {
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ island: "attention" })))
    s.t.shell.focused = false
    await s.send('TOOL run_command {"command":"sudo ls"}')
    await until(async () => (await s.island()).waiting.length > 0)
    const state = await s.island()
    expect(state.waiting[0]).toMatchObject({
      kind: "approval",
      agentId: s.agent.id,
      step: "command",
    })
    expect(state.waiting[0]?.summary).toContain("sudo ls")
    expect(s.t.shell.shapes.at(-1)).toBe("attention")
    expect(s.t.shell.notices.some((n) => n.body.includes("sudo ls"))).toBe(true)
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "deny")))
    await s.idle()
    expect((await s.island()).waiting).toEqual([])
    expect(s.t.shell.shapes.at(-1)).toBe("hidden")
  })

  test("island off stays hidden even for attention", async () => {
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ island: "off" })))
    await s.send('TOOL run_command {"command":"sudo ls"}')
    await until(async () => (await s.island()).waiting.length > 0)
    expect(s.t.shell.shapes.at(-1)).toBe("hidden")
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
  })
})

describe("status island: detail rows", () => {
  test("a working agent has a row: place, what it does, when the task began", async () => {
    const s = await setup()
    const before = Date.now()
    await s.send("SLOW work")
    await until(async () => (await s.island()).rows.length === 1)
    const row = (await s.island()).rows[0]
    expect(row?.agent.name).toBe("Ada")
    // A direct chat has no channel name.
    expect(row?.place).toBeNull()
    expect(row?.target).toEqual({ kind: "agent", id: s.agent.id })
    expect(row?.doing).toEqual({ kind: "none" })
    expect(row?.since).toBeGreaterThanOrEqual(before - 5)
    expect(row?.since).toBeLessThanOrEqual(Date.now())
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
  })

  test("a command that runs shows as a kind of step, never as its text", async () => {
    const s = await setup()
    await s.send('TOOL run_command {"command":"sleep 2 && echo SECRET-TEXT"}')
    await until(async () => (await s.island()).rows[0]?.doing.kind === "tool")
    const state = await s.island()
    expect(state.rows[0]?.doing).toEqual({ kind: "tool", tool: "command" })
    const text = JSON.stringify(state)
    expect(text).not.toContain("SECRET-TEXT")
    expect(text).not.toContain("sleep")
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await until(async () => (await s.island()).count === 0)
    expect((await s.island()).rows).toEqual([])
  })

  test("seven agents work: five rows and a count of seven", async () => {
    const s = await setup()
    const agents = [s.agent, ...(await Promise.all(["B", "C", "D", "E", "F", "G"].map(s.addAgent)))]
    for (const a of agents) await s.sendTo(a.id, "SLOW work")
    await until(async () => (await s.island()).count === 7)
    const state = await s.island()
    expect(state.rows).toHaveLength(5)
    expect(state.working).toHaveLength(3)
    for (const a of agents) await s.run(Chat.use((c) => c.stop(a.id)))
  })

  test("a part of a plan shows the label of its step, and the channel as place", async () => {
    const s = await setup()
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Ops",
          topic: "",
          memberIds: [s.agent.id],
          leadId: null,
        }),
      ),
    )
    const parent = await s.run(
      Tasks.use((x) =>
        x.create({ agentId: s.agent.id, prompt: "job", source: "channel", sourceId: channel.id }),
      ),
    )
    const part = await s.run(
      Tasks.use((x) =>
        x.create({
          agentId: s.agent.id,
          prompt: "do the thing",
          label: "Write the tests",
          source: "channel",
          sourceId: channel.id,
          parentId: parent.id,
        }),
      ),
    )
    const fiber = s.t.runtime.runFork(
      Tasks.use((x) => x.run(part.id, s.agent.id, Effect.sleep("30 seconds"))),
    )
    await until(async () => (await s.island()).rows.length === 1)
    const row = (await s.island()).rows[0]
    expect(row?.place).toBe("Ops")
    expect(row?.target).toEqual({ kind: "channel", id: channel.id })
    expect(row?.doing).toEqual({ kind: "plan", label: "Write the tests" })
    await s.run(Tasks.use((x) => x.stop(part.id)))
    await s.t.runtime.runPromise(Fiber.await(fiber))
  })
})

describe("status island: attention card", () => {
  test("waiting requests keep their order, with place and kind of step", async () => {
    const s = await setup()
    const names = ["B", "C"]
    const others = await Promise.all(names.map(s.addAgent))
    const all = [s.agent, ...others]
    for (const [i, a] of all.entries()) {
      await s.sendTo(a.id, 'TOOL run_command {"command":"sudo ls"}')
      await until(async () => (await s.island()).waiting.length === i + 1)
    }
    const state = await s.island()
    expect(state.waiting.map((w) => w.agentId)).toEqual(all.map((a) => a.id))
    expect(state.waiting[0]).toMatchObject({ place: null, step: "command", kind: "approval" })
    // The user allows the first one: the others stay in order.
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "deny")))
    await until(async () => (await s.island()).waiting.length === 2)
    expect((await s.island()).waiting.map((w) => w.agentId)).toEqual(others.map((a) => a.id))
    for (const a of others) await s.run(Tools.use((x) => x.respond(a.id, "call_1", "deny")))
    await s.idle()
    expect((await s.island()).waiting).toEqual([])
  })

  test("a question keeps up to 160 characters, an approval up to 90", async () => {
    const s = await setup()
    const other = await s.addAgent("Bo")
    await s.send(`TOOL ask_user ${JSON.stringify({ question: "Q".repeat(400) })}`)
    await until(async () => (await s.island()).waiting.length === 1)
    await s.sendTo(
      other.id,
      `TOOL run_command ${JSON.stringify({ command: `sudo ${"x".repeat(300)}` })}`,
    )
    await until(async () => (await s.island()).waiting.length === 2)
    const [question, approval] = (await s.island()).waiting
    expect(question).toMatchObject({ kind: "question", step: null })
    expect([...(question?.summary ?? "")]).toHaveLength(160)
    expect(approval).toMatchObject({ kind: "approval", step: "command" })
    expect([...(approval?.summary ?? "")]).toHaveLength(90)
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await s.run(Chat.use((c) => c.stop(other.id)))
  })
})

describe("status island: result card", () => {
  const result = async (s: Awaited<ReturnType<typeof setup>>) => (await s.island()).result

  test("a reply in the mode always shows the first line, under the rules of the notification", async () => {
    const s = await setup()
    // A window with the focus: no notification, no card.
    await s.send("hello")
    await s.idle()
    expect(await result(s)).toBeNull()
    s.t.shell.focused = false
    await s.send("hello again")
    await s.idle()
    const card = await result(s)
    expect(card).toMatchObject({
      kind: "reply",
      line: "All done",
      reason: null,
      place: null,
      agent: { name: "Ada" },
    })
    expect(card?.target).toMatchObject({ kind: "agent", id: s.agent.id })
    expect(card?.target).toHaveProperty("messageId")
    expect(s.t.shell.shapes.at(-1)).toBe("result")
    // The card ends when the page says so. A stale id does not end a newer card.
    await s.run(Notifier.use((n) => Effect.succeed(n.dismissResult((card?.id ?? 0) - 1))))
    expect(await result(s)).not.toBeNull()
    await s.run(Notifier.use((n) => Effect.succeed(n.dismissResult(card?.id ?? 0))))
    expect(await result(s)).toBeNull()
    expect(s.t.shell.shapes.at(-1)).toBe("bar")
  })

  test("a newer result replaces the older one", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.send("one")
    await s.idle()
    const first = await result(s)
    await s.send("two")
    await s.idle()
    const second = await result(s)
    expect(second?.id).toBeGreaterThan(first?.id ?? 0)
  })

  test("a muted server, or a kind that is off, shows no card and no notification", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(Notifier.use((n) => n.setMute("server", s.local.id, "1h")))
    await s.send("muted")
    await s.idle()
    expect(await result(s)).toBeNull()
    expect(s.t.shell.notices).toHaveLength(0)
    await s.run(Notifier.use((n) => n.setMute("server", s.local.id, "off")))
    await s.run(
      SettingsStore.use((x) =>
        x.update({
          notifyKinds: {
            reply: false,
            mention: true,
            approval: true,
            question: true,
            task_failed: true,
            routine_failed: true,
          },
        }),
      ),
    )
    await s.send("kind off")
    await s.idle()
    expect(await result(s)).toBeNull()
    expect(s.t.shell.notices).toHaveLength(0)
  })

  test("a failed task shows its reason", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.send("FAIL please")
    await s.idle()
    const card = await result(s)
    expect(card).toMatchObject({ kind: "task_failed", line: "" })
    expect(card?.reason?.code).toBeTruthy()
  })

  test("no card in the modes only for attention and off; the notification is the same", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.setIsland("attention")
    await s.send("one")
    await s.idle()
    expect(await result(s)).toBeNull()
    expect(s.t.shell.notices).toHaveLength(1)
    expect(s.t.shell.shapes.at(-1)).toBe("hidden")
    await s.setIsland("off")
    await s.send("two")
    await s.idle()
    expect(await result(s)).toBeNull()
    expect(s.t.shell.notices).toHaveLength(2)
    // A card that was up when the mode changed does not come back.
    await s.setIsland("always")
    expect(await result(s)).toBeNull()
  })

  test("a request for attention replaces the card at once", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.send("one")
    await s.idle()
    expect(await result(s)).not.toBeNull()
    await s.send('TOOL run_command {"command":"sudo ls"}')
    await until(async () => (await s.island()).waiting.length === 1)
    expect(await result(s)).toBeNull()
    expect(s.t.shell.shapes.at(-1)).toBe("attention")
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
  })
})
