import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ChatMessage, messageText } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Devices } from "./Devices.ts"
import { Providers } from "./Providers.ts"
import { Remote } from "./Remote.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

type Rt = ReturnType<typeof testRuntime>

// A model that echoes the last line, so a send gives a reply without a real provider.
const sse = (lines: string[]) =>
  new Response(lines.map((l) => `data: ${l}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
const model = Bun.serve({
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    return sse([
      JSON.stringify({ choices: [{ delta: { content: `Echo: ${last.split("\n").at(-1)}` } }] }),
      "[DONE]",
    ])
  },
})
afterAll(() => model.stop())

const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

const waitFor = async <T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40))
    last = await read()
  }
  return last
}

/** B opens A: A shows the pairing, B joins, and A's user allows. */
const link = async (a: Rt, b: Rt) => {
  const pairing = await a.runtime.runPromise(Devices.use((d) => d.pairStart()))
  const found = await b.runtime.runPromise(Remote.use((r) => r.probe({ link: pairing.link })))
  const done = b.runtime.runPromise(Remote.use((r) => r.finish(found.session, false)))
  await waitFor(
    () => a.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.joins()))),
    (j) => j.length > 0,
  )
  await a.runtime.runPromise(
    Devices.use((d) =>
      Effect.sync(() => d.joins()[0]).pipe(Effect.flatMap((j) => d.decide(j?.id ?? "", true))),
    ),
  )
  const entry = await done
  await waitFor(
    () => b.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.stateOf(entry.id)))),
    (state) => state === "online",
  )
  return entry
}

const invoke = (b: Rt, serverId: string, method: string, input: unknown) =>
  b.runtime.runPromise(Remote.use((r) => Effect.promise(() => r.invoke(serverId, method, input))))

beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
  process.env.ROBOT_LINK_RETRY_MAX_MS = "300"
})
afterAll(async () => {
  for (const s of sides) await s.runtime.dispose()
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
})

/** Computer A with an agent that has a working model, and computer B that opens A. */
const setup = async () => {
  const a = side("MacBook 2")
  const b = side("MacBook 1")
  const account = await a.runtime.runPromise(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${model.port}/v1`,
        apiKey: "k",
      }),
    ),
  )
  const local = await a.runtime.runPromise(Servers.use((s) => s.local))
  const agent = await a.runtime.runPromise(
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
  const entry = await link(a, b)
  const history = (rt: Rt) => rt.runtime.runPromise(Chat.use((c) => c.history(agent.id)))
  return { a, b, local, agent, entry, history }
}

describe("a computer that opens a linked server", () => {
  test("reads, a send and its reply go over the link, and the message says who sent it", async () => {
    const { a, b, local, agent, history } = await setup()
    const list = await invoke(b, local.id, "agents.list", { serverId: local.id, archived: false })
    expect(list.ok && (list.value as { name: string }[]).map((x) => x.name)).toEqual(["Ada"])

    const sent = await invoke(b, local.id, "chat.send", {
      agentId: agent.id,
      text: "hello",
      replyTo: null,
    })
    expect(sent.ok).toBe(true)
    await waitFor(
      () => history(a),
      (h) => h.messages.length === 2 && h.messages.every((m) => m.status === "done"),
    )
    const { messages } = await history(a)
    expect(messageText(messages[1] as ChatMessage)).toBe("Echo: hello")
    // The server records the device. The server's own window sees "from MacBook 1".
    expect(messages[0]?.fromDevice).toBe("MacBook 1")
    expect(messages[1]?.fromDevice).toBeNull()

    // The window of B got the live messages, and the history it reads now has the reply too.
    const live = b.events
      .filter((e) => e.event === "chat.message")
      .map((e) => (e.payload as ChatMessage).id)
    expect(live).toContain(messages[1]?.id as string)
    const read = await invoke(b, local.id, "chat.history", { agentId: agent.id })
    expect(read.ok && (read.value as { messages: unknown[] }).messages.length).toBe(2)
  })

  test("what a server pushes goes to the window, and not on to the devices linked to this computer", async () => {
    const { b, local, agent } = await setup()
    // C opens B, while B opens A. The events of A are for the window of B only.
    const c = side("MacBook 3")
    await link(b, c)
    await invoke(b, local.id, "chat.send", { agentId: agent.id, text: "hi", replyTo: null })
    await waitFor(
      () =>
        b.events.filter(
          (e) => e.event === "chat.message" && (e.payload as ChatMessage).status === "done",
        ).length,
      (n) => n >= 2,
    )
    // B's own events reach its window, and A's events are among them.
    expect(b.events.some((e) => e.event === "chat.message")).toBe(true)
    // Give a leak time to show, then look at what C got from B.
    await new Promise((r) => setTimeout(r, 400))
    expect(c.events.filter((e) => e.event === "chat.message")).toEqual([])
    expect(
      c.events.filter(
        (e) =>
          e.event === "places.changed" && (e.payload as { serverId: string }).serverId === local.id,
      ),
    ).toEqual([])
  })

  test("a request outside the list is not allowed, and so is a method that does not exist", async () => {
    const { b, local, agent } = await setup()
    for (const method of [
      "agents.delete",
      "agents.restore",
      "settings.update",
      "routines.list",
      "tasks.retry",
    ]) {
      const r = await invoke(b, local.id, method, { id: agent.id, serverId: local.id })
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error.code).toBe("not_allowed")
    }
    const gone = await invoke(b, "no-such-server", "agents.list", {
      serverId: "x",
      archived: false,
    })
    expect(!gone.ok && gone.error.code).toBe("server_not_found")
  })

  test("files go up in pieces and come down again, and a path does not work as a file", async () => {
    const { a, b, local, agent, entry, history } = await setup()
    const folder = mkdtempSync(join(tmpdir(), "robot-files-"))
    const source = join(folder, "report.txt")
    const content = "x".repeat(400_000) // more than two pieces
    writeFileSync(source, content)

    const sent = await invoke(b, local.id, "chat.send", {
      agentId: agent.id,
      text: "see file",
      replyTo: null,
      files: [source],
    })
    expect(sent.ok).toBe(true)
    const stored = await waitFor(
      () => history(a),
      (h) => h.messages.length >= 1,
    )
    const file = stored.messages[0]?.parts.find((p) => p.kind === "file") as
      | { path: string; size: number }
      | undefined
    expect(file?.size).toBe(content.length)
    expect(file?.path).toBe("attachments/report.txt")
    const workspace = (await a.runtime.runPromise(Agents.use((x) => x.get(agent.id)))).workspace
    expect(readFileSync(join(workspace, "attachments", "report.txt"), "utf8")).toBe(content)
    // The uploaded copies on the server are gone after the message used them.
    expect(await a.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.uploads.count)))).toBe(
      0,
    )

    // "Save as": the file comes down in pieces.
    b.shell.savePath = join(folder, "saved.txt")
    const saved = await invoke(b, local.id, "attachments.save", {
      agentId: agent.id,
      path: "attachments/report.txt",
      name: "report.txt",
    })
    expect(saved.ok && (saved.value as { saved: boolean }).saved).toBe(true)
    expect(readFileSync(join(folder, "saved.txt"), "utf8")).toBe(content)
    // A cancelled dialog saves nothing.
    b.shell.savePath = undefined
    const cancelled = await invoke(b, local.id, "attachments.save", {
      agentId: agent.id,
      path: "attachments/report.txt",
      name: "report.txt",
    })
    expect(cancelled.ok && (cancelled.value as { saved: boolean }).saved).toBe(false)

    // A path on the server is not a file of the client, and a path outside `attachments` is not served.
    const secret = join(folder, "secret.txt")
    writeFileSync(secret, "secret")
    const asPath = await b.runtime.runPromise(
      Remote.use((r) =>
        Effect.promise(() =>
          r
            .request(entry.id, "chat.send", {
              agentId: agent.id,
              text: "x",
              replyTo: null,
              files: [secret],
            })
            .then(
              () => "sent",
              (e: { code: string }) => e.code,
            ),
        ),
      ),
    )
    expect(asPath).toBe("upload_gone")
    for (const path of [
      "../secret.txt",
      "attachments/../../x",
      "/etc/passwd",
      "attachments/sub/x",
    ]) {
      const code = await b.runtime.runPromise(
        Remote.use((r) =>
          Effect.promise(() =>
            r.request(entry.id, "attachment.download", { agentId: agent.id, path, offset: 0 }).then(
              () => "served",
              (e: { code: string }) => e.code,
            ),
          ),
        ),
      )
      expect(code).not.toBe("served")
    }
    expect(existsSync(join(workspace, "attachments"))).toBe(true)
    expect(readdirSync(join(workspace, "attachments"))).toEqual(["report.txt"])
  })

  test("with the server away, reads come from the cache, writes say it is offline, and it comes back", async () => {
    const { a, b, local, agent, entry } = await setup()
    await invoke(b, local.id, "chat.send", { agentId: agent.id, text: "before", replyTo: null })
    await waitFor(
      () => invoke(b, local.id, "chat.history", { agentId: agent.id }),
      (r) =>
        r.ok &&
        (r.value as { messages: { status: string }[] }).messages.filter((m) => m.status === "done")
          .length === 2,
    )
    await invoke(b, local.id, "places.list", { serverId: local.id })

    // The server stops accepting: the window of B reads the last known state.
    await a.runtime.runPromise(Devices.use((d) => d.update({ accept: false })))
    await waitFor(
      () => b.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.stateOf(entry.id)))),
      (s) => s !== "online",
    )
    const cached = await invoke(b, local.id, "chat.history", { agentId: agent.id })
    expect(cached.ok && (cached.value as { messages: unknown[] }).messages.length).toBe(2)
    const places = await invoke(b, local.id, "places.list", { serverId: local.id })
    expect(places.ok).toBe(true)
    // A place that was never opened is not in the cache.
    const unknown = await invoke(b, local.id, "chat.history", { agentId: "other" })
    expect(!unknown.ok && unknown.error.code).toBe("offline")
    const write = await invoke(b, local.id, "chat.send", {
      agentId: agent.id,
      text: "now",
      replyTo: null,
    })
    expect(!write.ok && write.error.code).toBe("offline")

    // On again: the same link works with no new pairing.
    await a.runtime.runPromise(Devices.use((d) => d.update({ accept: true })))
    await waitFor(
      () => b.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.stateOf(entry.id)))),
      (s) => s === "online",
      15000,
    )
    const back = await invoke(b, local.id, "chat.send", {
      agentId: agent.id,
      text: "again",
      replyTo: null,
    })
    expect(back.ok).toBe(true)
  })

  test("after access is removed the link says not allowed and the cache is gone", async () => {
    const { a, b, local, agent, entry } = await setup()
    await invoke(b, local.id, "chat.send", { agentId: agent.id, text: "one", replyTo: null })
    await waitFor(
      () => invoke(b, local.id, "chat.history", { agentId: agent.id }),
      (r) => r.ok && (r.value as { messages: unknown[] }).messages.length === 2,
    )
    const clientId =
      (await a.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.state())))).clients[0]
        ?.id ?? ""
    const countOf = (event: string) => b.events.filter((e) => e.event === event).length
    const toldBefore = countOf("places.changed")
    await a.runtime.runPromise(Devices.use((d) => d.removeClient(clientId)))
    await waitFor(
      () => b.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.stateOf(entry.id)))),
      (s) => s === "not_allowed",
    )
    const read = await invoke(b, local.id, "chat.history", { agentId: agent.id })
    expect(!read.ok && read.error.code).toBe("not_allowed")
    // Cached reads are gone too: a list that was read before does not come back from disk.
    const places = await invoke(b, local.id, "places.list", { serverId: local.id })
    expect(!places.ok && places.error.code).toBe("not_allowed")
    // The window is told to read its lists again, so it drops what it showed of that server.
    expect(countOf("places.changed")).toBeGreaterThan(toldBefore)
    expect(countOf("channels.changed")).toBeGreaterThan(0)
  })
})
