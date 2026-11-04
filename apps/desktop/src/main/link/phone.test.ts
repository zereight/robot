import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AsyncSecretStore, type BrowserWebSocketClass, browserSocket } from "@robot/link"
import {
  MemoryStorage,
  type OrgChartPhase,
  ATTACH_BYTES as PHONE_ATTACH_BYTES,
  ATTACH_MAX as PHONE_ATTACH_MAX,
  PhoneHub,
  type ServerView,
  unsupportedByServer,
} from "@robot/phone"
import {
  ATTACH_BYTES,
  ATTACH_MAX,
  type ChartModel,
  type ChatMessage,
  type MessagePart,
  messageText,
  type WireNotice,
} from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "../services/Agents.ts"
import { Chat } from "../services/Chat.ts"
import { Devices } from "../services/Devices.ts"
import { EventBus } from "../services/EventBus.ts"
import { Providers } from "../services/Providers.ts"
import { Servers } from "../services/Servers.ts"
import { testRuntime } from "../services/testing.ts"

// The phone app (spec 011) runs its client core in React Native. Here the same core runs in Bun,
// with the web socket of the browser API that Bun has, against the real link server, the real
// Devices service and the real request handlers of the desktop.

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

// A model that streams its answer in pieces, and asks for a tool when the message says so.
const model = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const last = body.messages.at(-1)
    if (last?.role === "tool") return sse([text("The file is gone."), { delay: 0, data: "[DONE]" }])
    const content = last?.content ?? ""
    const call = /TOOL (\w+) (\{.*\})/.exec(content)
    if (call) {
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
    }
    const words = `Echo: ${content.split("\n").at(-1)}`.split(" ")
    return sse([
      ...words.map((w, i) => text(i === 0 ? w : ` ${w}`, 40)),
      { delay: 0, data: "[DONE]" },
    ])
  },
})

const waitFor = async <T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await Bun.sleep(30)
    last = await read()
  }
  if (!ok(last)) throw new Error(`timed out; last value: ${JSON.stringify(last)?.slice(0, 400)}`)
  return last
}

const memorySecrets = (): AsyncSecretStore & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value)
    },
  }
}

const opener = browserSocket(globalThis.WebSocket as unknown as BrowserWebSocketClass)
const phones: PhoneHub[] = []
const openPhone = async (
  storage = new MemoryStorage(),
  secrets: AsyncSecretStore = memorySecrets(),
) => {
  const hub = await PhoneHub.open({
    storage,
    secrets,
    opener,
    maxDelayMs: 300,
    connectMs: 15_000,
    pingMs: 1_000,
  })
  phones.push(hub)
  return hub
}

const sides: ReturnType<typeof testRuntime>[] = []
beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
})
afterAll(async () => {
  for (const p of phones) p.close()
  for (const s of sides) await s.runtime.dispose()
  model.stop()
  delete process.env.ROBOT_LINK_ADDRESSES
})

/** A computer with one agent on the mock model. */
const computer = async (name: string) => {
  const t = testRuntime({ name })
  sides.push(t)
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${model.port}/v1`,
        apiKey: "sk-phone-test",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((x) =>
      x.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: { accountId: account.id, model: "mock", effort: null },
      }),
    ),
  )
  return { t, run, local, agent }
}

type Computer = Awaited<ReturnType<typeof computer>>

/** The phone pairs with "Type it instead", and the user of the computer answers. */
const pair = async (pc: Computer, phone: PhoneHub, allow = true) => {
  const pairing = await pc.run(Devices.use((d) => d.pairStart()))
  const address = pairing.addresses[0]?.address ?? ""
  const waiting: string[] = []
  const run = phone.pair({ address, code: pairing.code }, (name) => waiting.push(name))
  const joins = await waitFor(
    () => pc.run(Devices.use((d) => Effect.sync(() => d.joins()))),
    (j) => j.length > 0,
  )
  await pc.run(Devices.use((d) => d.decide(joins[0]?.id ?? "", allow)))
  return { run, waiting, joins }
}

const view = (phone: PhoneHub, id: string) => phone.server(id) as ServerView
const chatOf = (phone: PhoneHub, id: string, agentId: string) =>
  view(phone, id).data.chats[agentId]?.messages ?? []
const toolOf = (message: ChatMessage | undefined) =>
  message?.parts.find((p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool")

describe("the phone on a real computer", () => {
  test("the limits of files match the server", () => {
    expect(PHONE_ATTACH_MAX).toBe(ATTACH_MAX)
    expect(PHONE_ATTACH_BYTES).toBe(ATTACH_BYTES)
  })

  test("pair, read places, send, stream, approve, and Not allowed after Remove access", async () => {
    const pc = await computer("MacBook 2")
    const secrets = memorySecrets()
    const storage = new MemoryStorage()
    const phone = await openPhone(storage, secrets)
    await phone.setDeviceName("Pixel of Kim")
    // The identity key is in the secret store, and nowhere in the files of the app.
    expect(secrets.map.has("link-identity")).toBe(true)
    expect([...storage.files.values()].join("")).not.toContain(secrets.map.get("link-identity"))

    const { run, waiting, joins } = await pair(pc, phone)
    // The computer asks "Allow <phone name>?" with the kind phone, and one direction only.
    expect(joins[0]).toMatchObject({ name: "Pixel of Kim", kind: "phone", twoWay: false })
    const link = await run.done
    expect(waiting).toEqual(["MacBook 2"])
    expect(link).toMatchObject({ name: "MacBook 2", serverId: pc.local.id, removed: false })
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "online",
    )

    // Places come with the sections of the server.
    const places = await waitFor(
      () => view(phone, link.id).data.places,
      (p) => (p ?? []).some((s) => s.places.some((x) => x.id === pc.agent.id)),
    )
    expect(places?.map((s) => s.id)).toEqual(["channels", "agents"])
    expect(view(phone, link.id).data.agents?.map((a) => a.name)).toEqual(["Ada"])

    // Open the agent, send, and see the reply stream in.
    await phone.openPlace(link.id, { kind: "agent", id: pc.agent.id })
    const seen = new Set<string>()
    const stop = phone.subscribe(() => {
      const reply = chatOf(phone, link.id, pc.agent.id).find((m) => m.author === "agent")
      if (reply) seen.add(`${reply.status}:${messageText(reply)}`)
    })
    await phone.send(link.id, { agentId: pc.agent.id, text: "hello there", replyTo: null })
    await waitFor(
      () => chatOf(phone, link.id, pc.agent.id),
      (m) => m.some((x) => x.author === "agent" && x.status === "done"),
    )
    stop()
    const reply = chatOf(phone, link.id, pc.agent.id).find((m) => m.author === "agent")
    expect(messageText(reply as ChatMessage)).toBe("Echo: hello there")
    // The reply came in more than one piece while it streamed.
    expect([...seen].filter((s) => s.startsWith("streaming:")).length).toBeGreaterThan(1)
    // The computer shows "from <phone name>" on the message.
    const onServer = await pc.run(Chat.use((c) => c.history(pc.agent.id)))
    expect(onServer.messages[0]?.fromDevice).toBe("Pixel of Kim")

    // An approval: the card and the "Needs you" list show it, and the phone answers.
    const notices: WireNotice[] = []
    phone.onNotice((_id, n) => notices.push(n))
    const dir = mkdtempSync(join(tmpdir(), "robot-phone-"))
    const target = join(dir, "old.txt")
    writeFileSync(target, "x")
    await phone.send(link.id, {
      agentId: pc.agent.id,
      text: `TOOL run_command ${JSON.stringify({ command: `rm "${target}"` })}`,
      replyTo: null,
    })
    const waitingCard = await waitFor(
      () => chatOf(phone, link.id, pc.agent.id),
      (m) => toolOf(m.at(-1))?.ask?.kind === "approval",
    )
    const card = toolOf(waitingCard.at(-1))
    await waitFor(
      () => view(phone, link.id).data.attention,
      (a) => a.some((n) => n.kind === "approval" && n.callId === card?.id),
    )
    expect(notices.some((n) => n.kind === "approval")).toBe(true)
    // A client has no "Always allow" (spec 012): the phone refuses to send it.
    await expect(phone.respond(link.id, pc.agent.id, card?.id ?? "", "always")).rejects.toThrow()
    await phone.respond(link.id, pc.agent.id, card?.id ?? "", "allow")
    await waitFor(
      () => existsSync(target),
      (here) => !here,
    )
    const answered = await waitFor(
      () => chatOf(phone, link.id, pc.agent.id),
      (m) => m.some((x) => toolOf(x)?.decision !== undefined),
    )
    expect(answered.map(toolOf).find((t) => t?.decision)?.decision).toEqual({
      answer: "allow",
      by: "Pixel of Kim",
    })
    await waitFor(
      () => view(phone, link.id).data.attention,
      (a) => a.length === 0,
    )

    // The cache holds what the phone opened.
    await phone.flush()
    expect([...storage.files.keys()].some((k) => k.startsWith(`cache/${link.id}/chat-`))).toBe(true)

    // Workflows of the computer are Phone 2 (spec 011). Their events reach the phone, and the
    // phone ignores them: it stays online, shows no notice, and the link still answers.
    await pc.run(
      EventBus.use((b) =>
        Effect.sync(() => {
          b.emit("workflows.changed", { serverId: pc.local.id })
          b.emit("workflows.run", { runId: "r1" })
        }),
      ),
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(view(phone, link.id).state).toBe("online")
    expect(notices.some((n) => n.kind === "workflow_notice")).toBe(false)
    await phone.request(link.id, "places.list", { serverId: pc.local.id })

    // The computer removes the phone: the state is "Not allowed", the data and cache go.
    await pc.run(Devices.use((d) => d.removeClient(phone.deviceId)))
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "not_allowed",
    )
    expect(view(phone, link.id).data.places).toBeNull()
    expect(view(phone, link.id).data.chats).toEqual({})
    expect([...storage.files.keys()].some((k) => k.startsWith(`cache/${link.id}`))).toBe(false)
    await expect(phone.request(link.id, "places.list", { serverId: pc.local.id })).rejects.toThrow(
      "not_allowed",
    )
    // After a restart of the app it still says "Pair again".
    const again = await openPhone(storage, secrets)
    expect(again.server(link.id)?.state).toBe("not_allowed")
    again.close()
  }, 30_000)

  test("a wrong code and Deny are plain errors, and the phone can pair again", async () => {
    const pc = await computer("MacBook 1")
    const phone = await openPhone()
    await phone.setDeviceName("Phone")
    const pairing = await pc.run(Devices.use((d) => d.pairStart()))
    const address = pairing.addresses[0]?.address ?? ""
    const wrong = pairing.code === "000000" ? "111111" : "000000"
    await expect(phone.pair({ address, code: wrong }, () => {}).done).rejects.toMatchObject({
      code: "wrong_code",
    })
    await expect(phone.pair({ address, code: "12" }, () => {}).done).rejects.toMatchObject({
      code: "wrong_code",
    })
    await expect(
      phone.pair({ address: "not an address!", code: "123456" }, () => {}).done,
    ).rejects.toMatchObject({ code: "invalid_address" })
    await expect(phone.pair({ link: "https://example.com" }, () => {}).done).rejects.toMatchObject({
      code: "invalid_link",
    })
    const denied = await pair(pc, phone, false)
    await expect(denied.run.done).rejects.toMatchObject({ code: "denied" })
    expect(phone.state().servers).toHaveLength(0)
    // The QR code holds the link text: the phone pairs with no typing.
    const qr = await pc.run(Devices.use((d) => d.pairStart()))
    const run = phone.pair({ link: qr.link }, () => {})
    const joins = await waitFor(
      () => pc.run(Devices.use((d) => Effect.sync(() => d.joins()))),
      (j) => j.length > 0,
    )
    await pc.run(Devices.use((d) => d.decide(joins[0]?.id ?? "", true)))
    const link = await run.done
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "online",
    )
  }, 30_000)

  test("offline: the cached conversation shows after a restart, and the server comes back", async () => {
    const pc = await computer("Studio")
    const storage = new MemoryStorage()
    const secrets = memorySecrets()
    const phone = await openPhone(storage, secrets)
    await phone.setDeviceName("Phone")
    const { run } = await pair(pc, phone)
    const link = await run.done
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "online",
    )
    await phone.openPlace(link.id, { kind: "agent", id: pc.agent.id })
    await phone.send(link.id, { agentId: pc.agent.id, text: "keep this", replyTo: null })
    await waitFor(
      () => chatOf(phone, link.id, pc.agent.id),
      (m) => m.some((x) => x.author === "agent" && x.status === "done"),
    )
    await waitFor(
      () => view(phone, link.id).data.places,
      (p) => p !== null,
    )
    await phone.flush()
    phone.close()

    // The computer stops to accept connections, and the app starts again.
    await pc.run(Devices.use((d) => Effect.promise(() => d.setAccept(false))))
    const later = await openPhone(storage, secrets)
    await waitFor(
      () => view(later, link.id).state,
      (s) => s === "offline",
    )
    expect(view(later, link.id).data.places).not.toBeNull()
    await later.openPlace(link.id, { kind: "agent", id: pc.agent.id })
    expect(chatOf(later, link.id, pc.agent.id).map(messageText)).toEqual([
      "keep this",
      "Echo: keep this",
    ])
    await expect(
      later.send(link.id, { agentId: pc.agent.id, text: "x", replyTo: null }),
    ).rejects.toMatchObject({ code: "offline" })

    // The computer accepts again: the phone goes online with no new pairing, and reads again.
    await pc.run(Devices.use((d) => Effect.promise(() => d.setAccept(true))))
    later.reconnect(link.id)
    await waitFor(
      () => view(later, link.id).state,
      (s) => s === "online",
    )
    // A reply that ended while the phone was away shows after the app comes back.
    await pc.run(
      Chat.use((c) => c.send({ agentId: pc.agent.id, text: "while away", replyTo: null })),
    )
    later.pause()
    await waitFor(
      () => pc.run(Chat.use((c) => c.history(pc.agent.id))),
      (h) => h.messages.length === 4 && h.messages.every((m) => m.status === "done"),
    )
    await later.resume()
    await waitFor(
      () => chatOf(later, link.id, pc.agent.id).map(messageText),
      (m) => m.includes("Echo: while away"),
    )

    // Unpair deletes the cache of the server.
    await later.unpair(link.id)
    expect([...storage.files.keys()].some((k) => k.startsWith(`cache/${link.id}`))).toBe(false)
    expect(later.state().servers).toHaveLength(0)
  }, 30_000)

  test("attach a file from the phone, and open the file of a message", async () => {
    const pc = await computer("Mini")
    const phone = await openPhone()
    await phone.setDeviceName("Phone")
    const { run } = await pair(pc, phone)
    const link = await run.done
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "online",
    )
    await phone.openPlace(link.id, { kind: "agent", id: pc.agent.id })
    // Larger than one piece of the upload, so it goes in more than one request.
    const bytes = Uint8Array.from({ length: 450_000 }, (_, i) => (i * 7) & 255)
    const progress: number[] = []
    await phone.send(
      link.id,
      {
        agentId: pc.agent.id,
        text: "see the photo",
        replyTo: null,
        files: [
          {
            name: "photo.jpg",
            size: bytes.length,
            read: async (offset, length) => bytes.slice(offset, offset + length),
          },
        ],
      },
      (sent) => progress.push(sent),
    )
    expect(progress.length).toBeGreaterThan(1)
    expect(progress.at(-1)).toBe(bytes.length)
    const sent = await waitFor(
      () => chatOf(phone, link.id, pc.agent.id),
      (m) => m.some((x) => x.parts.some((p) => p.kind === "file")),
    )
    const file = sent
      .flatMap((m) => m.parts)
      .find((p): p is Extract<MessagePart, { kind: "file" }> => p.kind === "file")
    expect(file).toMatchObject({ name: "photo.jpg", size: bytes.length })
    const pieces: Uint8Array[] = []
    const size = await phone.download(
      link.id,
      { agentId: pc.agent.id, path: file?.path ?? "" },
      (piece) => {
        pieces.push(piece)
      },
    )
    expect(size).toBe(bytes.length)
    expect(Buffer.concat(pieces).equals(Buffer.from(bytes))).toBe(true)
    // A path outside the files of messages is refused by the server.
    await expect(
      phone.download(link.id, { agentId: pc.agent.id, path: "../secret.txt" }, () => {}),
    ).rejects.toThrow()
  }, 30_000)

  test("the phone asks for the org chart with the same request as a computer, and needs no switch", async () => {
    const pc = await computer("Studio")
    const phone = await openPhone()
    await phone.setDeviceName("Pixel")
    const { run } = await pair(pc, phone)
    const link = await run.done
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "online",
    )
    // The switch "Can create and change agents" is off for a phone, and the request works.
    await expect(phone.request(link.id, "agents.create", {})).rejects.toMatchObject({
      code: "change_off",
    })
    const model = await phone.request<ChartModel>(link.id, "orgChart.model", {
      serverId: pc.local.id,
    })
    // The model is ready for a list: the nodes in order, the state and the counts of each block.
    expect(model.root).toBeNull()
    expect(model.channels.map((c) => [c.name, c.memberCount])).toEqual([["", 1]])
    expect(model.channels[0]?.nodes.map((n) => [n.name, n.state])).toEqual([["Ada", "idle"]])
    expect(model.channels[0]?.counts).toEqual({ working: 0, waiting: 0, idle: 1, offline: 0 })
    // A change on the computer shows in the next read. The phone stays online.
    await pc.run(Agents.use((x) => x.update(pc.agent.id, { name: "Ada L" })))
    const again = await waitFor(
      () => phone.request<ChartModel>(link.id, "orgChart.model", { serverId: pc.local.id }),
      (m) => m.channels[0]?.nodes[0]?.name === "Ada L",
    )
    expect(again.channels[0]?.nodes[0]?.name).toBe("Ada L")
    expect(view(phone, link.id).state).toBe("online")
  }, 30_000)
  test("the phone watches the org chart: the model, the pushes, nothing held while the server is not online, and a new read when it is back", async () => {
    const pc = await computer("Studio")
    const storage = new MemoryStorage()
    const phone = await openPhone(storage)
    await phone.setDeviceName("Pixel")
    const { run } = await pair(pc, phone)
    const link = await run.done
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "online",
    )
    await phone.flush()
    const filesBefore = [...storage.files.keys()].sort()

    const phases: OrgChartPhase[] = []
    const watch = phone.watchOrgChart(link.id, (p) => phases.push(p))
    const last = () => phases.at(-1)
    const names = (p: OrgChartPhase | undefined) =>
      p?.kind === "ready" ? p.model.channels.flatMap((c) => c.nodes.map((n) => n.name)) : null
    // The first model comes from the request.
    await waitFor(last, (p) => p?.kind === "ready")
    expect(phases[0]).toEqual({ kind: "loading" })
    expect(names(last())).toEqual(["Ada"])

    // A change on the computer comes as a push. The phone asks nothing again for it.
    await pc.run(Agents.use((x) => x.update(pc.agent.id, { name: "Ada L" })))
    await waitFor(last, (p) => names(p)?.[0] === "Ada L")

    // The computer does not accept connections: the phone goes away from "online", and the chart
    // is not held. The phase is "off", with no model.
    await pc.run(Devices.use((d) => Effect.promise(() => d.setAccept(false))))
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s !== "online",
    )
    await waitFor(last, (p) => p?.kind === "off")
    const whileAway = phases.length

    // The computer accepts again: the phone reads the chart again by itself.
    await pc.run(Devices.use((d) => Effect.promise(() => d.setAccept(true))))
    phone.reconnect(link.id)
    await waitFor(last, (p) => p?.kind === "ready")
    expect(phases.slice(whileAway).map((p) => p.kind)).toEqual(["loading", "ready"])
    expect(names(last())).toEqual(["Ada L"])

    // Nothing of the chart is on the disk of the phone.
    await phone.flush()
    expect([...storage.files.keys()].sort()).toEqual(filesBefore)

    // Stopping the watch ends it: a later change tells nobody.
    watch.stop()
    const count = phases.length
    await pc.run(Agents.use((x) => x.update(pc.agent.id, { name: "Ada M" })))
    await Bun.sleep(600)
    expect(phases).toHaveLength(count)
  }, 40_000)

  test("a server answers an unknown request with Not allowed, and that is what the phone takes for an older server", async () => {
    const pc = await computer("Old")
    const phone = await openPhone()
    await phone.setDeviceName("Pixel")
    const { run } = await pair(pc, phone)
    const link = await run.done
    await waitFor(
      () => view(phone, link.id).state,
      (s) => s === "online",
    )
    const error = await phone.request(link.id, "orgChart.no-such-request", {}).catch((e) => e)
    expect(error).toMatchObject({ code: "not_allowed" })
    expect(unsupportedByServer(error)).toBe(true)
  }, 30_000)
})
