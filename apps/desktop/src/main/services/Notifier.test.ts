import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { attentionAnswers, type ChatMessage, type WireNotice } from "@robot/shared"
import { Effect, Fiber } from "effect"
import { runRequest } from "../rpc.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Notifier } from "./Notifier.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { fakeClock } from "./silence.testing.ts"
import { useClockForTests } from "./silence.ts"
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
  hostname: "127.0.0.1",
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
    // A model that shows no sign of life: the answer opens and nothing follows.
    if (content.includes("HANG"))
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
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

  test("an approval is pushed to linked devices once, with its call, and listed while it waits", async () => {
    const s = await setup()
    await s.send('TOOL run_command {"command":"sudo ls"}')
    await until(async () => (await s.island()).waiting.length > 0)
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

  test("a part in review shows from a linked server, with the same off switch and mutes, and opens the part", async () => {
    const s = await setup()
    s.t.shell.focused = false
    const review = plain({
      kind: "part_review",
      channelId: "channel-1",
      title: "Ada · Launch",
      body: "Write the intro",
      target: { kind: "channel", id: "channel-1", messageId: "m9" },
    })
    await linked(s, review)
    expect(s.t.shell.notices).toHaveLength(1)
    expect(s.t.shell.notices[0]).toMatchObject({
      title: "Ada · Launch · MacBook 2",
      body: "Write the intro",
    })
    s.t.shell.notices[0]?.click()
    expect(s.t.events.find((e) => e.event === "app.openPlace")?.payload).toEqual({
      kind: "channel",
      id: "channel-1",
      messageId: "m9",
      serverId: "server-b",
    })
    // The channel is muted: nothing more shows.
    await s.run(Notifier.use((n) => n.setMute("server", "server-b", "1h")))
    await linked(s, review)
    expect(s.t.shell.notices).toHaveLength(1)
    await s.run(Notifier.use((n) => n.setMute("server", "server-b", "off")))
    // The kind is off: nothing shows.
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
            part_review: false,
          },
        }),
      ),
    )
    await linked(s, review)
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

describe("the island, other computers and Always allow", () => {
  /** A step outside the workspace: at "Ask for risky steps" it waits for an approval. */
  const removal = (path: string) =>
    `TOOL run_command ${JSON.stringify({ command: `rm "${path}"` })}`
  const file = (s: Awaited<ReturnType<typeof setup>>, name: string) => {
    const path = join(s.t.dataDir, name)
    writeFileSync(path, "x")
    return path
  }
  const cardOf = async (s: Awaited<ReturnType<typeof setup>>) => {
    const { messages } = await s.run(Chat.use((c) => c.history(s.agent.id)))
    const reply = messages.filter((m: ChatMessage) => m.author === "agent").at(-1)
    return reply?.parts.find((p) => p.kind === "tool")
  }
  const waitingIsland = async (s: Awaited<ReturnType<typeof setup>>) => {
    await until(async () => (await s.island()).waiting.length > 0)
    const attention = (await s.island()).waiting[0]
    if (!attention) throw new Error("no request")
    return attention
  }

  test("an approval of this computer has Always allow on the island; the island's answer remembers the step", async () => {
    const s = await setup()
    const first = file(s, "own1.txt")
    const second = file(s, "own2.txt")
    await s.send(removal(first))
    const attention = await waitingIsland(s)
    expect(attention.always).toBe(true)
    expect(
      await s.run(Notifier.use((n) => Effect.succeed(n.canAlways(s.agent.id, "call_1")))),
    ).toBe(true)
    await runRequest(s.t.runtime, "island.respond", {
      agentId: s.agent.id,
      callId: "call_1",
      answer: "always",
    })
    await s.idle()
    expect(existsSync(first)).toBe(false)
    // The rule holds for this command: the same step asks nothing (spec 007).
    writeFileSync(first, "x")
    await s.send(removal(first))
    await s.idle()
    expect(existsSync(first)).toBe(false)
    // The rule is not wider than the step on the card: another command asks.
    await s.send(removal(second))
    await waitingIsland(s)
    expect(existsSync(second)).toBe(true)
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "deny")))
    await s.idle()
  })

  test("a request of the other computer has no Always allow on the island, and its answer is one Allow", async () => {
    const s = await setup()
    const first = file(s, "peer1.txt")
    await s.send(removal(first))
    const own = await waitingIsland(s)
    // The same request shown as one of the other computer of a sync pair, as the sync service does.
    const { agent: _agent, ...item } = own
    await s.run(
      Notifier.use((n) =>
        Effect.sync(() =>
          n.attention(
            { ...item, always: true, serverId: s.local.id, channelId: null },
            "MacBook 2",
          ),
        ),
      ),
    )
    expect((await s.island()).waiting[0]).toMatchObject({ callId: "call_1", always: false })
    expect(
      await s.run(Notifier.use((n) => Effect.succeed(n.canAlways(s.agent.id, "call_1")))),
    ).toBe(false)
    // A window that still sends "always" gets one "Allow" and no rule.
    await runRequest(s.t.runtime, "island.respond", {
      agentId: s.agent.id,
      callId: "call_1",
      answer: "always",
    })
    await s.idle()
    expect(existsSync(first)).toBe(false)
    // No rule was saved: the same command asks again.
    writeFileSync(first, "x")
    await s.send(removal(first))
    const next = await waitingIsland(s)
    expect(next.always).toBe(true)
    expect(existsSync(first)).toBe(true)
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "deny")))
    await s.idle()
  })

  test("one list with a request of this computer and one of the sync peer: the buttons and the answers of each", async () => {
    const s = await setup()
    const peer = await s.addAgent("Bo")
    const ownFile = file(s, "list-own.txt")
    const peerFile = file(s, "list-peer.txt")
    await s.send(removal(ownFile))
    // The two turns run at once, so the request of this agent must be there before Bo asks:
    // otherwise a slow machine can show the two in the other order.
    await until(async () => (await s.island()).waiting.length === 1)
    await s.sendTo(peer.id, removal(peerFile))
    await until(async () => (await s.island()).waiting.length === 2)
    // The request of Bo is shown as one of the sync peer, as the sync service does.
    const shown = (await s.island()).waiting.find((w) => w.agentId === peer.id)
    if (!shown) throw new Error("no request of Bo")
    await s.run(
      Notifier.use((n) =>
        Effect.sync(() =>
          n.attention(
            {
              agentId: shown.agentId,
              serverId: s.local.id,
              channelId: null,
              callId: shown.callId,
              kind: shown.kind,
              summary: shown.summary,
              step: shown.step,
              // The sync service passes false. A caller that passes true gets false as well.
              always: true,
              target: shown.target,
            },
            "MacBook 2",
          ),
        ),
      ),
    )
    const list = (await s.island()).waiting
    // The list keeps its order, and both requests show in it.
    expect(list.map((w) => w.agentId)).toEqual([s.agent.id, peer.id])
    const [own, other] = list
    if (!own || !other) throw new Error("no list")
    // The buttons: Allow, Always allow and Deny for this computer; Allow and Deny for the peer.
    expect(attentionAnswers(own)).toEqual(["allow", "always", "deny"])
    expect(attentionAnswers(other)).toEqual(["allow", "deny"])
    expect(own.step).toBe("command")
    expect(other.step).toBe("command")
    expect(
      await s.run(Notifier.use((n) => Effect.succeed(n.canAlways(own.agentId, own.callId)))),
    ).toBe(true)
    expect(
      await s.run(Notifier.use((n) => Effect.succeed(n.canAlways(other.agentId, other.callId)))),
    ).toBe(false)

    // A stray "always" for the peer request is one "Allow": the step runs and no rule is saved.
    await runRequest(s.t.runtime, "island.respond", {
      agentId: other.agentId,
      callId: other.callId,
      answer: "always",
    })
    await until(() => !existsSync(peerFile))
    expect((await s.island()).waiting.map((w) => w.agentId)).toEqual([s.agent.id])
    // No rule was saved: the same command asks again.
    writeFileSync(peerFile, "x")
    await s.sendTo(peer.id, removal(peerFile))
    await until(async () => (await s.island()).waiting.length === 2)
    expect(existsSync(peerFile)).toBe(true)
    expect((await s.island()).waiting.find((w) => w.agentId === peer.id)?.always).toBe(true)

    // "Always allow" for the request of this computer saves the rule.
    await runRequest(s.t.runtime, "island.respond", {
      agentId: own.agentId,
      callId: own.callId,
      answer: "always",
    })
    await until(() => !existsSync(ownFile))
    // The rule holds for this command: the same step runs with no card.
    writeFileSync(ownFile, "x")
    await s.send(removal(ownFile))
    await until(() => !existsSync(ownFile))
    await s.run(Tools.use((x) => x.respond(peer.id, "call_1", "deny")))
    await s.idle()
  })

  test("a request that is not known takes no Always allow", async () => {
    const s = await setup()
    expect(await s.run(Notifier.use((n) => Effect.succeed(n.canAlways(s.agent.id, "none"))))).toBe(
      false,
    )
  })

  test("the system notice of a request holds no answer, and the island shows no request of a linked server", async () => {
    const s = await setup()
    s.t.shell.focused = false
    await s.run(
      Notifier.use((n) =>
        Effect.sync(() =>
          n.notifyLinked(
            { linkId: "link-1", serverId: "server-b", serverName: "MacBook 2" },
            {
              kind: "approval",
              channelId: null,
              title: "Ada",
              body: "Run: ls",
              target: { kind: "agent", id: "agent-1", messageId: "m1" },
              callId: "c1",
              agentId: "agent-1",
            },
          ),
        ),
      ),
    )
    expect(s.t.shell.notices).toHaveLength(1)
    // A notice has a title, a body and a click, and no button to answer.
    expect(Object.keys(s.t.shell.notices[0] ?? {}).sort()).toEqual(["body", "click", "title"])
    expect((await s.island()).waiting).toEqual([])
    expect(await s.run(Notifier.use((n) => Effect.succeed(n.waitingNotices())))).toEqual([])
    // A reply or a failure of a linked server makes no result card either.
    await s.run(
      Notifier.use((n) =>
        Effect.sync(() => {
          const source = { linkId: "link-1", serverId: "server-b", serverName: "MacBook 2" }
          const base = { channelId: null, title: "Ada", agentId: s.agent.id }
          const target = { kind: "agent", id: s.agent.id } as const
          n.notifyLinked(source, { ...base, kind: "reply", body: "Done", target })
          n.notifyLinked(source, { ...base, kind: "task_failed", body: "Failed", target })
        }),
      ),
    )
    expect(s.t.shell.notices).toHaveLength(3)
    expect((await s.island()).result).toBeNull()
  })

  test("a linked device or the sync peer that sends Always allow gives one Allow: the step runs, the card names the device, no rule is saved", async () => {
    const s = await setup()
    const first = file(s, "dev1.txt")
    const second = file(s, "dev2.txt")
    await s.send(removal(first))
    await waitingIsland(s)
    const answered = await runRequest(
      s.t.runtime,
      "tools.respond",
      { agentId: s.agent.id, callId: "call_1", answer: "always" },
      { id: "device-1", name: "MacBook 2" },
    )
    expect(answered.ok).toBe(true)
    await s.idle()
    expect(existsSync(first)).toBe(false)
    expect(await cardOf(s)).toMatchObject({
      kind: "tool",
      decision: { answer: "allow", by: "MacBook 2" },
    })
    // No rule: the next step of that kind asks again.
    await s.send(removal(second))
    await waitingIsland(s)
    expect(existsSync(second)).toBe(true)
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "deny")))
    await s.idle()
  })
})

afterEach(() => useClockForTests(undefined))

describe("status island: the quiet line in a row (spec 005, 015)", () => {
  test("a row carries the quiet line of its turn: the name and the seconds; no notice shows", async () => {
    const fake = fakeClock()
    useClockForTests(fake.clock)
    const s = await setup()
    s.t.shell.focused = false
    await s.run(SettingsStore.use((x) => x.update({ silentLimit: 10, island: "always" })))
    await s.send("HANG on")
    await until(async () => (await s.island()).rows.length === 1)
    await until(
      async () => (await s.run(Tasks.use((x) => x.list(s.local.id))))[0]?.progress === "sent",
    )
    // Working, not quiet: the row has the usual text.
    expect((await s.island()).rows[0]?.quiet).toBeNull()
    fake.advance(89_000)
    expect((await s.island()).rows[0]?.quiet).toBeNull()
    fake.advance(1_000)
    const row = (await s.island()).rows[0]
    expect(row?.quiet?.name).toBe("M")
    expect(row?.quiet?.seconds).toBeGreaterThanOrEqual(90)
    // The island is told when the line starts, so it needs no timer of its own for the start.
    const states = s.t.events.filter((e) => e.event === "island.state")
    const pushed = states.at(-1)?.payload as { rows: { quiet: unknown }[] } | undefined
    expect(pushed?.rows[0]?.quiet).not.toBeNull()
    // The quiet line makes no notification and no result card.
    expect(s.t.shell.notices).toHaveLength(0)
    expect((await s.island()).result).toBeNull()
    // Stop ends the line with the turn.
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await until(async () => (await s.island()).rows.length === 0)
    expect(s.t.shell.notices).toHaveLength(0)
  })

  test("a row without a quiet turn has no quiet line", async () => {
    const s = await setup()
    await s.send("SLOW work")
    await until(async () => (await s.island()).rows.length === 1)
    expect((await s.island()).rows[0]?.quiet).toBeNull()
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
