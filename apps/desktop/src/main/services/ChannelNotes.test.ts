import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Database } from "./Database.ts"
import { Memory } from "./Memory.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// Channel notes (spec 008, "Channel notes"; 004; 019): a memory item that names one channel.

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
const delta = (content: string) => ({ choices: [{ delta: { content } }] })

/** What the stand-in model was sent: the whole request text of each call. */
const seen: string[] = []
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
    if (last?.role === "tool") return sse([delta(`Tool result: ${last.content}`), "[DONE]"])
    seen.push(JSON.stringify(body.messages))
    const call = /TOOL (\w+) (\{.*\})/.exec(last?.content ?? "")
    if (call && body.tools)
      return sse([
        {
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
        "[DONE]",
      ])
    return sse([delta("Noted."), "[DONE]"])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
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
        apiKey: "sk-notes-test-key",
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
          instructions: `You are ${name}.`,
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  const [bo, cy] = await Promise.all([agent("Bo"), agent("Cy")])
  const channel = (name: string, memberIds: string[]) =>
    run(
      Channels.use((c) =>
        c.create({ serverId: local.id, name, topic: "", memberIds, leadId: null }),
      ),
    )
  const launch = await channel("Launch", [bo.id, cy.id])
  const design = await channel("Design", [bo.id])
  const memory = <A, E>(f: (m: Memory["Service"]) => Effect.Effect<A, E>) => run(Memory.use(f))
  const note = (agentId: string, text: string, channelId?: string) =>
    memory((m) => m.save(agentId, text, undefined, channelId))
  const items = (agentId: string, filter?: Parameters<Memory["Service"]["list"]>[2]) =>
    memory((m) => m.list(agentId, undefined, filter))
  const reads = (agentId: string, channelId?: string) =>
    memory((m) => Effect.succeed(m.forTurn(agentId, "anything", channelId))).then((list) =>
      list.map((i) => i.text),
    )
  const history = (agentId: string) => memory((m) => m.history(agentId))
  const exit = <A, E>(effect: Effect.Effect<A, E, Memory | Channels | Database>) =>
    t.runtime.runPromiseExit(effect)
  const setMembers = (id: string, memberIds: string[]) =>
    run(Channels.use((c) => c.update(id, { memberIds })))
  const idle = () =>
    until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      return all.length > 0 && all.every((x) => !["queued", "running"].includes(x.state))
    })
  return {
    ...t,
    run,
    bo,
    cy,
    launch,
    design,
    memory,
    note,
    items,
    reads,
    history,
    exit,
    setMembers,
    idle,
    channel,
  }
}

const code = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

describe("the channel of an item", () => {
  test("a save with a channel makes a note; the list tells the channel and the membership", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Prefers short answers")
    const made = await s.note(s.bo.id, "Launch is on Friday", s.launch.id)
    expect(made.kind).toBe("saved")
    const list = await s.items(s.bo.id)
    expect(list.map((i) => [i.text, i.channel])).toEqual([
      ["Launch is on Friday", { id: s.launch.id, name: "Launch", member: true }],
      ["Prefers short answers", null],
    ])
    // The history row of the note tells the channel.
    const [row] = await s.history(s.bo.id)
    expect(row).toMatchObject({
      kind: "added",
      actor: "agent",
      channelBefore: null,
      channelAfter: { id: s.launch.id, name: "Launch" },
    })
  })

  test("a save for a channel that the agent is not a member of is refused", async () => {
    const s = await setup()
    const out = await s.note(s.cy.id, "Design uses tabs", s.design.id)
    expect(out.kind).toBe("not_member")
    expect(await s.items(s.cy.id)).toEqual([])
    const gone = await s.note(s.cy.id, "x", "no-such-channel")
    expect(gone.kind).toBe("not_member")
  })

  test("the filter keeps all items, the general items, or the notes of one channel", async () => {
    const s = await setup()
    await s.note(s.bo.id, "General one")
    await s.note(s.bo.id, "Launch note", s.launch.id)
    await s.note(s.bo.id, "Design note", s.design.id)
    const texts = async (filter: Parameters<Memory["Service"]["list"]>[2]) =>
      (await s.items(s.bo.id, filter)).map((i) => i.text).sort()
    expect(await texts(undefined)).toEqual(["Design note", "General one", "Launch note"])
    expect(await texts({ kind: "all" })).toEqual(["Design note", "General one", "Launch note"])
    expect(await texts({ kind: "general" })).toEqual(["General one"])
    expect(await texts({ kind: "channel", id: s.launch.id })).toEqual(["Launch note"])
    // The search and the filter work together.
    const found = await s.memory((m) =>
      m.list(s.bo.id, "note", { kind: "channel", id: s.design.id }),
    )
    expect(found.map((i) => i.text)).toEqual(["Design note"])
  })

  test("the scopes list the channels with notes and the channels the agent is a member of", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    await s.note(s.bo.id, "Another launch note", s.launch.id)
    // Cy is a member of Launch only and has no note.
    expect(await s.memory((m) => m.scopes(s.bo.id))).toEqual([
      { id: s.design.id, name: "Design", notes: 0, member: true },
      { id: s.launch.id, name: "Launch", notes: 2, member: true },
    ])
    expect(await s.memory((m) => m.scopes(s.cy.id))).toEqual([
      { id: s.launch.id, name: "Launch", notes: 0, member: true },
    ])
    // After the agent leaves, the channel stays in the list because of its notes.
    await s.setMembers(s.launch.id, [s.cy.id])
    expect(await s.memory((m) => m.scopes(s.bo.id))).toEqual([
      { id: s.design.id, name: "Design", notes: 0, member: true },
      { id: s.launch.id, name: "Launch", notes: 2, member: false },
    ])
  })
})

describe("what a turn reads", () => {
  test("a direct chat reads the general items only; a channel reads them and its own notes", async () => {
    const s = await setup()
    await s.note(s.bo.id, "General one")
    await s.note(s.bo.id, "Launch note", s.launch.id)
    await s.note(s.bo.id, "Design note", s.design.id)
    expect(await s.reads(s.bo.id)).toEqual(["General one"])
    expect((await s.reads(s.bo.id, s.launch.id)).sort()).toEqual(["General one", "Launch note"])
    expect((await s.reads(s.bo.id, s.design.id)).sort()).toEqual(["Design note", "General one"])
  })

  test("an agent that is not a member does not read the note; it reads it again after it joins", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    await s.setMembers(s.launch.id, [s.cy.id])
    expect(await s.reads(s.bo.id, s.launch.id)).toEqual([])
    // The note is kept, and the list marks it.
    const [item] = await s.items(s.bo.id)
    expect(item).toMatchObject({ text: "Launch note", channel: { member: false } })
    await s.setMembers(s.launch.id, [s.bo.id, s.cy.id])
    expect(await s.reads(s.bo.id, s.launch.id)).toEqual(["Launch note"])
    expect((await s.items(s.bo.id))[0]?.channel?.member).toBe(true)
  })

  test("memory off: a channel turn reads nothing", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    await s.run(Agents.use((a) => a.update(s.bo.id, { memoryEnabled: false })))
    expect(await s.reads(s.bo.id, s.launch.id)).toEqual([])
    expect(await s.items(s.bo.id)).toHaveLength(1)
  })

  test("a turn of a channel gets the notes of that channel in its request; another channel does not", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note about tea", s.launch.id)
    await s.note(s.bo.id, "Design note about glass", s.design.id)
    await s.note(s.bo.id, "General note about rain")
    seen.length = 0
    await s.run(Channels.use((c) => c.send(s.launch.id, "@Bo hello there")))
    await s.idle()
    const request = seen.find((r) => r.includes("hello there")) ?? ""
    expect(request).toContain("What you remember")
    expect(request).toContain("Launch note about tea")
    expect(request).toContain("General note about rain")
    expect(request).not.toContain("Design note about glass")
  })

  test("the agent chooses: for_channel in a channel turn saves a note; without it, a general item", async () => {
    const s = await setup()
    const call = (args: object) => `@Bo TOOL save_memory ${JSON.stringify(args)}`
    await s.run(
      Channels.use((c) => c.send(s.launch.id, call({ text: "Ship on Friday", for_channel: true }))),
    )
    await s.idle()
    await s.run(Channels.use((c) => c.send(s.launch.id, call({ text: "Likes short replies" }))))
    await until(async () => (await s.items(s.bo.id)).length === 2)
    await s.idle()
    const byText = Object.fromEntries((await s.items(s.bo.id)).map((i) => [i.text, i.channel?.id]))
    expect(byText).toEqual({ "Ship on Friday": s.launch.id, "Likes short replies": undefined })
  })
})

describe("saving rules for a note", () => {
  test("a fact is known when the agent reads it in the same place", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Use tabs", s.launch.id)
    // The same text for the same channel, or as a general item that the channel would read: known
    // only in the first case. A general item is a wider save, so it is not known.
    expect((await s.note(s.bo.id, " use TABS ", s.launch.id)).kind).toBe("known")
    expect((await s.note(s.bo.id, "Use tabs", s.design.id)).kind).toBe("saved")
    expect((await s.note(s.bo.id, "Use tabs")).kind).toBe("saved")
    // A general item makes the note redundant, so a note with that text is known.
    await s.note(s.bo.id, "Be brief")
    expect((await s.note(s.bo.id, "be brief", s.launch.id)).kind).toBe("known")
  })

  test("with 'Ask me first' the proposal names the channel; Save makes the note", async () => {
    const s = await setup()
    await s.memory((m) => m.setMode(s.bo.id, "ask"))
    const out = await s.note(s.bo.id, "Launch is on Friday", s.launch.id)
    expect(out.kind).toBe("suggested")
    expect(await s.items(s.bo.id)).toEqual([])
    const [proposal] = await s.memory((m) => m.proposals(s.bo.id))
    expect(proposal?.channel).toEqual({ id: s.launch.id, name: "Launch" })
    // The same text as a proposal for the same channel is known; for no channel it is not.
    expect((await s.note(s.bo.id, "launch is on friday", s.launch.id)).kind).toBe("known")
    expect((await s.note(s.bo.id, "launch is on friday")).kind).toBe("suggested")
    await s.memory((m) => m.accept(proposal?.id ?? ""))
    const [item] = await s.items(s.bo.id, { kind: "channel", id: s.launch.id })
    expect(item).toMatchObject({ text: "Launch is on Friday", source: "proposal" })
    const [row] = await s.history(s.bo.id)
    expect(row).toMatchObject({
      actor: "proposal",
      kind: "added",
      channelAfter: { id: s.launch.id },
    })
  })

  test("a note counts in the limit of proposals, as a general item does", async () => {
    const s = await setup()
    await s.memory((m) => m.setMode(s.bo.id, "ask"))
    for (let i = 0; i < 21; i++) await s.note(s.bo.id, `Fact ${i}`, i % 2 ? s.launch.id : undefined)
    const waiting = await s.memory((m) => m.proposals(s.bo.id))
    expect(waiting).toHaveLength(20)
    expect(waiting.map((p) => p.text)).not.toContain("Fact 0")
  })

  test("the memory check reads the general items only", async () => {
    const s = await setup()
    await s.note(s.bo.id, "General one")
    await s.note(s.bo.id, "Launch note", s.launch.id)
    expect((await s.items(s.bo.id, { kind: "general" })).map((i) => i.text)).toEqual([
      "General one",
    ])
  })
})

describe("the move", () => {
  test("to General and to a channel that the agent is a member of, with a history row each", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    const [item] = await s.items(s.bo.id)
    const toGeneral = await s.memory((m) => m.move(item?.id ?? "", null))
    expect(toGeneral.channel).toBeNull()
    expect(await s.reads(s.bo.id)).toEqual(["Launch note"])
    const toDesign = await s.memory((m) => m.move(item?.id ?? "", s.design.id))
    expect(toDesign.channel).toMatchObject({ id: s.design.id, member: true })
    expect(await s.reads(s.bo.id)).toEqual([])
    const rows = await s.history(s.bo.id)
    expect(
      rows
        .slice(0, 2)
        .map((r) => [r.actor, r.kind, r.channelBefore?.name ?? null, r.channelAfter?.name ?? null]),
    ).toEqual([
      ["user", "moved", null, "Design"],
      ["user", "moved", "Launch", null],
    ])
    // The text of the item is the same, and a move changes no text.
    expect(rows[0]?.after).toBe("Launch note")
  })

  test("a move to the place where the item is makes no row", async () => {
    const s = await setup()
    await s.note(s.bo.id, "General one")
    const [item] = await s.items(s.bo.id)
    const before = (await s.history(s.bo.id)).length
    await s.memory((m) => m.move(item?.id ?? "", null))
    expect(await s.history(s.bo.id)).toHaveLength(before)
  })

  test("a channel that the agent is not a member of, or that is gone, is refused", async () => {
    const s = await setup()
    await s.note(s.cy.id, "Launch note", s.launch.id)
    const [item] = await s.items(s.cy.id)
    expect(code(await s.exit(Memory.use((m) => m.move(item?.id ?? "", s.design.id))))).toBe(
      "memory_not_member",
    )
    expect(code(await s.exit(Memory.use((m) => m.move(item?.id ?? "", "nope"))))).toBe(
      "channel_not_found",
    )
    expect(code(await s.exit(Memory.use((m) => m.move("nope", null))))).toBe("memory_not_found")
    // A note of a channel that the agent left can still go to General.
    await s.setMembers(s.launch.id, [s.bo.id])
    const moved = await s.memory((m) => m.move(item?.id ?? "", null))
    expect(moved.channel).toBeNull()
  })

  test("Undo of a move puts the item back; it is off after a newer change", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    const [item] = await s.items(s.bo.id)
    await s.memory((m) => m.move(item?.id ?? "", null))
    const [moved] = await s.history(s.bo.id)
    expect(moved?.undo).toEqual({ on: true })
    await s.memory((m) => m.undo(moved?.id ?? ""))
    expect((await s.items(s.bo.id))[0]?.channel?.id).toBe(s.launch.id)
    const rows = await s.history(s.bo.id)
    expect(rows[0]).toMatchObject({ actor: "undo", kind: "moved" })
    // The item is as the add left it again (same text, same channel), so Undo of the add is on.
    const added = rows.find((r) => r.kind === "added")
    expect(added?.undo).toEqual({ on: true })

    // A move, then an edit: the move cannot be undone any more.
    await s.memory((m) => m.move(item?.id ?? "", s.design.id))
    const [second] = await s.history(s.bo.id)
    await s.memory((m) => m.update(item?.id ?? "", "Launch note, edited"))
    const stale = (await s.history(s.bo.id)).find((r) => r.id === second?.id)
    expect(stale?.undo).toEqual({ on: false, why: "newer" })
  })

  test("Undo of a move is off when the channel it came from is gone", async () => {
    const s = await setup()
    const extra = await s.channel("Extra", [s.bo.id])
    await s.note(s.bo.id, "Extra note", extra.id)
    const [item] = await s.items(s.bo.id)
    await s.memory((m) => m.move(item?.id ?? "", s.design.id))
    await s.run(Channels.use((c) => c.remove(extra.id)))
    const [moved] = await s.history(s.bo.id)
    expect(moved).toMatchObject({ kind: "moved", undo: { on: false, why: "channel_gone" } })
    // The name at that time stays in the row.
    expect(moved?.channelBefore).toEqual({ id: extra.id, name: "Extra" })
  })

  test("a move after an add turns Undo of the add off", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    const [item] = await s.items(s.bo.id)
    await s.memory((m) => m.move(item?.id ?? "", null))
    const added = (await s.history(s.bo.id)).find((r) => r.kind === "added")
    expect(added?.undo).toEqual({ on: false, why: "newer" })
  })
})

describe("the delete of a channel", () => {
  test("it deletes the notes of every agent; each gets a history row by the delete of a channel", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Bo launch note", s.launch.id)
    await s.note(s.cy.id, "Cy launch note", s.launch.id)
    await s.note(s.bo.id, "Bo design note", s.design.id)
    await s.note(s.bo.id, "Bo general")
    await s.run(Channels.use((c) => c.remove(s.launch.id)))
    expect((await s.items(s.bo.id)).map((i) => i.text).sort()).toEqual([
      "Bo design note",
      "Bo general",
    ])
    expect(await s.items(s.cy.id)).toEqual([])
    for (const [agent, text] of [
      [s.bo, "Bo launch note"],
      [s.cy, "Cy launch note"],
    ] as const) {
      const row = (await s.history(agent.id)).find((r) => r.actor === "channel_deleted")
      expect(row).toMatchObject({
        kind: "deleted",
        before: text,
        channelBefore: { id: s.launch.id, name: "Launch" },
      })
    }
  })

  test("Undo of such a row makes a general item", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    await s.run(Channels.use((c) => c.remove(s.launch.id)))
    const row = (await s.history(s.bo.id)).find((r) => r.actor === "channel_deleted")
    expect(row?.undo).toEqual({ on: true })
    await s.memory((m) => m.undo(row?.id ?? ""))
    const [item] = await s.items(s.bo.id)
    expect(item).toMatchObject({ text: "Launch note", channel: null })
    expect(await s.reads(s.bo.id)).toEqual(["Launch note"])
  })

  test("Undo of a note that the user deleted brings it back to its channel while the channel is there", async () => {
    const s = await setup()
    await s.note(s.bo.id, "Launch note", s.launch.id)
    const [item] = await s.items(s.bo.id)
    await s.memory((m) => m.remove(item?.id ?? ""))
    const [deleted] = await s.history(s.bo.id)
    await s.memory((m) => m.undo(deleted?.id ?? ""))
    expect((await s.items(s.bo.id))[0]?.channel?.id).toBe(s.launch.id)
  })

  test("a proposal for the channel stays; Save makes a general item of it", async () => {
    const s = await setup()
    await s.memory((m) => m.setMode(s.bo.id, "ask"))
    await s.note(s.bo.id, "Launch idea", s.launch.id)
    await s.run(Channels.use((c) => c.remove(s.launch.id)))
    const [proposal] = await s.memory((m) => m.proposals(s.bo.id))
    expect(proposal).toMatchObject({ text: "Launch idea", channel: { name: null } })
    await s.memory((m) => m.accept(proposal?.id ?? ""))
    expect((await s.items(s.bo.id)).map((i) => [i.text, i.channel])).toEqual([
      ["Launch idea", null],
    ])
  })

  test("the delete of an agent removes its notes and its history with it", async () => {
    const s = await setup()
    await s.note(s.cy.id, "Cy launch note", s.launch.id)
    await s.run(Agents.use((a) => a.archive(s.cy.id)))
    await s.run(Agents.use((a) => a.remove(s.cy.id)))
    const left = await s.run(
      Database.use((db) =>
        Effect.sync(() => db.all("SELECT id FROM memory WHERE channel_id = ?", s.launch.id)),
      ),
    )
    expect(left).toEqual([])
  })
})
