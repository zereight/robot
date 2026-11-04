import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { RuleInput } from "@robot/shared"
import { Effect, ManagedRuntime } from "effect"
import { unzipSync } from "fflate"
import { appLayer } from "../layers.ts"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { BrowserProfiles } from "./BrowserProfiles.ts"
import { copyAttachments } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Decision } from "./Decision.ts"
import { Knowledge } from "./Knowledge.ts"
import { Memory } from "./Memory.ts"
import { Places } from "./Places.ts"
import { Providers } from "./Providers.ts"
import { Rules } from "./Rules.ts"
import { Search } from "./Search.ts"
import { Secrets } from "./Secrets.ts"
import { Sections } from "./Sections.ts"
import { Servers } from "./Servers.ts"
import { testPlatform } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

const KEY = "sk-export-test-0123456789abcdef"

const app = (pick: { save?: string; open?: string } = {}) => {
  const { platform, dataDir } = testPlatform()
  const runtime = ManagedRuntime.make(
    appLayer({
      platform: {
        ...platform,
        pickSavePath: async () => pick.save,
        pickArchive: async () => pick.open,
      },
      databaseFile: ":memory:",
      localServerName: "Test computer",
      emit: () => {},
      secrets: Secrets.memory,
    }),
  )
  return { run: runtime.runPromise, dataDir }
}

describe("attachments", () => {
  test("copies files into the workspace, numbers a taken name, and checks limits", () => {
    const { dataDir } = app()
    const src = join(dataDir, "src")
    mkdirSync(src)
    writeFileSync(join(src, "a.txt"), "one")
    const workspace = join(dataDir, "ws")
    const first = copyAttachments(workspace, [join(src, "a.txt")])
    const second = copyAttachments(workspace, [join(src, "a.txt")])
    expect(first[0]).toMatchObject({ name: "a.txt", path: "attachments/a.txt", size: 3 })
    expect(second[0]?.name).toBe("a (2).txt")
    expect(readFileSync(join(workspace, "attachments", "a (2).txt"), "utf8")).toBe("one")
    expect(() => copyAttachments(workspace, [join(src, "missing.txt")])).toThrow()
    expect(() => copyAttachments(workspace, Array(11).fill(join(src, "a.txt")))).toThrow()
  })
})

describe("export and import", () => {
  test("the key of the decision model is not in the archive, in whatever form a text holds it", async () => {
    const out = join(testPlatform().dataDir, "decision-export.zip")
    const a = app({ save: out })
    // A key that has no known shape: only the stored value tells that it is a key.
    const key = "plain-decision-key-0123456789"
    await a.run(Decision.use((d) => d.keys({ openrouter: key })))
    const local = await a.run(Servers.use((s) => s.local))
    const agent = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at)
       VALUES ('m1', ?, 'user', ?, 'done', 1, 1)`,
      agent.id,
      JSON.stringify([{ kind: "text", text: `the decision key is ${key}` }]),
    )
    await a.run(Data.use((d) => d.export()))
    for (const data of Object.values(unzipSync(readFileSync(out))))
      expect(Buffer.from(data).includes(key)).toBe(false)
  })

  test("the archive has no key; a fresh app restores agents, chats and files", async () => {
    const out = join(testPlatform().dataDir, "export.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    const account = await a
      .run(
        Providers.use((p) =>
          p.connect({ kind: "custom", name: "M", baseUrl: "http://127.0.0.1:9/v1", apiKey: KEY }),
        ),
      )
      .catch(() => undefined)
    void account
    const agent = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    db.run(
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at, context)
       VALUES ('m1', ?, 'user', ?, 'done', 1, 1, ?)`,
      agent.id,
      JSON.stringify([{ kind: "text", text: `my key is ${KEY}` }]),
      `What you remember:\n- the key is ${KEY}`,
    )
    mkdirSync(join(agent.workspace, "attachments"), { recursive: true })
    writeFileSync(join(agent.workspace, "attachments", "note.txt"), "hello file")
    // Browser profiles stay on this computer, as the browser data does.
    const profile = await a.run(BrowserProfiles.use((b) => b.create("Secret Profile")))
    await a.run(BrowserProfiles.use((b) => b.assign(agent.id, profile.id)))

    const result = await a.run(Data.use((d) => d.export()))
    expect(result).toEqual({ path: out, files: 1 })
    const entries = unzipSync(readFileSync(out))
    expect(Object.keys(entries).sort()).toEqual([
      "README.txt",
      `attachments/${agent.id}/note.txt`,
      "meta.json",
      "robot.db",
    ])
    for (const data of Object.values(entries)) expect(Buffer.from(data).includes(KEY)).toBe(false)
    // The index of message search is a second copy of the text. The archive does not carry it.
    const archived = join(testPlatform().dataDir, "archived.db")
    writeFileSync(archived, entries["robot.db"] as Uint8Array)
    const inArchive = new DatabaseSync(archived)
    expect(
      inArchive
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE '%message_fts%' OR name LIKE '%message_text%'",
        )
        .all(),
    ).toEqual([])
    expect(inArchive.prepare("SELECT 1 FROM browser_profile").all()).toEqual([])
    expect(inArchive.prepare("SELECT 1 FROM agent_browser").all()).toEqual([])
    inArchive.close()

    const b = app({ open: out })
    const imported = await b.run(Data.use((d) => d.import()))
    expect(imported?.agents).toBe(1)
    expect(imported?.messages).toBe(1)
    const bLocal = await b.run(Servers.use((s) => s.local))
    // The restored messages are in the search of the new app.
    const found = await b.run(Search.use((x) => x.page(bLocal.id, "redacted", 0)))
    expect(found.hits.map((h) => h.placeName)).toEqual(["Ada"])
    const list = await b.run(Agents.use((x) => x.list(bLocal.id, false)))
    expect(list.map((x) => x.name)).toEqual(["Ada"])
    expect(existsSync(join(list[0]?.workspace ?? "", "attachments", "note.txt"))).toBe(true)
    const bDb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(bDb.get<{ parts: string }>("SELECT parts FROM message")?.parts).toContain("[redacted]")
    // The notes of a turn are memory items, so a key in them is hidden like a key in the memory.
    expect(bDb.get<{ context: string }>("SELECT context FROM message")?.context).toBe(
      "What you remember:\n- the key is [redacted]",
    )
  })

  test("the rules and the action log are in the archive and come back; a key in a rule is hidden (spec 014, 007)", async () => {
    const out = join(testPlatform().dataDir, "export-rules.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    const agent = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const made = (rule: RuleInput) => a.run(Rules.use((r) => r.add(rule)))
    const own = await made({ agentId: agent.id, kind: "shell", text: "ls", decision: "allow" })
    const all = await made({ agentId: null, kind: "web", text: "example.com", decision: "deny" })
    const keyed = await made({
      agentId: agent.id,
      kind: "shell",
      text: `curl -H "Authorization: Bearer ${KEY}" https://example.com`,
      decision: "allow",
    })
    a.run(
      ActionLog.use((l) =>
        Effect.sync(() =>
          l.add({
            agentId: agent.id,
            kind: "shell",
            target: "ls",
            decidedBy: "allow_rule",
            result: "ran",
            taskId: null,
            outside: null,
            rule: { id: own.id, kind: "shell", text: "ls", detail: null },
          }),
        ),
      ),
    )
    await a.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(out))
    for (const data of Object.values(entries)) expect(Buffer.from(data).includes(KEY)).toBe(false)

    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const restored = await b.run(Rules.use((r) => r.list()))
    expect(restored.map((r) => r.id).sort()).toEqual([keyed.id, all.id, own.id].sort())
    expect(restored.find((r) => r.id === all.id)).toMatchObject({ agentId: null, decision: "deny" })
    expect(restored.find((r) => r.id === own.id)).toMatchObject({ agentId: agent.id })
    // The rule for all agents is on the server of this computer now, and applies to the agent.
    const bLocal = await b.run(Servers.use((s) => s.local))
    const bDb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(
      bDb.all<{ server_id: string }>("SELECT DISTINCT server_id FROM permission_rule"),
    ).toEqual([{ server_id: bLocal.id }])
    const [bAgent] = await b.run(Agents.use((x) => x.list(bLocal.id, false)))
    const verdict = await b.run(
      Rules.use((r) =>
        Effect.sync(() => r.verdict(bAgent?.id ?? "", { kind: "web", host: "example.com" })),
      ),
    )
    expect(verdict).toMatchObject({ kind: "deny", rule: { id: all.id } })
    // The key left the text of the rule: the rule matches no command now.
    expect(restored.find((r) => r.id === keyed.id)?.text).toContain("[redacted]")
    // The entry of the log comes back and names its rule.
    const log = await b.run(ActionLog.use((l) => l.list()))
    expect(log).toMatchObject([{ decidedBy: "allow_rule", rule: { id: own.id, deleted: false } }])
  })

  test("the reviewed tools of a connection stay out of the archive; an import brings the connection back off, with none (spec 018, 014)", async () => {
    const out = join(testPlatform().dataDir, "export-review.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((x) => x.local))
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    const tools = JSON.stringify([
      { name: "echo", description: "Says it.", params: [], readOnly: false },
    ])
    const add = (id: string, name: string, adopt: number, reviewed: string) =>
      db.run(
        `INSERT INTO tool_connection
           (id, server_id, name, name_key, kind, command, enabled, state, tools, reviewed, review_adopt, created_at)
         VALUES (?, ?, ?, ?, 'program', 'notes-server', 1, 'connected', ?, ?, ?, 1)`,
        id,
        local.id,
        name,
        name.toLowerCase(),
        tools,
        reviewed,
        adopt,
      )
    // One connection with reviewed tools, and one from before the review that waits for its first start.
    add("c1", "Notes", 0, tools)
    add("c2", "Journal", 1, "[]")
    await a.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(out))
    const archived = join(testPlatform().dataDir, "archived-review.db")
    writeFileSync(archived, entries["robot.db"] as Uint8Array)
    const inArchive = new DatabaseSync(archived)
    expect(
      inArchive.prepare("SELECT id, reviewed, review_adopt FROM tool_connection ORDER BY id").all(),
    ).toEqual([
      { id: "c1", reviewed: "[]", review_adopt: 0 },
      { id: "c2", reviewed: "[]", review_adopt: 0 },
    ])
    inArchive.close()

    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const bDb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(
      bDb.all(
        "SELECT id, enabled, state, tools, reviewed, review_adopt FROM tool_connection ORDER BY id",
      ),
    ).toEqual([
      { id: "c1", enabled: 0, state: "untested", tools: "[]", reviewed: "[]", review_adopt: 0 },
      { id: "c2", enabled: 0, state: "untested", tools: "[]", reviewed: "[]", review_adopt: 0 },
    ])
  })

  // Each export works in its own folder and removes it at the end, so two exports at once do not
  // meet in one temporary file, and none stays behind.
  test("two exports at once both finish, and no temporary folder stays", async () => {
    // The test has its own temporary folder, so that an export of another test file, which runs
    // at the same time in another process, is not counted.
    const own = mkdtempSync(join(tmpdir(), "robot-own-tmp-"))
    const saved = process.env.TMPDIR
    process.env.TMPDIR = own
    try {
      const out = join(testPlatform().dataDir, "twice.zip")
      const a = app({ save: out })
      const local = await a.run(Servers.use((s) => s.local))
      await a.run(
        Agents.use((x) =>
          x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
        ),
      )
      const results = await Promise.all([
        a.run(Data.use((d) => d.export())),
        a.run(Data.use((d) => d.export())),
      ])
      expect(results.every((r) => r !== null && "path" in r)).toBe(true)
      expect(Object.keys(unzipSync(readFileSync(out)))).toContain("robot.db")
      expect(readdirSync(own).filter((n) => n.startsWith("robot-export-"))).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
      rmSync(own, { recursive: true, force: true })
    }
  })

  test("a hidden key leaves no trace in the pages of the database file", async () => {
    const out = join(testPlatform().dataDir, "export-pages.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    await a
      .run(
        Providers.use((p) =>
          p.connect({ kind: "custom", name: "M", baseUrl: "http://127.0.0.1:9/v1", apiKey: KEY }),
        ),
      )
      .catch(() => undefined)
    const agent = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    // The SQLite of some systems wipes a freed cell, and some does not (Electron). Test the second.
    db.run("PRAGMA secure_delete = OFF")
    // Many rows share a page. A value that is replaced by a shorter one must not stay in the page.
    for (let i = 0; i < 60; i++) {
      const filler = "x".repeat(10 + ((i * 37) % 90))
      db.run(
        `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at)
         VALUES (?, ?, 'user', ?, 'done', ?, ?)`,
        `m${i}`,
        agent.id,
        JSON.stringify([{ kind: "text", text: `note ${i} ${filler} key ${KEY} ${filler} end` }]),
        i,
        i,
      )
      db.run(
        `INSERT INTO task (id, agent_id, source, prompt, label, state, created_at)
         VALUES (?, ?, 'chat', ?, ?, 'done', ?)`,
        `t${i}`,
        agent.id,
        `${filler} use ${KEY} for it ${filler} ${filler}`,
        `${filler} use ${KEY} for ${filler}`,
        i,
      )
    }
    await a.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(out))
    const found = Object.entries(entries)
      .filter(([, data]) => Buffer.from(data).includes(KEY))
      .map(([name]) => name)
    expect(found).toEqual([])
  })

  test("knowledge is in the archive: articles without keys, sources as they are, and the changes", async () => {
    const out = join(testPlatform().dataDir, "export-knowledge.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    const agent = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const save = (title: string, body: string) =>
      a.run(Knowledge.use((k) => k.save(agent.id, { file: null, title, summary: "s", body })))
    await save("Alpha", "First article.")
    await save("Beta", "See [[Alpha]].")
    // The app keeps only a source without a key (016). It refuses one with a key.
    const source = "A binary-like source.\u0000\u0001\nwith no key inside.\n"
    await a.run(Knowledge.use((k) => k.addSource(agent.id, { name: "data.bin", data: source })))
    await expect(
      a.run(
        Knowledge.use((k) =>
          k.addSource(agent.id, { name: "leak.txt", data: `A page with a key ${KEY} inside.\n` }),
        ),
      ),
    ).rejects.toMatchObject({ code: "knowledge_secret" })
    expect(existsSync(join(agent.workspace, "Knowledge", "sources", "leak.txt"))).toBe(false)
    // A file that the user puts in the folder by hand is not checked, and the export copies it
    // byte for byte.
    const byHand = `Kept by hand, with a key ${KEY} inside.\n`
    writeFileSync(join(agent.workspace, "Knowledge", "sources", "by-hand.txt"), byHand)
    // Another app puts a key in an article. The archive must not carry it.
    writeFileSync(
      join(agent.workspace, "Knowledge", "Alpha.md"),
      `---\ntitle: Alpha\nsummary: s\n---\n\nKey ${KEY} here.\n`,
    )
    expect((await a.run(Data.use((d) => d.export()))).files).toBe(4)

    const entries = unzipSync(readFileSync(out))
    expect(Object.keys(entries).sort()).toEqual(
      [
        "README.txt",
        `knowledge/${agent.id}/Alpha.md`,
        `knowledge/${agent.id}/Beta.md`,
        `knowledge/${agent.id}/sources/by-hand.txt`,
        `knowledge/${agent.id}/sources/data.bin`,
        "meta.json",
        "robot.db",
      ].sort(),
    )
    for (const [name, data] of Object.entries(entries))
      if (!name.endsWith("by-hand.txt")) expect(Buffer.from(data).includes(KEY)).toBe(false)
    // A source is copied byte for byte.
    expect(Buffer.from(entries[`knowledge/${agent.id}/sources/data.bin`] ?? []).toString()).toBe(
      source,
    )
    expect(Buffer.from(entries[`knowledge/${agent.id}/sources/by-hand.txt`] ?? []).toString()).toBe(
      byHand,
    )
    expect(Buffer.from(entries[`knowledge/${agent.id}/Alpha.md`] ?? []).toString()).toContain(
      "[redacted]",
    )

    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const bLocal = await b.run(Servers.use((s) => s.local))
    const restored = (await b.run(Agents.use((x) => x.list(bLocal.id, false))))[0]
    expect(restored).toBeDefined()
    const view = await b.run(Knowledge.use((k) => k.list(restored?.id ?? "")))
    expect(view.articles.map((x) => x.title)).toEqual(["Alpha", "Beta"])
    expect(view.sources.map((x) => x.name)).toEqual(["by-hand.txt", "data.bin"])
    expect(
      readFileSync(join(restored?.workspace ?? "", "Knowledge", "sources", "data.bin"), "utf8"),
    ).toBe(source)
    // The restored folder matches the records: nothing shows as a new change.
    const changes = await b.run(Knowledge.use((k) => k.changes(restored?.id ?? "")))
    expect(changes.length).toBeGreaterThanOrEqual(2)
    expect(changes.every((c) => c.actor === "user")).toBe(true)
    const again = await b.run(Knowledge.use((k) => k.changes(restored?.id ?? "")))
    expect(again.map((c) => c.id)).toEqual(changes.map((c) => c.id))
  })

  test("a subscription account comes back switched off; the program stays as it is", async () => {
    const out = join(testPlatform().dataDir, "export-runtime.zip")
    const a = app({ save: out })
    const dbA = await a.run(Database.use((d) => Effect.succeed(d)))
    dbA.run(
      "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('r1', 'claude_code', 'Claude', '', 1)",
    )
    dbA.run(
      "INSERT INTO provider_account (id, kind, name, base_url, sign_in, created_at) VALUES ('r2', 'claude_code', 'Work', '', '11111111-2222-3333-4444-555555555555', 2)",
    )
    await a.run(Data.use((d) => d.export()))

    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const dbB = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(dbB.get<{ off: number }>("SELECT off FROM provider_account WHERE id = 'r1'")?.off).toBe(
      1,
    )
    const accounts = await b.run(Providers.use((p) => p.list))
    expect(accounts.find((x) => x.id === "r1")?.connected).toBe(false)
    // The account keeps the name of its sign-in, and the folder is not here: nobody is signed in.
    // It does not fall back to the account of this computer.
    const work = accounts.find((x) => x.id === "r2")
    expect(work).toMatchObject({ connected: false, signIn: "11111111-2222-3333-4444-555555555555" })
  })

  test("memory history and proposals are in the archive: text that looks like a secret is [redacted] and has no Undo; the rest comes back whole (spec 014, 008)", async () => {
    const out = join(testPlatform().dataDir, "export-memory.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    await a
      .run(
        Providers.use((p) =>
          p.connect({ kind: "custom", name: "M", baseUrl: "http://127.0.0.1:9/v1", apiKey: KEY }),
        ),
      )
      .catch(() => undefined)
    const ada = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const secret = "my token sk-abcdefghijklmnop1234 end"
    // The user types a secret by hand (allowed), edits an ordinary item, and the agent suggests.
    const typed = await a.run(Memory.use((m) => m.add(ada.id, secret, "user")))
    await a.run(Memory.use((m) => m.update(typed.id, `${secret} and the key ${KEY}`)))
    const plain = await a.run(Memory.use((m) => m.add(ada.id, "Likes tea", "user")))
    await a.run(Memory.use((m) => m.update(plain.id, "Likes green tea")))
    await a.run(Memory.use((m) => m.setMode(ada.id, "ask")))
    await a.run(Memory.use((m) => m.save(ada.id, "Lives in Busan")))
    await a.run(Data.use((d) => d.export()))

    // Nothing in the archive holds the secret, the key, or the text of the secret rows.
    const entries = unzipSync(readFileSync(out))
    for (const data of Object.values(entries)) {
      expect(Buffer.from(data).includes("sk-abcdefghijklmnop1234")).toBe(false)
      expect(Buffer.from(data).includes(KEY)).toBe(false)
    }

    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const bLocal = await b.run(Servers.use((s) => s.local))
    const [agent] = await b.run(Agents.use((x) => x.list(bLocal.id, false)))
    const id = agent?.id ?? ""
    const rows = await b.run(Memory.use((m) => m.history(id)))
    // Newest first: the edit of the plain item, its add, the edit of the secret, its add.
    expect(rows.map((r) => [r.kind, r.before, r.after, r.undo])).toEqual([
      ["edited", "Likes tea", "Likes green tea", { on: true }],
      ["added", null, "Likes tea", { on: false, why: "newer" }],
      ["edited", "[redacted]", "[redacted]", { on: false, why: "secret" }],
      ["added", null, "[redacted]", { on: false, why: "secret" }],
    ])
    // The rows of the secret stay without Undo after the import, as the mark is not a secret.
    const bDb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(
      bDb.all<{ hidden: number }>("SELECT hidden FROM memory_history ORDER BY at, rowid"),
    ).toEqual([{ hidden: 1 }, { hidden: 1 }, { hidden: 0 }, { hidden: 0 }])
    // The proposal and the choice of the agent come back too.
    expect((await b.run(Memory.use((m) => m.proposals(id)))).map((p) => p.text)).toEqual([
      "Lives in Busan",
    ])
    expect(await b.run(Memory.use((m) => m.mode(id)))).toBe("ask")
  })

  test("user sections and the places in them come back in the same order", async () => {
    const out = join(testPlatform().dataDir, "export-sections.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    const research = await a.run(
      Sections.use((s) => s.create({ serverId: local.id, kind: "agent", name: "Research" })),
    )
    await a.run(Sections.use((s) => s.create({ serverId: local.id, kind: "agent", name: "Ops" })))
    const ada = await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    await a.run(Sections.use((s) => s.assign({ kind: "agent", id: ada.id }, research.id)))
    await a.run(Data.use((d) => d.export()))

    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const bLocal = await b.run(Servers.use((s) => s.local))
    const list = await b.run(Places.use((p) => p.list(bLocal.id)))
    const agents = list.find((s) => s.id === "agents")
    expect(agents?.places).toEqual([])
    expect(agents?.sections.map((s) => [s.name, s.places.map((p) => p.name)])).toEqual([
      ["Research", ["Ada"]],
      ["Ops", []],
    ])
  })

  test("the notes and steps of a workflow come back; the links, the sync records and the computer of a workflow stay out of the archive (spec 014, 012, 019)", async () => {
    const out = join(testPlatform().dataDir, "export-link.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    await a.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Ada", role: "", instructions: "", model: null }),
      ),
    )
    const flow = await a.run(
      Workflows.use((w) =>
        w.create({
          serverId: local.id,
          name: "Flow",
          trigger: { kind: "manual" },
          steps: [{ id: "n", kind: "notify", name: "Tell me", x: 0, y: 0, title: "Done" }],
          edges: [],
          notes: [{ id: "note-1", text: "Keep it short", tone: "blue", x: 3, y: 4 }],
        }),
      ),
    )
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    db.run(
      `INSERT INTO device_link (id, name, kind, public_key, position, created_at)
       VALUES ('dev-x', 'Other computer', 'computer', 'PUBLIC-KEY-OF-THE-LINK', 0, 1)`,
    )
    db.run(
      `INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
       VALUES (1, 'dev-x', 'Other computer', 'asker', 'merge', 'live', 1)`,
    )
    db.run("INSERT INTO sync_state (key, value) VALUES ('clock', 'state-of-the-pair')")
    db.run("INSERT INTO sync_alias (peer_id, local_id) VALUES ('peer-agent', 'local-agent')")
    db.run(
      "INSERT INTO sync_change (at, kind, item_id, name, action) VALUES (1, 'agent', 'a', 'Ada', 'added')",
    )
    db.run("UPDATE workflow SET runs_on = 'dev-x'")
    await a.run(Data.use((d) => d.export()))

    const entries = unzipSync(readFileSync(out))
    const file = join(testPlatform().dataDir, "exported.db")
    writeFileSync(file, entries["robot.db"] ?? new Uint8Array())
    expect(Buffer.from(entries["robot.db"] ?? []).includes("PUBLIC-KEY-OF-THE-LINK")).toBe(false)
    const exported = new DatabaseSync(file)
    try {
      for (const table of [
        "device_link",
        "sync_pair",
        "sync_item",
        "sync_field",
        "sync_tomb",
        "sync_out",
        "sync_dirty",
        "sync_seen",
        "sync_alias",
        "sync_change",
        "sync_state",
      ]) {
        const row = exported.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
        expect(row.n, table).toBe(0)
      }
      const wf = exported.prepare("SELECT runs_on, notes FROM workflow").get() as {
        runs_on: string | null
        notes: string
      }
      expect(wf.runs_on).toBeNull()
      expect(JSON.parse(wf.notes)).toHaveLength(1)
    } finally {
      exported.close()
    }

    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const bLocal = await b.run(Servers.use((s) => s.local))
    const restored = (await b.run(Workflows.use((w) => w.list(bLocal.id)))).find(
      (w) => w.id === flow.id,
    )
    expect(restored?.notes).toEqual([
      { id: "note-1", text: "Keep it short", tone: "blue", x: 3, y: 4 },
    ])
    expect(restored?.steps.map((x) => x.kind)).toEqual(["notify"])
    // It runs here: the computer that it belonged to is not in the archive.
    expect(restored?.runsOn).toBeNull()
    const bdb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(bdb.get<{ n: number }>("SELECT COUNT(*) AS n FROM device_link")?.n).toBe(0)
    expect(bdb.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_pair")?.n).toBe(0)
  })

  test("import refuses an app that already has an agent, and a file that is not an export", async () => {
    const dir = testPlatform().dataDir
    const junk = join(dir, "junk.zip")
    writeFileSync(junk, "not a zip")
    const b = app({ open: junk })
    const bad = await b.run(Data.use((d) => d.import()).pipe(Effect.flip))
    expect(bad.code).toBe("import_invalid")

    const local = await b.run(Servers.use((s) => s.local))
    await b.run(
      Agents.use((x) =>
        x.create({ serverId: local.id, name: "Bo", role: "", instructions: "", model: null }),
      ),
    )
    const refused = await b.run(Data.use((d) => d.import()).pipe(Effect.flip))
    expect(refused.code).toBe("import_not_empty")
  })
})
