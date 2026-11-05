import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatMessage, MessagePart, PermissionLevel } from "@robot/shared"
import { Effect, ManagedRuntime } from "effect"
import { unzipSync } from "fflate"
import { appLayer } from "../layers.ts"
import { ActionLog } from "./ActionLog.ts"
import { AgentSettings } from "./AgentSettings.ts"
import { Agents } from "./Agents.ts"
import { Chat, type TaskOrigin } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tools } from "./Tools.ts"
import { testPlatform, testRuntime } from "./testing.ts"

const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks)
          controller.enqueue(
            enc.encode(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`),
          )
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

/** The request bodies that reached the model, newest last. */
const bodies: { model: string; tools?: { function: { name: string } }[] }[] = []

/** A model that calls the tools listed in the user text ("CALLS [...]"), then answers. */
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models")
      return Response.json({
        data: [
          { id: "mock-fast" },
          { id: "o3-mini" },
          { id: "claude-sonnet-4-5" },
          { id: "claude-haiku-5-5" },
          { id: "claude-3-5-haiku-latest" },
        ],
      })
    const body = (await req.json()) as {
      model: string
      messages: { role: string; content: string | null }[]
    }
    bodies.push(body)
    const last = body.messages.at(-1)
    if (last?.role === "tool")
      return sse([{ choices: [{ delta: { content: "Done." } }] }, "[DONE]"])
    const match = /CALLS (\[.*\])/.exec(String(last?.content ?? ""))
    if (!match) return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])
    const calls = JSON.parse(match[1] as string) as { name: string; args: unknown }[]
    return sse([
      {
        choices: [
          {
            delta: {
              tool_calls: calls.map((c, index) => ({
                index,
                id: `call_${index + 1}`,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
          },
        ],
      },
      "[DONE]",
    ])
  },
})
afterAll(() => server.stop())

const settings = (args: unknown) => `CALLS ${JSON.stringify([{ name: "settings", args }])}`

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const setup = async (permission: PermissionLevel = "ask_risky") => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-settings-test-key",
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
        model: { accountId: account.id, model: "mock-fast", effort: null },
      }),
    ),
  )
  await run(Agents.use((a) => a.update(agent.id, { permission })))
  mkdirSync(agent.workspace, { recursive: true })
  const send = (text: string, origin?: TaskOrigin) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null }, origin)))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages
      .filter((m) => m.author === "agent")
      .at(-1)
  const part = async (callId = "call_1") =>
    (await reply())?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === callId)
  const count = async () =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages.filter((m) => m.author === "agent")
      .length
  /** Sends a text and waits until the reply to it is done. */
  const turn = async (text: string, origin?: TaskOrigin) => {
    const before = await count()
    await send(text, origin)
    await until(async () => (await count()) > before && (await reply())?.status !== "streaming")
    return reply()
  }
  const current = () => run(Agents.use((a) => a.get(agent.id)))
  const history = () => run(AgentSettings.use((s) => s.history(agent.id)))
  const line = async () => {
    const message = await reply()
    return run(AgentSettings.use((s) => s.lineState(agent.id, message?.id ?? "", "call_1")))
  }
  const undo = async () => {
    const message = await reply()
    return run(AgentSettings.use((s) => s.undo(agent.id, message?.id ?? "", "call_1")))
  }
  return { t, run, agent, account, send, turn, reply, part, current, history, line, undo }
}

describe("the settings tool (spec 002, Changes from the chat)", () => {
  test("a loose model name changes the model; the next turn uses it; Undo puts the old one back", async () => {
    const s = await setup()
    await s.turn(settings({ model: "Sonnet" }))
    const part = await s.part()
    expect(part?.state).toBe("done")
    expect(part?.settings).toEqual({
      changes: [
        {
          field: "model",
          before: { accountId: s.account.id, model: "mock-fast", effort: null },
          after: { accountId: s.account.id, model: "claude-sonnet-4-5", effort: null },
        },
      ],
    })
    expect((await s.current()).model?.model).toBe("claude-sonnet-4-5")
    // The change was a guarded step that ran with no question in a turn of the user (spec 007).
    expect(await s.run(ActionLog.use((l) => l.list()))).toMatchObject([
      { kind: "settings", decidedBy: "level", result: "ran", outside: null },
    ])
    expect(await s.line()).toBe("ready")

    await s.turn("hello")
    expect(bodies.at(-1)?.model).toBe("claude-sonnet-4-5")

    // Undo on the line of the older reply.
    const messages = (await s.run(Chat.use((c) => c.history(s.agent.id)))).messages
    const changeReply = messages.filter((m) => m.author === "agent").at(-2) as ChatMessage
    await s.run(AgentSettings.use((x) => x.undo(s.agent.id, changeReply.id, "call_1")))
    expect((await s.current()).model?.model).toBe("mock-fast")
    expect(
      await s.run(AgentSettings.use((x) => x.lineState(s.agent.id, changeReply.id, "call_1"))),
    ).toBe("undone")
  })

  test("a question reads the settings and changes nothing", async () => {
    const s = await setup()
    await s.turn(settings({}))
    const part = await s.part()
    expect(part?.settings).toBeUndefined()
    expect(part?.output).toContain("- model: mock-fast")
    expect(part?.output).toContain("claude-sonnet-4-5")
    expect(part?.output).toContain("You cannot change these")
    expect((await s.current()).model?.model).toBe("mock-fast")
    expect(await s.run(ActionLog.use((l) => l.list()))).toEqual([])
  })

  test("several matching models and a protected field change nothing", async () => {
    const s = await setup()
    await s.turn(settings({ model: "haiku" }))
    let part = await s.part()
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("claude-haiku-5-5")
    expect(part?.output).toContain("claude-3-5-haiku-latest")
    expect((await s.current()).model?.model).toBe("mock-fast")

    await s.turn(settings({ permission: "full" }))
    part = await s.part()
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("The permission level: the user changes it in the profile")
    expect((await s.current()).permission).toBe("ask_risky")
  })

  test("the agent cannot turn on the switch 'Main agent' for itself: it learns where the user does it, and the flag stays off (spec 002)", async () => {
    const s = await setup()
    await s.turn(settings({ main_agent: true }))
    const part = await s.part()
    expect(part?.state).toBe("failed")
    expect(part?.output).toContain("The main agent switch: the user turns it on in the profile")
    expect((await s.current()).isMain).toBe(false)
  })

  test("the app settings change at once", async () => {
    const s = await setup()
    await s.turn(settings({ theme: "light", compact_place_list: true }))
    const app = await s.run(SettingsStore.use((x) => x.get))
    expect(app.theme).toBe("light")
    expect(app.compactPlaces).toBe(true)
    expect(s.t.events.some((e) => e.event === "settings.changed")).toBe(true)
    // A change of the app settings by the user since then turns Undo off.
    await s.run(SettingsStore.use((x) => x.update({ theme: "dark" })))
    expect(await s.line()).toBe("changed")
    await expect(s.undo()).rejects.toMatchObject({ code: "settings_changed_again" })
  })

  test("a turn that the user did not start asks before the change", async () => {
    const s = await setup()
    await s.send(settings({ name: "Ava" }), { source: "routine", sourceId: "r1" })
    await until(async () => (await s.part())?.state === "waiting")
    expect((await s.part())?.ask).toMatchObject({ kind: "approval", once: true })
    expect((await s.current()).name).toBe("Ada")
    await s.run(Tools.use((x) => x.respond(s.agent.id, "call_1", "allow")))
    await until(async () => (await s.reply())?.status === "done")
    expect((await s.current()).name).toBe("Ava")
  })

  test("at Read only a question reads, and a change is refused by the guard and logged with the level", async () => {
    const s = await setup("read_only")
    await s.turn(settings({}))
    expect((await s.part())?.output).toContain("- model: mock-fast")
    expect(await s.run(ActionLog.use((l) => l.list()))).toEqual([])
    await s.turn(settings({ name: "Ava" }))
    expect((await s.part())?.state).toBe("failed")
    expect((await s.current()).name).toBe("Ada")
    expect(await s.run(ActionLog.use((l) => l.list()))).toMatchObject([
      { kind: "settings", decidedBy: "level", result: "refused" },
    ])
  })

  test("an agent of a vendor program does not get the tool", async () => {
    const s = await setup()
    const names = (o: { settings?: boolean }) =>
      s.run(
        Tools.use((x) =>
          Effect.sync(() => x.defs({ memory: true, knowledge: false, ...o }).map((d) => d.name)),
        ),
      )
    expect(await names({ settings: true })).toContain("settings")
    expect(await names({ settings: false })).not.toContain("settings")
    expect(await names({})).not.toContain("settings")
    await s.turn("hello")
    expect(bodies.at(-1)?.tools?.map((d) => d.function.name)).toContain("settings")
  })
})

describe("the instruction history (spec 002)", () => {
  test("a change from the chat adds a version; a restore adds one more; Undo is then off", async () => {
    const s = await setup()
    await s.turn(settings({ instructions: "Answer in Korean." }))
    expect((await s.current()).instructions).toBe("Answer in Korean.")
    let versions = await s.history()
    expect(versions.map((v) => [v.source, v.text])).toEqual([
      ["chat", "Answer in Korean."],
      ["profile", "Be brief."],
    ])
    expect((await s.part())?.settings?.versionId).toBe(versions[0]?.id)
    expect(await s.line()).toBe("ready")

    await s.run(AgentSettings.use((x) => x.restore(s.agent.id, versions[1]?.id ?? "")))
    expect((await s.current()).instructions).toBe("Be brief.")
    versions = await s.history()
    expect(versions.map((v) => v.source)).toEqual(["restore", "chat", "profile"])
    expect(await s.line()).toBe("changed")
  })

  test("Undo of an instructions change is a version from Undo", async () => {
    const s = await setup()
    await s.turn(settings({ instructions: "Answer in Korean." }))
    await s.undo()
    expect((await s.current()).instructions).toBe("Be brief.")
    expect((await s.history()).map((v) => v.source)).toEqual(["undo", "chat", "profile"])
    expect(await s.line()).toBe("undone")
    expect((await s.part())?.settings?.undone).toBe(true)
  })

  test("the profile and a save with the same text; at most 50 versions stay", async () => {
    const s = await setup()
    const update = (instructions: string) =>
      s.run(Agents.use((a) => a.update(s.agent.id, { instructions })))
    await update("Be brief.")
    expect(await s.history()).toEqual([])
    for (let i = 1; i <= 60; i++) await update(`Version ${i}`)
    const versions = await s.history()
    expect(versions).toHaveLength(50)
    expect(versions[0]).toMatchObject({ text: "Version 60", source: "profile" })
    expect(versions.at(-1)?.text).toBe("Version 11")
  })

  test("an export holds the history with keys hidden; deleting the agent deletes it", async () => {
    const { platform, dataDir } = testPlatform()
    const out = join(dataDir, "export.zip")
    const runtime = ManagedRuntime.make(
      appLayer({
        platform: { ...platform, pickSavePath: async () => out },
        databaseFile: ":memory:",
        localServerName: "T",
        emit: () => {},
        secrets: Secrets.memory,
      }),
    )
    const run = runtime.runPromise
    const local = await run(Servers.use((s) => s.local))
    const agent = await run(
      Agents.use((a) =>
        a.create({ serverId: local.id, name: "Ada", role: "", instructions: "One", model: null }),
      ),
    )
    const key = "sk-history-0123456789abcdefghij"
    await run(Agents.use((a) => a.update(agent.id, { instructions: `Use ${key}` })))
    await run(Data.use((d) => d.export()))
    const copy = join(dataDir, "copy.db")
    await Bun.write(copy, unzipSync(readFileSync(out))["robot.db"] as Uint8Array)
    const { DatabaseSync } = await import("node:sqlite")
    const exported = new DatabaseSync(copy)
    const rows = exported
      .prepare("SELECT text, source FROM instruction_version ORDER BY created_at")
      .all() as { text: string; source: string }[]
    exported.close()
    expect(rows).toEqual([
      { text: "One", source: "profile" },
      { text: "Use [redacted]", source: "profile" },
    ])

    await run(Agents.use((a) => a.archive(agent.id)))
    await run(Agents.use((a) => a.remove(agent.id)))
    const db = await run(Database.use((d) => Effect.succeed(d)))
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM instruction_version")?.n).toBe(0)
    await runtime.dispose()
  })
})
