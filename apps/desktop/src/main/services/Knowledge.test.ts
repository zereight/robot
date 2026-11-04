import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { ChatMessage, MessagePart } from "@robot/shared"
import { KNOWLEDGE_CHARS_MAX, KNOWLEDGE_LINES_MAX } from "@robot/shared"
import { Effect } from "effect"
import { tempDir } from "../test-temp.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Knowledge } from "./Knowledge.ts"
import { Notifier } from "./Notifier.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import { allowLocalHost, testRuntime } from "./testing.ts"

const KEY = "sk-know-test-0123456789abcdef"

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

interface Seen {
  system: string
  tools: string[]
  last: string
}
const seen: Seen[] = []

const callOf = (index: number, name: string, args: unknown) => ({
  index,
  id: `call_${index + 1}`,
  function: { name, arguments: JSON.stringify(args) },
})

/**
 * A model that calls the tools named in the last user text: "CALL name {json}" for one call and
 * "CALLS name [{json}, ...]" for several in one reply. It then repeats the last result.
 */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      tools?: { function: { name: string } }[]
      messages: { role: string; content: string | null }[]
    }
    const last = body.messages.at(-1)
    seen.push({
      system: String(body.messages[0]?.content ?? ""),
      tools: (body.tools ?? []).map((t) => t.function.name),
      last: String(last?.content ?? ""),
    })
    if (last?.role === "tool")
      return sse([
        { choices: [{ delta: { content: `Result: ${last.content}` } }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        "[DONE]",
      ])
    const text = String(last?.content ?? "")
    const one = /CALL (\w+) (\{.*\})/s.exec(text)
    const many = /CALLS (\w+) (\[.*\])/s.exec(text)
    const mixed = /TOOLS (\[.*\])/s.exec(text)
    const calls = mixed
      ? (JSON.parse(mixed[1] as string) as { name: string; args: unknown }[]).map((c, i) =>
          callOf(i, c.name, c.args),
        )
      : many
        ? (JSON.parse(many[2] as string) as unknown[]).map((a, i) =>
            callOf(i, many[1] as string, a),
          )
        : one
          ? [callOf(0, one[1] as string, JSON.parse(one[2] as string))]
          : []
    if (calls.length > 0 && body.tools?.some((t) => t.function.name === calls[0]?.function.name))
      return sse([{ choices: [{ delta: { tool_calls: calls } }] }, "[DONE]"])
    return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])
  },
})
afterAll(() => server.stop())

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

type Level = "ask_all" | "ask_risky" | "full"

const setup = async (permission: Level = "ask_risky") => {
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
  const make = (name: string) =>
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
  const agent = await make("Ada")
  await run(Agents.use((a) => a.update(agent.id, { permission })))
  mkdirSync(agent.workspace, { recursive: true })
  // The test pages are on this computer: a fetch of a local host needs its rule (spec 007).
  await allowLocalHost(t.runtime, agent.id)
  const folder = join(agent.workspace, "Knowledge")
  const k = <A, E>(f: (service: Context) => Effect.Effect<A, E>) => run(Knowledge.use(f))
  type Context = Parameters<Parameters<typeof Knowledge.use>[0]>[0]
  const save = (
    title: string,
    body = "Body.",
    summary = "",
    file: string | null = null,
    id = agent.id,
  ) => k((x) => x.save(id, { file, title, summary, body }))
  const list = (query?: string) => k((x) => x.list(agent.id, query))
  const changes = () => k((x) => x.changes(agent.id))
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const history = () => run(Chat.use((c) => c.history(agent.id)))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await history()).messages.filter((m) => m.author === "agent").at(-1)
  const toolParts = async () =>
    ((await reply())?.parts ?? []).filter(
      (p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool",
    )
  const finished = () =>
    until(async () => !!(await reply()) && (await reply())?.status !== "streaming")
  const turn = async (text: string) => {
    const before = (await history()).messages.filter((m) => m.author === "agent").length
    await send(text)
    await until(async () => {
      const agents = (await history()).messages.filter((m) => m.author === "agent")
      return agents.length > before && agents.at(-1)?.status !== "streaming"
    })
  }
  const respond = (answer: string, callId = "call_1") =>
    run(Tools.use((x) => x.respond(agent.id, callId, answer)))
  const waitingCard = async () => {
    await until(async () => (await toolParts()).some((p) => p.state === "waiting"))
    return (await toolParts()).find((p) => p.state === "waiting")?.ask
  }
  const db = () => run(Database.use((d) => Effect.succeed(d)))
  return {
    t,
    run,
    agent,
    account,
    local,
    make,
    folder,
    k,
    save,
    list,
    changes,
    send,
    history,
    reply,
    toolParts,
    finished,
    turn,
    respond,
    waitingCard,
    db,
  }
}

const changeIdOf = (part: MessagePart | undefined) =>
  part?.kind === "tool" && part.knowledge?.kind === "write" ? part.knowledge.changeId : ""

const call = (name: string, args: object) => `CALL ${name} ${JSON.stringify(args)}`

describe("articles as files", () => {
  test("the folder is made at the first saved article; the file holds a header and the body", async () => {
    const s = await setup()
    expect(existsSync(s.folder)).toBe(false)
    expect((await s.list()).canOpenFolder).toBe(false)
    const article = await s.save("Vite config", "Uses [[Deploy]].", "How the build is set up.")
    expect(existsSync(s.folder)).toBe(true)
    expect(article).toMatchObject({ title: "Vite config", editor: "user", file: "Vite config.md" })
    expect(article.links).toEqual([{ title: "Deploy", file: null }])
    const text = readFileSync(join(s.folder, "Vite config.md"), "utf8")
    expect(text).toContain("title: Vite config")
    expect(text).toContain("summary: How the build is set up.")
    expect(text).toContain("Uses [[Deploy]].")
    // A link to an article that exists points at its file.
    await s.save("Deploy", "Steps.")
    expect((await s.k((x) => x.get(s.agent.id, "Vite config.md"))).links).toEqual([
      { title: "Deploy", file: "Deploy.md" },
    ])
  })

  test("Open folder stays off until the first article is saved, also when a source made the folder", async () => {
    const s = await setup()
    expect((await s.list()).canOpenFolder).toBe(false)
    expect(await s.k((x) => x.folder(s.agent.id))).toMatchObject({ exists: false, saved: false })
    // A source makes the folder, but no article is saved yet.
    await s.k((x) => x.addSource(s.agent.id, { name: "a.txt", data: "data" }))
    expect(existsSync(s.folder)).toBe(true)
    expect((await s.list()).canOpenFolder).toBe(false)
    expect(await s.k((x) => x.folder(s.agent.id))).toMatchObject({ exists: true, saved: false })
    await s.save("Alpha")
    expect((await s.list()).canOpenFolder).toBe(true)
    expect(await s.k((x) => x.folder(s.agent.id))).toMatchObject({ exists: true, saved: true })
    // The folder was opened once for an article: deleting every article does not shut it again.
    await s.k((x) => x.remove(s.agent.id, "Alpha.md"))
    expect((await s.list()).total).toBe(0)
    expect((await s.list()).canOpenFolder).toBe(true)
  })

  test("title 1 to 80, summary up to 160, body up to 20,000, unique ignoring case", async () => {
    const s = await setup()
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e as { code?: string }).code ?? (e as Error).message,
      )
    expect(await code(s.save(""))).toBe("knowledge_title_invalid")
    expect(await code(s.save("t".repeat(81)))).toBe("knowledge_title_invalid")
    expect(await code(s.save("t".repeat(80)))).toBe("ok")
    expect(await code(s.save("a", "b", "s".repeat(161)))).toBe("knowledge_summary_long")
    expect(await code(s.save("a", "b".repeat(20_001)))).toBe("knowledge_body_long")
    expect(await code(s.save("a", "b".repeat(20_000), "s".repeat(160)))).toBe("ok")
    expect(await code(s.save("A", "again"))).toBe("knowledge_title_taken")
    // Saving the article again under its own title is an edit, not a clash.
    expect(await code(s.save("a", "new", "", "a.md"))).toBe("ok")
    expect(readFileSync(join(s.folder, "a.md"), "utf8")).toContain("new")
  })

  test("an agent cannot add the 501st article; the user cannot either", async () => {
    const s = await setup()
    mkdirSync(s.folder, { recursive: true })
    for (let i = 0; i < 500; i++) writeFileSync(join(s.folder, `n${i}.md`), `Note ${i}\n`)
    const view = await s.list()
    expect(view.total).toBe(500)
    expect(view.limit).toBe(500)
    await expect(s.save("One more")).rejects.toMatchObject({ code: "knowledge_full" })
    // An article that exists can still be edited.
    await s.save("n1", "edited", "", "n1.md")
    await s.turn(call("write_article", { title: "Another", body: "x" }))
    const part = (await s.toolParts())[0]
    expect(part?.state).toBe("failed")
    expect(part?.knowledge).toEqual({ kind: "failed", title: "Another", code: "knowledge_full" })
    expect(part?.output).toContain("500 articles")
  })

  test("search finds words in title, summary and text", async () => {
    const s = await setup()
    await s.save("Alpha", "The red fox.", "animals")
    await s.save("Beta", "Water.", "liquids")
    expect((await s.list("fox")).articles.map((a) => a.title)).toEqual(["Alpha"])
    expect((await s.list("LIQUIDS")).articles.map((a) => a.title)).toEqual(["Beta"])
    expect((await s.list("red water")).articles).toHaveLength(0)
    expect((await s.list("")).articles.map((a) => a.title)).toEqual(["Alpha", "Beta"])
    expect((await s.list("fox")).total).toBe(2)
  })
})

describe("keys and tokens", () => {
  test("a text that equals a stored key or looks like a token is refused; no file holds it", async () => {
    const s = await setup()
    const refused = async (title: string, body: string, summary = "") =>
      s.save(title, body, summary).then(
        () => "saved",
        (e: { code: string }) => e.code,
      )
    expect(await refused("Key", KEY)).toBe("knowledge_secret")
    expect(await refused("Key", `The key is ${KEY}, keep it.`)).toBe("knowledge_secret")
    expect(await refused("Key", "ok", KEY)).toBe("knowledge_secret")
    expect(await refused(KEY, "ok")).toBe("knowledge_secret")
    expect(await refused("Token", "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 for it.")).toBe(
      "knowledge_secret",
    )
    expect(await refused("Plain", "Nothing secret here.")).toBe("saved")
    const files = existsSync(s.folder) ? readdirSync(s.folder) : []
    expect(files).toEqual(["Plain.md"])
  })

  test("the agent gets a plain error in the card, and the turn goes on", async () => {
    const s = await setup()
    await s.turn(call("write_article", { title: "Key", body: `The key is ${KEY}` }))
    const part = (await s.toolParts())[0]
    expect(part).toMatchObject({
      name: "write_article",
      state: "failed",
      knowledge: { kind: "failed", title: "Key", code: "knowledge_secret" },
    })
    expect(existsSync(s.folder)).toBe(false)
    const row = await s.reply()
    expect(row?.status).toBe("done")
    expect(part?.output).not.toContain(KEY)
  })

  test("an agent file source that holds a stored key or a token is refused; no source is saved", async () => {
    const s = await setup()
    const dir = join(s.agent.workspace, "attachments")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "leak.txt"), `Config\nkey=${KEY}\n`)
    writeFileSync(join(dir, "token.txt"), "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here.")
    // Not a text file: the key is found in the bytes.
    writeFileSync(
      join(dir, "data.bin"),
      Buffer.concat([Buffer.from([0, 1, 255, 254]), Buffer.from(KEY)]),
    )
    writeFileSync(join(dir, "plain.txt"), "Nothing secret here.")
    for (const name of ["leak.txt", "token.txt", "data.bin"]) {
      await s.turn(call("add_source", { path: `attachments/${name}` }))
      const part = (await s.toolParts())[0]
      expect(part).toMatchObject({
        name: "add_source",
        state: "failed",
        knowledge: { kind: "failed", title: `attachments/${name}`, code: "knowledge_secret" },
      })
      expect(part?.output).not.toContain(KEY)
      // The turn went on, and nothing was kept: not the source, not even the folder.
      expect((await s.reply())?.status).toBe("done")
      expect(existsSync(s.folder)).toBe(false)
    }
    await s.turn(call("add_source", { path: "attachments/plain.txt" }))
    expect((await s.toolParts())[0]?.knowledge).toEqual({ kind: "source", name: "plain.txt" })
    expect(readdirSync(join(s.folder, "sources"))).toEqual(["plain.txt"])
  })

  test("a refused source does not ask about the first save in a chosen workspace", async () => {
    const s = await setup()
    const chosen = tempDir("robot-chosen-")
    ;(await s.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", chosen, s.agent.id)
    mkdirSync(join(chosen, "attachments"), { recursive: true })
    writeFileSync(join(chosen, "attachments", "leak.txt"), `key=${KEY}`)
    // The turn ends without a question: the card would wait for an answer.
    await s.turn(call("add_source", { path: "attachments/leak.txt" }))
    expect((await s.toolParts())[0]).toMatchObject({
      state: "failed",
      knowledge: { kind: "failed", code: "knowledge_secret" },
    })
    expect(existsSync(join(chosen, "Knowledge"))).toBe(false)
  })

  test("an agent web page source that holds a stored key is refused; no source is saved", async () => {
    const s = await setup()
    const page = Bun.serve({
      port: 0,
      fetch: (req) =>
        new Response(
          new URL(req.url).pathname === "/leak"
            ? `<html><body><p>Settings page. Token: ${KEY}</p></body></html>`
            : "<html><body><p>Public page.</p></body></html>",
          { headers: { "content-type": "text/html" } },
        ),
    })
    try {
      await s.turn(call("add_source", { url: `http://127.0.0.1:${page.port}/leak` }))
      const part = (await s.toolParts())[0]
      expect(part).toMatchObject({
        state: "failed",
        knowledge: { kind: "failed", code: "knowledge_secret" },
      })
      expect(existsSync(s.folder)).toBe(false)
      await s.turn(call("add_source", { url: `http://127.0.0.1:${page.port}/public` }))
      expect((await s.toolParts())[0]?.knowledge).toMatchObject({ kind: "source" })
      expect(readdirSync(join(s.folder, "sources"))).toHaveLength(1)
    } finally {
      page.stop(true)
    }
  })

  test("the service refuses a source with a key too; a file put there by hand is not checked", async () => {
    const s = await setup()
    await expect(
      s.k((x) => x.addSource(s.agent.id, { name: "a.txt", data: `x ${KEY} y` })),
    ).rejects.toMatchObject({ code: "knowledge_secret" })
    await expect(
      s.k((x) => x.checkSource(new TextEncoder().encode(`Bearer abcdefghijklmnopqrstuvwxyz`))),
    ).rejects.toMatchObject({ code: "knowledge_secret" })
    expect(existsSync(s.folder)).toBe(false)
    mkdirSync(join(s.folder, "sources"), { recursive: true })
    writeFileSync(join(s.folder, "sources", "by-hand.txt"), `Kept by hand: ${KEY}`)
    expect((await s.list()).sources.map((x) => x.name)).toEqual(["by-hand.txt"])
    // The file is not touched.
    expect(readFileSync(join(s.folder, "sources", "by-hand.txt"), "utf8")).toContain(KEY)
  })
})

describe("changes and undo", () => {
  test("a change keeps the earlier text, who made it and when; the last 50 stay", async () => {
    const s = await setup()
    const before = Date.now()
    await s.save("Note", "one")
    await s.save("Note", "two", "", "Note.md")
    const [edit, add] = await s.changes()
    expect(add).toMatchObject({ kind: "add", title: "Note", actor: "user", before: null })
    expect(edit).toMatchObject({ kind: "edit", title: "Note", actor: "user" })
    expect(edit?.before).toContain("one")
    expect(edit?.at).toBeGreaterThanOrEqual(before)
    for (let i = 0; i < 60; i++) await s.save(`Extra ${i}`)
    const all = await s.changes()
    expect(all).toHaveLength(50)
    expect(all[0]?.title).toBe("Extra 59")
  })

  test("undo puts an edit back, removes an added article, and brings a deleted one back", async () => {
    const s = await setup()
    await s.save("Note", "one")
    await s.save("Note", "two", "", "Note.md")
    const [edit] = await s.changes()
    await s.k((x) => x.undo(s.agent.id, edit?.id ?? ""))
    expect(readFileSync(join(s.folder, "Note.md"), "utf8")).toContain("one")
    expect((await s.changes()).find((c) => c.id === edit?.id)?.undone).toBe(true)
    await expect(s.k((x) => x.undo(s.agent.id, edit?.id ?? ""))).rejects.toMatchObject({
      code: "knowledge_undone",
    })

    // Delete, then undo: the article returns with its earlier text.
    await s.k((x) => x.remove(s.agent.id, "Note.md"))
    expect(existsSync(join(s.folder, "Note.md"))).toBe(false)
    expect((await s.list()).total).toBe(0)
    const [deleted] = await s.changes()
    expect(deleted?.kind).toBe("delete")
    await s.k((x) => x.undo(s.agent.id, deleted?.id ?? ""))
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Note"])
    expect(readFileSync(join(s.folder, "Note.md"), "utf8")).toContain("one")

    // An added article goes again.
    await s.save("Fresh")
    const [added] = await s.changes()
    await s.k((x) => x.undo(s.agent.id, added?.id ?? ""))
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Note"])
  })

  test("an undo is a new change by the user, so it can be undone again", async () => {
    const s = await setup()
    await s.turn(call("write_article", { title: "Alpha", summary: "s", body: "agent text" }))
    const file = join(s.folder, "Alpha.md")
    await s.turn(call("delete_article", { title: "Alpha" }))
    expect(existsSync(file)).toBe(false)
    const [deleted] = await s.changes()
    // Undo the delete: the article returns, and the undo is a change of the user.
    await s.k((x) => x.undo(s.agent.id, deleted?.id ?? ""))
    expect(readFileSync(file, "utf8")).toContain("agent text")
    const [undo] = await s.changes()
    expect(undo).toMatchObject({ kind: "add", title: "Alpha", actor: "user", undone: false })
    expect(undo?.id).not.toBe(deleted?.id)
    expect((await s.list()).articles[0]?.editor).toBe("user")
    // Undo the undo: it is deleted again, by the user.
    await s.k((x) => x.undo(s.agent.id, undo?.id ?? ""))
    expect(existsSync(file)).toBe(false)
    const [again] = await s.changes()
    expect(again).toMatchObject({ kind: "delete", title: "Alpha", actor: "user", undone: false })
    // And again: the article is back with its text.
    await s.k((x) => x.undo(s.agent.id, again?.id ?? ""))
    expect(readFileSync(file, "utf8")).toContain("agent text")
    expect((await s.changes()).length).toBe(5)
  })

  test("an undo of an edit is an edit by the user; it can be undone, and it protects the article", async () => {
    const s = await setup()
    await s.turn(call("write_article", { title: "Alpha", summary: "s", body: "one" }))
    await s.turn(call("write_article", { title: "Alpha", body: "two" }))
    const [edit] = await s.changes()
    await s.k((x) => x.undo(s.agent.id, edit?.id ?? ""))
    const file = join(s.folder, "Alpha.md")
    expect(readFileSync(file, "utf8")).toContain("one")
    const [undo] = await s.changes()
    expect(undo).toMatchObject({ kind: "edit", actor: "user" })
    expect(undo?.before).toContain("two")
    // The undo counts as an edit by the user: the agent must ask before it changes the article.
    await s.send(call("write_article", { title: "Alpha", body: "three" }))
    expect((await s.waitingCard())?.kind).toBe("article")
    await s.respond("deny")
    await s.finished()
    expect(readFileSync(file, "utf8")).toContain("one")
    // Undo the undo: "two" comes back.
    await s.k((x) => x.undo(s.agent.id, undo?.id ?? ""))
    expect(readFileSync(file, "utf8")).toContain("two")
  })

  test("undo does not look at later changes: it puts the earlier text back", async () => {
    const s = await setup()
    await s.save("Alpha", "one", "s")
    await s.save("Alpha", "two", "s", "Alpha.md")
    const [second] = await s.changes()
    await s.save("Alpha", "three", "s", "Alpha.md")
    await s.save("Alpha", "four", "s", "Alpha.md")
    // The edit to "two" is undone, though two edits came after it: the text before it is back.
    await s.k((x) => x.undo(s.agent.id, second?.id ?? ""))
    const text = readFileSync(join(s.folder, "Alpha.md"), "utf8")
    expect(text).toContain("one")
    expect(text).not.toContain("four")
    // The undo of a rename puts the old title back: the article is found by its file.
    await s.save("Alpha beta", "five", "s", "Alpha.md")
    const [renamed] = await s.changes()
    await s.k((x) => x.undo(s.agent.id, renamed?.id ?? ""))
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Alpha"])
  })

  test("an older change of an article that was renamed since: its earlier text comes back", async () => {
    const s = await setup()
    await s.save("Alpha", "one", "s")
    await s.save("Alpha", "two", "s", "Alpha.md")
    const [edit] = await s.changes()
    await s.save("Beta", "two", "s", "Alpha.md")
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Beta"])
    // The article of the change is not there under its old title or file any more. The earlier
    // text is put back; the renamed article stays.
    await s.k((x) => x.undo(s.agent.id, edit?.id ?? ""))
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Alpha", "Beta"])
    expect(readFileSync(join(s.folder, "Alpha.md"), "utf8")).toContain("one")
    // An article that kept its title but moved to another file is found by its title.
    await s.save("Gamma", "g1", "s")
    await s.save("Gamma", "g2", "s", "Gamma.md")
    const [gammaEdit] = await s.changes()
    renameSync(join(s.folder, "Gamma.md"), join(s.folder, "Moved.md"))
    await s.k((x) => x.undo(s.agent.id, gammaEdit?.id ?? ""))
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Alpha", "Beta", "Gamma"])
    expect(existsSync(join(s.folder, "Gamma.md"))).toBe(true)
    expect(readFileSync(join(s.folder, "Gamma.md"), "utf8")).toContain("g1")
  })

  test("an added article that is gone already cannot be undone; the error is plain", async () => {
    const s = await setup()
    await s.save("Alpha")
    const [added] = await s.changes()
    await s.k((x) => x.remove(s.agent.id, "Alpha.md"))
    await expect(s.k((x) => x.undo(s.agent.id, added?.id ?? ""))).rejects.toMatchObject({
      code: "knowledge_not_found",
    })
  })

  test("undo of a delete fails when another article took the title", async () => {
    const s = await setup()
    await s.save("Note", "one")
    await s.k((x) => x.remove(s.agent.id, "Note.md"))
    const [deleted] = await s.changes()
    await s.save("note", "other")
    await expect(s.k((x) => x.undo(s.agent.id, deleted?.id ?? ""))).rejects.toMatchObject({
      code: "knowledge_title_taken",
    })
  })
})

describe("files are the truth", () => {
  test("an edit, a new file and a deleted file outside the app are read again as the user's", async () => {
    const s = await setup()
    await s.turn(call("write_article", { title: "Alpha", summary: "a", body: "agent text" }))
    expect((await s.list()).articles[0]?.editor).toBe("agent")
    const file = join(s.folder, "Alpha.md")
    // Another app edits the file. The size changes, so the app sees it.
    writeFileSync(file, `${readFileSync(file, "utf8")}\nAdded outside.`)
    writeFileSync(join(s.folder, "Outside.md"), "# Outside\n\nA file from another app.\n")
    const view = await s.list()
    expect(view.articles.map((a) => [a.title, a.editor])).toEqual([
      ["Alpha", "user"],
      ["Outside", "user"],
    ])
    expect((await s.k((x) => x.get(s.agent.id, "Alpha.md"))).body).toContain("Added outside.")
    const kinds = (await s.changes()).slice(0, 2).map((c) => [c.kind, c.title, c.actor])
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["edit", "Alpha", "user"],
        ["add", "Outside", "user"],
      ]),
    )
    // The earlier text is kept, so the outside edit can be undone.
    const edit = (await s.changes()).find((c) => c.kind === "edit")
    expect(edit?.before).toContain("agent text")
    expect(edit?.before).not.toContain("Added outside.")
    await s.k((x) => x.undo(s.agent.id, edit?.id ?? ""))
    expect(readFileSync(file, "utf8")).not.toContain("Added outside.")

    rmSync(join(s.folder, "Outside.md"))
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Alpha"])
    expect((await s.changes())[0]).toMatchObject({
      kind: "delete",
      title: "Outside",
      actor: "user",
    })
  })

  test("the folder is watched: a change from outside is announced", async () => {
    const s = await setup()
    await s.save("Alpha")
    const events = s.t.events
    const before = events.filter((e) => e.event === "knowledge.changed").length
    // The system starts a watcher a moment after `watch` returns. A file that is written in that
    // moment is not announced (seen on macOS), so the test lets the watcher start first.
    await Bun.sleep(100)
    writeFileSync(join(s.folder, "Beta.md"), "# Beta\n\nNew.\n")
    await until(() => events.filter((e) => e.event === "knowledge.changed").length > before, 3000)
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Alpha", "Beta"])
  })

  test("a second file with a taken title is not shown, and is counted", async () => {
    const s = await setup()
    await s.save("Alpha")
    writeFileSync(join(s.folder, "alpha copy.md"), "---\ntitle: ALPHA\n---\n\nOther.\n")
    const view = await s.list()
    expect(view.articles).toHaveLength(1)
    expect(view.skipped).toBe(1)
  })

  test("a file that another app wrote has no limits: a long title, summary and body are shown", async () => {
    const s = await setup()
    await s.save("Alpha")
    const title = "T".repeat(300)
    writeFileSync(
      join(s.folder, "Long.md"),
      `---\ntitle: ${title}\nsummary: ${"s".repeat(400)}\n---\n\n${"b".repeat(30_000)}\n`,
    )
    const view = await s.list()
    expect(view.articles.map((a) => a.title)).toEqual(["Alpha", title])
    expect(view.skipped).toBe(0)
    const article = await s.k((x) => x.get(s.agent.id, "Long.md"))
    expect(article.summary).toHaveLength(400)
    expect(article.body).toHaveLength(30_000)
    // The agent can open it by its title.
    await s.turn(call("read_article", { title }))
    expect((await s.toolParts())[0]?.knowledge).toEqual({ kind: "read", title })
    // The limits hold when the agent or the user saves: a summary of 400 characters is too long.
    await s.turn(call("write_article", { title, body: "new body" }))
    expect((await s.toolParts())[0]?.knowledge).toMatchObject({
      kind: "failed",
      code: "knowledge_title_invalid",
    })
    await expect(s.save(title, "new")).rejects.toMatchObject({ code: "knowledge_title_invalid" })
  })

  test("the first file of a title stays; the file that came second is hidden, not deleted", async () => {
    const s = await setup()
    await s.save("Zed", "app text")
    // "Aaa.md" sorts before "Zed.md", but the app knew Zed first.
    writeFileSync(join(s.folder, "Aaa.md"), "---\ntitle: zed\n---\n\nOther app.\n")
    const view = await s.list()
    expect(view.articles.map((a) => [a.title, a.file])).toEqual([["Zed", "Zed.md"]])
    expect(view.skipped).toBe(1)
    // The hidden file is not a change, and the article is not recorded as deleted.
    expect((await s.changes()).map((c) => c.kind)).toEqual(["add"])
    // When the second file goes, nothing is lost.
    rmSync(join(s.folder, "Aaa.md"))
    expect((await s.list()).skipped).toBe(0)
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Zed"])
    expect((await s.changes()).map((c) => c.kind)).toEqual(["add"])
  })

  test("hidden files, other folders and other kinds of file are ignored", async () => {
    const s = await setup()
    await s.save("Alpha")
    mkdirSync(join(s.folder, "notes"), { recursive: true })
    mkdirSync(join(s.folder, ".git"), { recursive: true })
    writeFileSync(join(s.folder, ".hidden.md"), "# Hidden\n")
    writeFileSync(join(s.folder, "notes", "Inner.md"), "# Inner\n")
    writeFileSync(join(s.folder, ".git", "Config.md"), "# Config\n")
    writeFileSync(join(s.folder, "readme.txt"), "not an article")
    // The sources folder holds sources: a Markdown file there is not an article.
    mkdirSync(join(s.folder, "sources"), { recursive: true })
    writeFileSync(join(s.folder, "sources", "Source.md"), "# A source\n")
    const view = await s.list()
    expect(view.articles.map((a) => a.title)).toEqual(["Alpha"])
    expect(view.skipped).toBe(0)
    expect(view.total).toBe(1)
  })

  test("the last change time is the time of the file", async () => {
    const s = await setup()
    await s.save("Alpha")
    const when = new Date("2026-01-02T03:04:05Z")
    utimesSync(join(s.folder, "Alpha.md"), when, when)
    expect((await s.list()).articles[0]?.updatedAt).toBe(when.getTime())
  })
})

describe("the contents list", () => {
  test("a small list is given whole, in a turn", async () => {
    const s = await setup()
    await s.save("Beta", "b", "second")
    await s.save("Alpha", "a", "first")
    await s.turn("hello")
    const system = seen.at(-1)?.system ?? ""
    expect(system).toContain("- Alpha: first\n- Beta: second")
  })

  test("a long list has at most 100 lines and 6,000 characters; related lines come first", async () => {
    const s = await setup()
    mkdirSync(s.folder, { recursive: true })
    for (let i = 0; i < 150; i++)
      writeFileSync(
        join(s.folder, `n${i}.md`),
        `---\ntitle: Note ${String(i).padStart(3, "0")}\nsummary: filler text\n---\n\nx\n`,
      )
    writeFileSync(
      join(s.folder, "deploy.md"),
      "---\ntitle: Deploy pipeline\nsummary: release steps\n---\n\nx\n",
    )
    const old = new Date("2020-01-01")
    utimesSync(join(s.folder, "deploy.md"), old, old)
    const prompt = s.run(
      Knowledge.use((x) =>
        Effect.succeed(x.prompt(s.agent.id, "how does the deploy pipeline go", "tools")),
      ),
    )
    const text = (await prompt) ?? ""
    const list = (text.split("Contents (title: summary):\n")[1] ?? "").split("\n")
    const lines = list.filter((l) => l.startsWith("- "))
    // The line with the count is the last line of the list, and it is inside the limits.
    expect(list.at(-1)).toBe("(52 more articles are not in this list. Read one by its title.)")
    expect(list.length).toBeLessThanOrEqual(KNOWLEDGE_LINES_MAX)
    expect(list.join("\n").length).toBeLessThanOrEqual(KNOWLEDGE_CHARS_MAX)
    expect(lines.length).toBe(99)
    expect(lines[0]).toBe("- Deploy pipeline: release steps")
    // A vendor program reads the files itself, so it gets no hint to read by title.
    const files = await s.run(
      Knowledge.use((x) =>
        Effect.succeed(x.prompt(s.agent.id, "how does the deploy pipeline go", "files")),
      ),
    )
    expect(files).toContain("(52 more articles are not in this list.)")
  })

  test("a list that fits is given whole, with no line about missing articles", async () => {
    const s = await setup()
    mkdirSync(s.folder, { recursive: true })
    for (let i = 0; i < 100; i++)
      writeFileSync(
        join(s.folder, `n${i}.md`),
        `---\ntitle: Note ${String(i).padStart(3, "0")}\nsummary: filler\n---\n\nx\n`,
      )
    const text =
      (await s.run(
        Knowledge.use((x) => Effect.succeed(x.prompt(s.agent.id, "anything", "tools"))),
      )) ?? ""
    expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(100)
    expect(text).not.toContain("are not in this list")
    // One more article, and the list is cut.
    writeFileSync(join(s.folder, "last.md"), "---\ntitle: Last\nsummary: one more\n---\n\nx\n")
    const cut =
      (await s.run(
        Knowledge.use((x) => Effect.succeed(x.prompt(s.agent.id, "anything", "tools"))),
      )) ?? ""
    expect(cut).toContain("are not in this list")
  })

  test("agents do not read each other's knowledge", async () => {
    const s = await setup()
    const bo = await s.make("Bo")
    await s.save("Ada only", "x", "mine")
    await s.save("Bo only", "x", "his", null, bo.id)
    const prompt = (id: string) =>
      s.run(Knowledge.use((x) => Effect.succeed(x.prompt(id, "", "tools")))) as Promise<string>
    expect(await prompt(s.agent.id)).toContain("Ada only")
    expect(await prompt(s.agent.id)).not.toContain("Bo only")
    expect(await prompt(bo.id)).toContain("Bo only")
    expect(await prompt(bo.id)).not.toContain("Ada only")
  })

  test("a vendor program gets the folder and the file format in its instructions", async () => {
    const s = await setup()
    await s.save("Alpha", "x", "first")
    const text = await s.run(
      Knowledge.use((x) => Effect.succeed(x.prompt(s.agent.id, "", "files"))),
    )
    expect(text).toContain(s.folder)
    expect(text).toContain("title:")
    expect(text).toContain("- Alpha: first")
    expect(text).not.toContain("write_article")
  })
})

describe("knowledge off", () => {
  test("the agent reads no article and has no knowledge tool; the articles stay", async () => {
    const s = await setup()
    await s.save("Alpha", "x", "first")
    await s.run(Agents.use((a) => a.update(s.agent.id, { knowledgeEnabled: false })))
    await s.turn("hello")
    const last = seen.at(-1)
    expect(last?.system).not.toContain("Alpha")
    expect(last?.tools).not.toContain("read_article")
    expect(last?.tools).not.toContain("write_article")
    expect((await s.list()).enabled).toBe(false)
    expect((await s.list()).articles).toHaveLength(1)
    await s.run(Agents.use((a) => a.update(s.agent.id, { knowledgeEnabled: true })))
    await s.turn("hello again")
    expect(seen.at(-1)?.system).toContain("Alpha")
    expect(seen.at(-1)?.tools).toContain("read_article")
  })
})

describe("knowledge tools in a turn", () => {
  test("write, read and delete: cards, notes, files, and undo from the card's change", async () => {
    const s = await setup()
    await s.turn(
      call("write_article", {
        title: "Vite config",
        summary: "Build setup",
        body: "Uses vite.",
        links: ["Deploy"],
      }),
    )
    let part = (await s.toolParts())[0]
    expect(part?.state).toBe("done")
    expect(part?.knowledge).toMatchObject({ kind: "write", title: "Vite config", change: "add" })
    const text = readFileSync(join(s.folder, "Vite config.md"), "utf8")
    expect(text).toContain("See also: [[Deploy]]")
    const changeId = changeIdOf(part)
    expect(await s.k((x) => x.change(s.agent.id, changeId))).toMatchObject({
      actor: "agent",
      undone: false,
    })

    await s.turn(call("read_article", { title: "vite CONFIG" }))
    part = (await s.toolParts())[0]
    expect(part?.knowledge).toEqual({ kind: "read", title: "Vite config" })
    expect(part?.output).toContain("Uses vite.")
    expect(part?.output).toContain("Links to articles that do not exist: Deploy")

    await s.turn(call("delete_article", { title: "Vite config" }))
    part = (await s.toolParts())[0]
    expect(part?.knowledge).toMatchObject({ kind: "write", change: "delete" })
    expect(existsSync(join(s.folder, "Vite config.md"))).toBe(false)
    // A later turn cannot use it...
    await s.turn("hello")
    expect(seen.at(-1)?.system).not.toContain("Vite config")
    // ...until the delete is undone.
    const deleteId = changeIdOf(part)
    await s.k((x) => x.undo(s.agent.id, deleteId))
    await s.turn("hello")
    expect(seen.at(-1)?.system).toContain("Vite config")
  })

  test("a turn makes at most 5 changes; the sixth fails", async () => {
    const s = await setup()
    const articles = Array.from({ length: 6 }, (_, i) => ({ title: `Note ${i}`, body: "x" }))
    await s.turn(`CALLS write_article ${JSON.stringify(articles)}`)
    const parts = await s.toolParts()
    expect(parts.map((p) => p.state)).toEqual(["done", "done", "done", "done", "done", "failed"])
    expect(parts[5]?.knowledge).toMatchObject({ kind: "failed", code: "knowledge_turn_limit" })
    expect((await s.list()).total).toBe(5)
    // The next turn starts again from zero.
    await s.turn(call("write_article", { title: "Note 6", body: "x" }))
    expect((await s.list()).total).toBe(6)
  })

  test("only a saved add, edit or delete counts for the 5 changes; a read, a source and a failed change do not", async () => {
    const s = await setup()
    mkdirSync(join(s.agent.workspace, "attachments"), { recursive: true })
    writeFileSync(join(s.agent.workspace, "attachments", "a.txt"), "source text")
    const write = (title: string, extra: object = {}) => ({
      name: "write_article",
      args: { title, body: "x", ...extra },
    })
    const calls = [
      write("A"),
      { name: "read_article", args: { title: "A" } },
      write(""), // fails: no title
      { name: "add_source", args: { path: "attachments/a.txt" } },
      write("B"),
      { name: "add_source", args: { path: "attachments/a.txt" } },
      write("C", { summary: "s".repeat(161) }), // fails: summary too long
      write("C"),
      { name: "delete_article", args: { title: "Nothing here" } }, // fails: no such article
      write("D"),
      { name: "read_article", args: { title: "B" } },
      write("A", { body: "edited" }), // an edit counts, too: this is the 5th saved change
      write("E"), // the 6th
      { name: "read_article", args: { title: "A" } }, // a read still works after the limit
    ]
    await s.turn(`TOOLS ${JSON.stringify(calls)}`)
    const parts = await s.toolParts()
    expect(parts.map((p) => p.state)).toEqual([
      "done",
      "done",
      "failed",
      "done",
      "done",
      "done",
      "failed",
      "done",
      "failed",
      "done",
      "done",
      "done",
      "failed",
      "done",
    ])
    expect(parts[12]?.knowledge).toMatchObject({ kind: "failed", code: "knowledge_turn_limit" })
    expect(parts[2]?.knowledge).toMatchObject({ code: "knowledge_title_invalid" })
    expect(parts[6]?.knowledge).toMatchObject({ code: "knowledge_summary_long" })
    expect(parts[8]?.knowledge).toMatchObject({ code: "knowledge_not_found" })
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["A", "B", "C", "D"])
    // Five changes were saved: add A, add B, add C, add D, edit A. The six did not make a file.
    expect((await s.changes()).filter((c) => c.actor === "agent")).toHaveLength(5)
    expect(existsSync(join(s.folder, "E.md"))).toBe(false)
    // A delete counts as well: five deletes are five changes, and the sixth change fails.
    await s.turn(call("write_article", { title: "E", body: "x" }))
    const deletes = ["A", "B", "C", "D", "E"].map((title) => ({
      name: "delete_article",
      args: { title },
    }))
    await s.turn(`TOOLS ${JSON.stringify([...deletes, write("F")])}`)
    const second = await s.toolParts()
    expect(second.map((p) => p.state)).toEqual(["done", "done", "done", "done", "done", "failed"])
    expect(second[5]?.knowledge).toMatchObject({ code: "knowledge_turn_limit" })
    expect((await s.list()).total).toBe(0)
  })

  test("a source is kept as it is; an article cites it; the original stays unchanged", async () => {
    const s = await setup()
    mkdirSync(join(s.agent.workspace, "attachments"), { recursive: true })
    const original = join(s.agent.workspace, "attachments", "report.txt")
    writeFileSync(original, "Revenue grew 4 percent.")
    await s.turn(call("add_source", { path: "attachments/report.txt" }))
    expect((await s.toolParts())[0]?.knowledge).toEqual({ kind: "source", name: "report.txt" })
    const kept = join(s.folder, "sources", "report.txt")
    expect(readFileSync(kept, "utf8")).toBe("Revenue grew 4 percent.")
    expect(readFileSync(original, "utf8")).toBe("Revenue grew 4 percent.")
    // The same bytes are not kept twice.
    await s.turn(call("add_source", { path: "attachments/report.txt" }))
    expect(readdirSync(join(s.folder, "sources"))).toEqual(["report.txt"])

    await s.turn(
      call("write_article", {
        title: "Revenue",
        body: "Growth was 4 percent.",
        sources: ["report.txt"],
      }),
    )
    const article = await s.k((x) => x.get(s.agent.id, "Revenue.md"))
    expect(article.sources).toEqual([{ name: "report.txt", exists: true }])
    // A source that does not exist cannot be named.
    await s.turn(call("write_article", { title: "Bad", body: "x", sources: ["nope.txt"] }))
    expect((await s.toolParts())[0]?.knowledge).toMatchObject({
      kind: "failed",
      code: "knowledge_source_missing",
    })
    expect((await s.list()).total).toBe(1)
  })

  test("a file outside the workspace cannot be a source", async () => {
    const s = await setup()
    const outside = join(tempDir("robot-out-"), "secret.txt")
    writeFileSync(outside, "x")
    await s.turn(call("add_source", { path: outside }))
    expect((await s.toolParts())[0]?.knowledge).toMatchObject({
      kind: "failed",
      code: "knowledge_source_invalid",
    })
    expect(existsSync(s.folder)).toBe(false)
  })

  test("the agent cannot change a source or write in the folder with its file tool", async () => {
    const s = await setup()
    mkdirSync(join(s.agent.workspace, "attachments"), { recursive: true })
    writeFileSync(join(s.agent.workspace, "attachments", "r.txt"), "keep")
    await s.turn(call("add_source", { path: "attachments/r.txt" }))
    const kept = join(s.folder, "sources", "r.txt")
    await s.turn(call("write_file", { path: "Knowledge/sources/r.txt", content: "changed" }))
    expect((await s.toolParts())[0]).toMatchObject({ state: "failed" })
    expect(readFileSync(kept, "utf8")).toBe("keep")
    await s.turn(call("write_file", { path: "Knowledge/Sneaky.md", content: "# Sneaky" }))
    expect((await s.toolParts())[0]).toMatchObject({ state: "failed" })
    expect(existsSync(join(s.folder, "Sneaky.md"))).toBe(false)
    // The copy is read-only for other programs too (not on Windows, which has no mode bits).
    if (process.platform !== "win32") expect(statSync(kept).mode & 0o222).toBe(0)
  })

  test("no file tool works on a source, or in the Knowledge folder while knowledge is on", async () => {
    const s = await setup()
    mkdirSync(join(s.agent.workspace, "attachments"), { recursive: true })
    writeFileSync(join(s.agent.workspace, "attachments", "r.txt"), "needle in a source")
    writeFileSync(join(s.agent.workspace, "plain.txt"), "needle in a plain file")
    await s.turn(call("add_source", { path: "attachments/r.txt" }))
    await s.turn(call("write_article", { title: "Alpha", body: "needle in an article" }))
    const refused = async (name: string, args: object) => {
      await s.turn(call(name, args))
      const part = (await s.toolParts())[0]
      expect(part).toMatchObject({ name, state: "failed" })
      return part?.output ?? ""
    }
    // A source: never, with any file tool.
    expect(await refused("read_file", { path: "Knowledge/sources/r.txt" })).toContain("source")
    expect(await refused("list_files", { path: "Knowledge/sources" })).toContain("source")
    expect(
      await refused("write_file", { path: "Knowledge/sources/r.txt", content: "x" }),
    ).toContain("source")
    // The folder: not while knowledge is on. The error names the article tools.
    expect(await refused("read_file", { path: "Knowledge/Alpha.md" })).toContain("read_article")
    expect(await refused("list_files", { path: "Knowledge" })).toContain("write_article")
    expect(await refused("write_file", { path: "Knowledge/New.md", content: "x" })).toContain(
      "delete_article",
    )
    // The same with another spelling of the path, and through a symbolic link.
    expect(await refused("read_file", { path: "./knowledge/../Knowledge/Alpha.md" })).toContain(
      "read_article",
    )
    if (process.platform !== "win32") {
      symlinkSync(join(s.folder, "Alpha.md"), join(s.agent.workspace, "shortcut.md"))
      expect(await refused("read_file", { path: "shortcut.md" })).toContain("read_article")
    }
    expect(existsSync(join(s.folder, "New.md"))).toBe(false)
    // A search finds the plain file only: not the article, not the source.
    await s.turn(call("search_files", { query: "needle" }))
    const found = (await s.toolParts())[0]?.output ?? ""
    expect(found).toContain("plain.txt")
    expect(found).not.toContain("Knowledge")
    // The listing of the workspace itself still works.
    await s.turn(call("list_files", { path: "" }))
    expect((await s.toolParts())[0]).toMatchObject({ state: "done" })

    // Knowledge off: the folder is a plain folder again. A source stays closed.
    await s.run(Agents.use((a) => a.update(s.agent.id, { knowledgeEnabled: false })))
    await s.turn(call("read_file", { path: "Knowledge/Alpha.md" }))
    expect((await s.toolParts())[0]).toMatchObject({ state: "done" })
    expect((await s.toolParts())[0]?.output).toContain("needle in an article")
    await refused("read_file", { path: "Knowledge/sources/r.txt" })
    await s.turn(call("search_files", { query: "needle" }))
    const off = (await s.toolParts())[0]?.output ?? ""
    expect(off).toContain("Alpha.md")
    expect(off).not.toContain("sources")
  })

  test("a web page is kept as text with its address", async () => {
    const s = await setup()
    const page = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<html><body><h1>Title</h1><p>Page text.</p></body></html>", {
          headers: { "content-type": "text/html" },
        }),
    })
    try {
      await s.turn(call("add_source", { url: `http://127.0.0.1:${page.port}/docs/start` }))
      const name = (await s.toolParts())[0]?.knowledge
      expect(name).toMatchObject({ kind: "source", name: "127.0.0.1-docs-start.txt" })
      const text = readFileSync(join(s.folder, "sources", "127.0.0.1-docs-start.txt"), "utf8")
      expect(text).toContain(`Fetched from http://127.0.0.1:${page.port}/docs/start`)
      expect(text).toContain("Page text.")
    } finally {
      page.stop(true)
    }
  })

  test("the user deletes a source; the article shows it as deleted", async () => {
    const s = await setup()
    await s.turn(call("write_article", { title: "Plain", body: "x" }))
    await s.k((x) => x.addSource(s.agent.id, { name: "a.txt", data: "data" }))
    await s.turn(call("write_article", { title: "Plain", body: "x", sources: ["a.txt"] }))
    await s.k((x) => x.removeSource(s.agent.id, "a.txt"))
    expect((await s.list()).sources).toEqual([])
    expect((await s.k((x) => x.get(s.agent.id, "Plain.md"))).sources).toEqual([
      { name: "a.txt", exists: false },
    ])
    await expect(s.k((x) => x.removeSource(s.agent.id, "../x"))).rejects.toMatchObject({
      code: "knowledge_source_invalid",
    })
  })
})

describe("protection", () => {
  test("an article the user edited last asks first; Deny keeps the text, Allow once changes it", async () => {
    const s = await setup()
    await s.turn(call("write_article", { title: "Alpha", summary: "s", body: "agent version" }))
    // No question for an article that the agent wrote last.
    await s.turn(call("write_article", { title: "Alpha", body: "agent second" }))
    expect((await s.toolParts())[0]?.state).toBe("done")

    await s.save("Alpha", "user version", "s", "Alpha.md")
    await s.send(call("write_article", { title: "Alpha", body: "agent third" }))
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({
      kind: "article",
      title: "Alpha",
      before: expect.stringContaining("user version"),
      after: expect.stringContaining("agent third"),
    })
    await s.respond("deny")
    await s.finished()
    expect(readFileSync(join(s.folder, "Alpha.md"), "utf8")).toContain("user version")
    expect((await s.toolParts())[0]).toMatchObject({
      state: "failed",
      knowledge: { kind: "failed", code: "knowledge_denied" },
    })

    await s.send(call("write_article", { title: "Alpha", body: "agent fourth" }))
    await s.waitingCard()
    await s.respond("allow")
    await s.finished()
    expect(readFileSync(join(s.folder, "Alpha.md"), "utf8")).toContain("agent fourth")
    expect((await s.list()).articles[0]?.editor).toBe("agent")
  })

  test("a delete of such an article asks too, and shows no new text", async () => {
    const s = await setup()
    await s.save("Alpha", "mine")
    await s.send(call("delete_article", { title: "Alpha" }))
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({ kind: "article", title: "Alpha", after: null })
    await s.respond("deny")
    await s.finished()
    expect(existsSync(join(s.folder, "Alpha.md"))).toBe(true)
  })

  test("an edit from outside the app protects the article as well", async () => {
    const s = await setup()
    await s.turn(call("write_article", { title: "Alpha", body: "agent version" }))
    const file = join(s.folder, "Alpha.md")
    writeFileSync(file, `${readFileSync(file, "utf8")}\nMy own line.`)
    await s.send(call("write_article", { title: "Alpha", body: "agent again" }))
    expect((await s.waitingCard())?.kind).toBe("article")
    await s.respond("deny")
    await s.finished()
    expect(readFileSync(file, "utf8")).toContain("My own line.")
  })

  test("at full access no card shows", async () => {
    const s = await setup("full")
    await s.save("Alpha", "mine")
    await s.turn(call("write_article", { title: "Alpha", body: "agent version" }))
    expect((await s.toolParts())[0]?.state).toBe("done")
    expect((await s.toolParts())[0]?.ask).toBeUndefined()
    expect(readFileSync(join(s.folder, "Alpha.md"), "utf8")).toContain("agent version")
  })
})

describe("the first save in a workspace that the user chose", () => {
  test("asks for approval and names the folder; the default workspace asks nothing", async () => {
    const s = await setup()
    const chosen = tempDir("robot-chosen-")
    const db = await s.db()
    db.run("UPDATE agent SET workspace = ? WHERE id = ?", chosen, s.agent.id)
    await s.send(call("write_article", { title: "Alpha", body: "x" }))
    const ask = await s.waitingCard()
    // The card names the folder and has no "Always allow".
    // The card also holds the time when the agent asked (spec 007).
    expect(ask).toEqual({
      kind: "approval",
      summary: join(chosen, "Knowledge"),
      once: true,
      askedAt: expect.any(Number),
    })
    // The island offers no "Always allow" either: the answer would deny the step.
    const island = await s.run(Notifier.use((n) => Effect.sync(() => n.island().waiting[0])))
    expect(island).toMatchObject({ kind: "approval", always: false })
    expect(existsSync(join(chosen, "Knowledge"))).toBe(false)
    await s.respond("deny")
    await s.finished()
    expect(existsSync(join(chosen, "Knowledge"))).toBe(false)

    await s.send(call("write_article", { title: "Alpha", body: "x" }))
    await s.waitingCard()
    await s.respond("allow")
    await s.finished()
    expect(existsSync(join(chosen, "Knowledge", "Alpha.md"))).toBe(true)
    // The folder exists now, so a second article asks nothing.
    await s.turn(call("write_article", { title: "Beta", body: "x" }))
    expect((await s.toolParts())[0]?.state).toBe("done")
  })

  test("a folder under a root that the user set in Settings is in the default workspace folder", async () => {
    const s = await setup()
    const root = tempDir("robot-root-")
    await s.run(SettingsStore.use((x) => x.update({ workspaceRoot: root })))
    const inside = join(root, "ada-1234")
    mkdirSync(inside, { recursive: true })
    ;(await s.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", inside, s.agent.id)
    expect((await s.k((x) => x.folder(s.agent.id))).chosen).toBe(false)
    // No question: the turn ends by itself.
    await s.turn(call("write_article", { title: "Alpha", body: "x" }))
    expect((await s.toolParts())[0]?.state).toBe("done")
    expect(existsSync(join(inside, "Knowledge", "Alpha.md"))).toBe(true)
    // A folder next to the root, or the built-in root after the user set another one, is judged
    // by the same rule.
    const outside = tempDir("robot-elsewhere-")
    ;(await s.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", outside, s.agent.id)
    expect((await s.k((x) => x.folder(s.agent.id))).chosen).toBe(true)
    const builtIn = join(s.t.dataDir, "workspaces", "old-agent")
    ;(await s.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", builtIn, s.agent.id)
    expect((await s.k((x) => x.folder(s.agent.id))).chosen).toBe(false)
    // The root itself is not "in" itself: a user who points an agent at it chose that folder.
    ;(await s.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", root, s.agent.id)
    expect((await s.k((x) => x.folder(s.agent.id))).chosen).toBe(true)
  })

  test("the first source asks too; Always allow is not offered and the folder asks again when it is missing", async () => {
    const s = await setup()
    const chosen = tempDir("robot-chosen-")
    ;(await s.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", chosen, s.agent.id)
    mkdirSync(join(chosen, "attachments"), { recursive: true })
    writeFileSync(join(chosen, "attachments", "r.txt"), "Plain source.")
    await s.send(call("add_source", { path: "attachments/r.txt" }))
    expect(await s.waitingCard()).toEqual({
      kind: "approval",
      summary: join(chosen, "Knowledge"),
      once: true,
      askedAt: expect.any(Number),
    })
    // "always" is not a choice of this card: it does not allow.
    await s.respond("always")
    await s.finished()
    expect((await s.toolParts())[0]).toMatchObject({
      state: "failed",
      knowledge: { kind: "failed", code: "knowledge_denied" },
    })
    expect(existsSync(join(chosen, "Knowledge"))).toBe(false)
    await s.send(call("add_source", { path: "attachments/r.txt" }))
    await s.waitingCard()
    await s.respond("allow")
    await s.finished()
    expect(readFileSync(join(chosen, "Knowledge", "sources", "r.txt"), "utf8")).toBe(
      "Plain source.",
    )
    // The folder goes away: the next save by the agent asks again.
    rmSync(join(chosen, "Knowledge"), { recursive: true, force: true })
    await s.send(call("write_article", { title: "Alpha", body: "x" }))
    expect((await s.waitingCard())?.kind).toBe("approval")
    await s.respond("deny")
    await s.finished()
  })

  test("a save by the user asks nothing, and at full access nothing asks", async () => {
    const s = await setup()
    const chosen = tempDir("robot-chosen-")
    ;(await s.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", chosen, s.agent.id)
    await s.save("Mine", "text")
    expect(existsSync(join(chosen, "Knowledge", "Mine.md"))).toBe(true)

    const full = await setup("full")
    const other = tempDir("robot-chosen-")
    ;(await full.db()).run("UPDATE agent SET workspace = ? WHERE id = ?", other, full.agent.id)
    await full.turn(call("write_article", { title: "Alpha", body: "x" }))
    expect((await full.toolParts())[0]).toMatchObject({ state: "done" })
    expect((await full.toolParts())[0]?.ask).toBeUndefined()
    expect(existsSync(join(other, "Knowledge", "Alpha.md"))).toBe(true)
  })
})

describe("a vendor program writes the folder itself", () => {
  test("the folder is read again after the turn, and the changes are the agent's", async () => {
    const s = await setup()
    await s.k((x) => Effect.sync(() => x.begin(s.agent.id)))
    mkdirSync(s.folder, { recursive: true })
    writeFileSync(
      join(s.folder, "Written.md"),
      "---\ntitle: Written\nsummary: By the program\n---\n\nText.\n",
    )
    await s.k((x) => Effect.sync(() => x.end(s.agent.id, "agent")))
    const view = await s.list()
    expect(view.articles.map((a) => [a.title, a.editor])).toEqual([["Written", "agent"]])
    expect((await s.changes())[0]).toMatchObject({ kind: "add", title: "Written", actor: "agent" })
  })

  test("a file that holds a stored key is put back", async () => {
    const s = await setup()
    await s.save("Alpha", "clean text")
    await s.k((x) => Effect.sync(() => x.begin(s.agent.id)))
    writeFileSync(join(s.folder, "Alpha.md"), `---\ntitle: Alpha\n---\n\nThe key ${KEY}\n`)
    writeFileSync(join(s.folder, "Leak.md"), `# Leak\n\n${KEY}\n`)
    await s.k((x) => Effect.sync(() => x.end(s.agent.id, "agent")))
    expect(readFileSync(join(s.folder, "Alpha.md"), "utf8")).toContain("clean text")
    expect(existsSync(join(s.folder, "Leak.md"))).toBe(false)
    for (const name of readdirSync(s.folder))
      expect(readFileSync(join(s.folder, name), "utf8")).not.toContain(KEY)
  })
})

describe("a vendor program, more cases", () => {
  const vendor = async (s: Awaited<ReturnType<typeof setup>>, write: () => void) => {
    await s.k((x) => Effect.sync(() => x.begin(s.agent.id)))
    write()
    await s.k((x) => Effect.sync(() => x.end(s.agent.id, "agent")))
  }

  test("a token that is not a stored key is put back too; a file that is new is deleted", async () => {
    const s = await setup()
    await s.save("Alpha", "clean text", "kept summary")
    const before = readFileSync(join(s.folder, "Alpha.md"), "utf8")
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    await vendor(s, () => {
      writeFileSync(join(s.folder, "Alpha.md"), `---\ntitle: Alpha\nsummary: x\n---\n\n${token}\n`)
      writeFileSync(join(s.folder, "New.md"), `# New\n\nA token ${token}\n`)
      writeFileSync(join(s.folder, "Fine.md"), "# Fine\n\nNo secret here.\n")
    })
    expect(readFileSync(join(s.folder, "Alpha.md"), "utf8")).toBe(before)
    expect(existsSync(join(s.folder, "New.md"))).toBe(false)
    // The files that are fine stay, and only they are changes of the agent.
    const view = await s.list()
    expect(view.articles.map((a) => [a.title, a.editor])).toEqual([
      ["Alpha", "user"],
      ["Fine", "agent"],
    ])
    expect((await s.changes()).map((c) => [c.kind, c.title, c.actor])).toEqual([
      ["add", "Fine", "agent"],
      ["add", "Alpha", "user"],
    ])
    for (const name of readdirSync(s.folder))
      expect(readFileSync(join(s.folder, name), "utf8")).not.toContain(token)
  })

  test("a deleted file and an edited file are changes of the agent; the limits are not enforced", async () => {
    const s = await setup()
    await s.save("Alpha", "one")
    await s.save("Beta", "two")
    await vendor(s, () => {
      rmSync(join(s.folder, "Alpha.md"))
      writeFileSync(join(s.folder, "Beta.md"), "---\ntitle: Beta\n---\n\nedited\n")
      // Six new files, more than the 5 changes a turn may make: the app told the limit only.
      for (let i = 0; i < 6; i++) writeFileSync(join(s.folder, `v${i}.md`), `# V${i}\n\nx\n`)
    })
    expect((await s.list()).total).toBe(7)
    const changes = (await s.changes()).slice(0, 8)
    expect(changes.every((c) => c.actor === "agent")).toBe(true)
    expect(changes.map((c) => c.kind).sort()).toEqual([
      "add",
      "add",
      "add",
      "add",
      "add",
      "add",
      "delete",
      "edit",
    ])
  })

  test("the instructions tell the folder, the format, and the limits of 5 changes and 500 articles", async () => {
    const s = await setup()
    const text =
      (await s.run(Knowledge.use((x) => Effect.succeed(x.prompt(s.agent.id, "", "files"))))) ?? ""
    expect(text).toContain(s.folder)
    expect(text).toContain("title:")
    expect(text).toContain("at most 5 article changes in one turn")
    expect(text).toContain("500 articles at most")
    expect(text).toContain("There are no articles yet.")
  })
})

describe("check", () => {
  test("finds a broken link after the linked article is deleted", async () => {
    const s = await setup()
    await s.save("Alpha", "See [[Beta]].", "", null)
    await s.save("Beta", "See [[Alpha]].")
    await s.k((x) => x.remove(s.agent.id, "Beta.md"))
    const found = await s.k((x) => x.findings(s.agent.id))
    expect(found.missingLinks).toEqual([{ from: "Alpha", to: "Beta" }])
    expect(found.noSource).toEqual(["Alpha"])
  })
})

describe("check, other cases", () => {
  test("a source that the user deleted does not count; one article is not reported as unlinked", async () => {
    const s = await setup()
    await s.k((x) => x.addSource(s.agent.id, { name: "a.txt", data: "data" }))
    await s.turn(call("write_article", { title: "Cited", body: "x", sources: ["a.txt"] }))
    expect(await s.k((x) => x.findings(s.agent.id))).toEqual({
      missingLinks: [],
      unlinked: [],
      noSource: [],
    })
    await s.k((x) => x.removeSource(s.agent.id, "a.txt"))
    expect(await s.k((x) => x.findings(s.agent.id))).toEqual({
      missingLinks: [],
      unlinked: [],
      noSource: ["Cited"],
    })
  })

  test("with two articles, the one that no other article links to is reported", async () => {
    const s = await setup()
    await s.save("Alpha", "See [[Beta]].")
    await s.save("Beta", "Text. [[Beta]]")
    // A link to itself is not a link from another article.
    const found = await s.k((x) => x.findings(s.agent.id))
    expect(found.unlinked).toEqual(["Alpha"])
    expect(found.missingLinks).toEqual([])
  })
})

describe("archive and delete", () => {
  test("archiving keeps the knowledge; deleting the agent deletes it with the workspace", async () => {
    const s = await setup()
    await s.save("Alpha")
    await s.turn(call("write_article", { title: "Beta", body: "x" }))
    await s.run(Agents.use((a) => a.archive(s.agent.id)))
    expect(existsSync(join(s.folder, "Alpha.md"))).toBe(true)
    expect((await s.list()).total).toBe(2)
    await s.run(Agents.use((a) => a.remove(s.agent.id)))
    expect(s.t.trashed).toContain(s.agent.workspace)
    const db = await s.db()
    expect(db.all("SELECT * FROM knowledge_file WHERE agent_id = ?", s.agent.id)).toHaveLength(0)
    expect(db.all("SELECT * FROM knowledge_change WHERE agent_id = ?", s.agent.id)).toHaveLength(0)
  })
})

describe("duplicate", () => {
  test("a copy of an agent has a new, empty workspace, so its knowledge is empty; the original keeps its own", async () => {
    const s = await setup()
    await s.save("Alpha", "Original text.", "first")
    await s.k((x) => x.addSource(s.agent.id, { name: "a.txt", data: "data" }))
    await s.turn(call("write_article", { title: "Beta", body: "By the agent." }))
    const copy = await s.run(Agents.use((a) => a.duplicate(s.agent.id, " copy")))
    expect(copy.workspace).not.toBe(s.agent.workspace)
    expect(copy.knowledgeEnabled).toBe(true)
    const view = await s.k((x) => x.list(copy.id))
    expect(view).toMatchObject({ total: 0, articles: [], sources: [], canOpenFolder: false })
    expect(existsSync(join(copy.workspace, "Knowledge"))).toBe(false)
    expect(await s.run(Knowledge.use((x) => x.changes(copy.id)))).toEqual([])
    // The copy does not read the knowledge of the original.
    const prompt = (id: string) =>
      s.run(
        Knowledge.use((x) => Effect.succeed(x.prompt(id, "Original text", "tools"))),
      ) as Promise<string>
    expect(await prompt(copy.id)).not.toContain("Alpha")
    expect(await prompt(s.agent.id)).toContain("Alpha")
    // The original is as it was, and it stays when the copy goes.
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Alpha", "Beta"])
    await s.run(Agents.use((a) => a.archive(copy.id)))
    await s.run(Agents.use((a) => a.remove(copy.id)))
    expect((await s.list()).articles.map((a) => a.title)).toEqual(["Alpha", "Beta"])
    expect(existsSync(join(s.folder, "Alpha.md"))).toBe(true)
  })
})

describe("channels", () => {
  test("a member in a channel uses its own knowledge only", async () => {
    const s = await setup()
    const bo = await s.make("Bo")
    await s.save("Ada only", "x", "mine")
    await s.save("Bo only", "x", "his", null, bo.id)
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Room",
          topic: "",
          memberIds: [s.agent.id, bo.id],
          leadId: null,
        }),
      ),
    )
    await s.run(Channels.use((c) => c.send(channel.id, "@Bo hello there")))
    await until(async () => {
      const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
      return tasks.length > 0 && tasks.every((x) => !["queued", "running"].includes(x.state))
    })
    const request = seen.at(-1)
    expect(request?.system).toContain("Bo only")
    expect(request?.system).not.toContain("Ada only")
    expect(request?.tools).toContain("write_article")
    // A secret never reaches a stored key check by accident.
    expect(await s.run(Secrets.use((x) => Effect.succeed(x.get(secretKey(s.account.id)))))).toBe(
      KEY,
    )
  })
})
