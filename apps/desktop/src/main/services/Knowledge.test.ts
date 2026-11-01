import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatMessage, MessagePart } from "@robot/shared"
import { KNOWLEDGE_CHARS_MAX, KNOWLEDGE_LINES_MAX } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Knowledge } from "./Knowledge.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

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
    const calls = many
      ? (JSON.parse(many[2] as string) as unknown[]).map((a, i) => callOf(i, many[1] as string, a))
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
    expect((await s.list()).folderExists).toBe(false)
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
    const lines = text.split("\n").filter((l) => l.startsWith("- "))
    expect(lines.length).toBeLessThanOrEqual(KNOWLEDGE_LINES_MAX)
    expect(lines.join("\n").length).toBeLessThanOrEqual(KNOWLEDGE_CHARS_MAX)
    expect(lines[0]).toBe("- Deploy pipeline: release steps")
    expect(text).toContain("51 more articles are not in this list")
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
    // A new chat turn cannot use it...
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
    const outside = join(mkdtempSync(join(tmpdir(), "robot-out-")), "secret.txt")
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
    const chosen = mkdtempSync(join(tmpdir(), "robot-chosen-"))
    const db = await s.db()
    db.run("UPDATE agent SET workspace = ? WHERE id = ?", chosen, s.agent.id)
    await s.send(call("write_article", { title: "Alpha", body: "x" }))
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({
      kind: "approval",
      summary: join(chosen, "Knowledge"),
    })
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
