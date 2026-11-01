import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { unzipSync } from "fflate"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { copyAttachments } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testPlatform } from "./testing.ts"

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
      `INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at)
       VALUES ('m1', ?, 'user', ?, 'done', 1, 1)`,
      agent.id,
      JSON.stringify([{ kind: "text", text: `my key is ${KEY}` }]),
    )
    mkdirSync(join(agent.workspace, "attachments"), { recursive: true })
    writeFileSync(join(agent.workspace, "attachments", "note.txt"), "hello file")

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

    const b = app({ open: out })
    const imported = await b.run(Data.use((d) => d.import()))
    expect(imported?.agents).toBe(1)
    expect(imported?.messages).toBe(1)
    const bLocal = await b.run(Servers.use((s) => s.local))
    const list = await b.run(Agents.use((x) => x.list(bLocal.id, false)))
    expect(list.map((x) => x.name)).toEqual(["Ada"])
    expect(existsSync(join(list[0]?.workspace ?? "", "attachments", "note.txt"))).toBe(true)
    const bDb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(bDb.get<{ parts: string }>("SELECT parts FROM message")?.parts).toContain("[redacted]")
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
