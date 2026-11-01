import { afterAll, describe, expect, test } from "bun:test"
import type { WireNotice } from "@robot/shared"
import { Effect } from "effect"
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
  return { t, run, local, agent, send, idle, island }
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
    await until(async () => (await s.island()).attention !== null)
    const state = await s.island()
    expect(state.attention).toMatchObject({ kind: "approval", agentId: s.agent.id })
    expect(state.attention?.summary).toContain("sudo ls")
    expect(s.t.shell.shapes.at(-1)).toBe("attention")
    expect(s.t.shell.notices.some((n) => n.body.includes("sudo ls"))).toBe(true)
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "deny")))
    await s.idle()
    expect((await s.island()).attention).toBeNull()
    expect(s.t.shell.shapes.at(-1)).toBe("hidden")
  })

  test("island off stays hidden even for attention", async () => {
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ island: "off" })))
    await s.send('TOOL run_command {"command":"sudo ls"}')
    await until(async () => (await s.island()).attention !== null)
    expect(s.t.shell.shapes.at(-1)).toBe("hidden")
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
  })

  test("an approval is pushed to linked devices once, with its call, and listed while it waits", async () => {
    const s = await setup()
    await s.send('TOOL run_command {"command":"sudo ls"}')
    await until(async () => (await s.island()).attention !== null)
    const pushed = s.t.events.filter((e) => e.event === "notice")
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.payload).toMatchObject({
      kind: "approval",
      callId: "call_1",
      agentId: s.agent.id,
      title: "Ada",
      target: { kind: "agent", id: s.agent.id },
    })
    const waiting = await s.run(Notifier.use((n) => Effect.succeed(n.waitingNotices())))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ callId: "call_1", body: expect.stringContaining("sudo ls") })
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "deny")))
    await s.idle()
    expect(await s.run(Notifier.use((n) => Effect.succeed(n.waitingNotices())))).toEqual([])
    // The answer pushes no second approval. The reply that follows is a notice of its own.
    const approvals = s.t.events.filter(
      (e) => e.event === "notice" && (e.payload as WireNotice).kind === "approval",
    )
    expect(approvals).toHaveLength(1)
  })

  test("a reply is pushed to linked devices too", async () => {
    const s = await setup()
    await s.send("hello")
    await s.idle()
    expect(s.t.events.some((e) => e.event === "notice")).toBe(true)
  })
})

describe("notices of a linked server", () => {
  const source = { linkId: "link-1", serverId: "server-b", serverName: "MacBook 2" }
  const notice = (over: Partial<WireNotice> = {}): WireNotice => ({
    kind: "approval",
    channelId: null,
    title: "Ada",
    body: "Run: ls",
    target: { kind: "agent", id: "agent-1", messageId: "m1" },
    callId: "c1",
    agentId: "agent-1",
    ...over,
  })
  /** A notice that has no call, such as a mention or a failed task. */
  const plain = (over: Partial<WireNotice> = {}): WireNotice => {
    const { callId: _call, agentId: _agent, ...rest } = notice()
    return { ...rest, ...over }
  }
  const linked = (s: Awaited<ReturnType<typeof setup>>, n: WireNotice, from = source) =>
    s.run(Notifier.use((x) => Effect.sync(() => x.notifyLinked(from, n))))

  test("it shows by the settings of this computer and names the server", async () => {
    const s = await setup()
    await linked(s, notice({ callId: "focused" }))
    expect(s.t.shell.notices).toHaveLength(0)
    s.t.shell.focused = false
    await linked(s, notice())
    expect(s.t.shell.notices).toHaveLength(1)
    expect(s.t.shell.notices[0]).toMatchObject({ title: "Ada · MacBook 2", body: "Run: ls" })
  })

  test("a click shows the window and opens the place on that server", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await linked(s, notice())
    s.t.shell.notices[0]?.click()
    expect(s.t.shell.shown).toBe(1)
    expect(s.t.events.find((e) => e.event === "app.openPlace")?.payload).toEqual({
      kind: "agent",
      id: "agent-1",
      messageId: "m1",
      serverId: "server-b",
    })
  })

  test("a kind that is off sends nothing", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(
      SettingsStore.use((x) =>
        x.update({
          notifyKinds: {
            reply: true,
            mention: true,
            approval: false,
            question: true,
            task_failed: true,
            routine_failed: true,
          },
        }),
      ),
    )
    await linked(s, notice())
    expect(s.t.shell.notices).toHaveLength(0)
    await linked(s, plain({ kind: "task_failed" }))
    expect(s.t.shell.notices).toHaveLength(1)
  })

  test("a mute works per server: one computer muted, the other not", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(Notifier.use((n) => n.setMute("server", "server-b", "1h")))
    await linked(s, notice())
    expect(s.t.shell.notices).toHaveLength(0)
    await linked(s, notice({ callId: "c2" }), { ...source, linkId: "link-2", serverId: "server-c" })
    expect(s.t.shell.notices).toHaveLength(1)
    // This computer's own server is not muted by that.
    await s.send("hello")
    await s.idle()
    expect(s.t.shell.notices).toHaveLength(2)
  })

  test("a mute of one channel on the server holds, the others still notify", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(Notifier.use((n) => n.setMute("channel", "ch-1", "8h")))
    await linked(s, plain({ kind: "mention", channelId: "ch-1" }))
    expect(s.t.shell.notices).toHaveLength(0)
    await linked(s, plain({ kind: "mention", channelId: "ch-2" }))
    expect(s.t.shell.notices).toHaveLength(1)
  })

  test("a request that waits notifies once, and not again after it was answered here", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await linked(s, notice())
    await linked(s, notice())
    expect(s.t.shell.notices).toHaveLength(1)

    await s.run(Notifier.use((n) => Effect.sync(() => n.answeredLinked("link-1", "agent-1", "c9"))))
    await linked(s, notice({ callId: "c9" }))
    expect(s.t.shell.notices).toHaveLength(1)

    // The same call id on another link is another request.
    await linked(s, notice(), { ...source, linkId: "link-2" })
    expect(s.t.shell.notices).toHaveLength(2)
  })
})
