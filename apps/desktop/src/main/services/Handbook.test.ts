import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HANDBOOK_HISTORY_MAX, HANDBOOK_MAX } from "@robot/shared"
import { Effect, ManagedRuntime } from "effect"
import { unzipSync } from "fflate"
import { appLayer } from "../layers.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import type { AppError } from "./errors.ts"
import { Handbook } from "./Handbook.ts"
import { Providers } from "./Providers.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testPlatform, testRuntime } from "./testing.ts"

// The handbook (spec 002, "Handbook").

/** The system text of every request that reached the stand-in model, newest last. */
const systems: string[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    systems.push(String(body.messages.find((m) => m.role === "system")?.content ?? ""))
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`
    return new Response(chunk, { headers: { "content-type": "text/event-stream" } })
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

const KEY = "sk-handbook-test-key-0123456789"

const setup = async () => {
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
  const agent = (name: string, instructions: string, readHandbook?: boolean) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions,
          ...(readHandbook === undefined ? {} : { readHandbook }),
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  const save = (text: string, source: "page" | "device" | "restore" | "import" = "page") =>
    run(Handbook.use((h) => h.save(local.id, text, source)))
  const get = () => run(Handbook.use((h) => h.get(local.id)))
  const history = () => run(Handbook.use((h) => h.history(local.id)))
  /** The code of the error that an effect fails with. */
  const codeOf = async (effect: Effect.Effect<unknown, AppError, Handbook | Agents>) =>
    (await run(Effect.flip(effect))).code
  /** Sends a text to an agent and gives the system text of the request that it made. */
  const ask = async (agentId: string, text: string) => {
    const before = systems.length
    await run(Chat.use((c) => c.send({ agentId, text, replyTo: null })))
    await until(async () => {
      const last = (await run(Chat.use((c) => c.history(agentId)))).messages.at(-1)
      return systems.length > before && last?.author === "agent" && last.status === "done"
    })
    return systems.at(before) ?? ""
  }
  return { t, run, local, account, agent, save, get, history, codeOf, ask }
}

const order = (system: string, ...markers: string[]) => markers.map((m) => system.indexOf(m))
const ascending = (list: number[]) =>
  list.every((n, i) => n >= 0 && (i === 0 || n > (list[i - 1] ?? -1)))

describe("the handbook (spec 002)", () => {
  test("it is empty at the start; a save is the newest version; the same text makes no version", async () => {
    const s = await setup()
    expect(await s.get()).toEqual({ serverId: s.local.id, text: "", updatedAt: null })
    expect(await s.history()).toEqual([])

    await s.save("Answer in Korean.")
    expect((await s.get()).text).toBe("Answer in Korean.")
    expect((await s.get()).updatedAt).not.toBeNull()
    await s.save("Answer in Korean.")
    expect(await s.history()).toHaveLength(1)

    await s.save("Answer in English.", "device")
    expect((await s.history()).map((v) => [v.text, v.source])).toEqual([
      ["Answer in English.", "device"],
      ["Answer in Korean.", "page"],
    ])
    // Clearing the text is a version too. An empty handbook gives nothing to any agent.
    await s.save("")
    expect((await s.get()).text).toBe("")
    expect(await s.history()).toHaveLength(3)
  })

  test("at most 20 versions stay, and the oldest go first", async () => {
    const s = await setup()
    for (let i = 1; i <= 25; i++) await s.save(`Version ${i}`)
    const versions = await s.history()
    expect(versions).toHaveLength(HANDBOOK_HISTORY_MAX)
    expect(versions[0]?.text).toBe("Version 25")
    expect(versions.at(-1)?.text).toBe("Version 6")
  })

  test("a text over 20000 characters, and a text that looks like a secret, are refused with the reason and change nothing", async () => {
    const s = await setup()
    await s.save("Keep me.")
    const attempt = (text: string) => Handbook.use((h) => h.save(s.local.id, text, "page"))
    expect(await s.codeOf(attempt("x".repeat(HANDBOOK_MAX + 1)))).toBe("handbook_too_long")
    // The limit counts characters, not bytes: 20000 Korean characters are allowed.
    await s.save("가".repeat(HANDBOOK_MAX))
    await s.save("Keep me.")
    // A key of a known form, a token, a private key block, and the key of a stored account.
    for (const secret of [
      "Use sk-abcdefghijklmnopqrstuvwxyz0123 to call it.",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      `The key is ${KEY}`,
    ])
      expect(await s.codeOf(attempt(secret))).toBe("handbook_secret")
    expect((await s.get()).text).toBe("Keep me.")
    expect((await s.history()).map((v) => v.text)).toEqual([
      "Keep me.",
      "가".repeat(HANDBOOK_MAX),
      "Keep me.",
    ])
  })

  test("Restore makes the old text the handbook as a new version, and keeps every version", async () => {
    const s = await setup()
    await s.save("One")
    await s.save("Two")
    await s.save("Three")
    const first = (await s.history()).at(-1)
    await s.run(Handbook.use((h) => h.restore(s.local.id, first?.id ?? "")))
    expect((await s.get()).text).toBe("One")
    const versions = await s.history()
    expect(versions.map((v) => [v.text, v.source])).toEqual([
      ["One", "restore"],
      ["Three", "page"],
      ["Two", "page"],
      ["One", "page"],
    ])
    // A version that does not exist, or one of another server, is refused.
    expect(await s.codeOf(Handbook.use((h) => h.restore(s.local.id, "nothing")))).toBe(
      "version_not_found",
    )
    expect(await s.codeOf(Handbook.use((h) => h.restore("other-server", first?.id ?? "")))).toBe(
      "version_not_found",
    )
  })

  test("a save tells the windows, and a server that does not exist is refused", async () => {
    const s = await setup()
    await s.save("Hello")
    expect(s.t.events.filter((e) => e.event === "handbook.changed").map((e) => e.payload)).toEqual([
      { serverId: s.local.id },
    ])
    expect(await s.codeOf(Handbook.use((h) => h.save("nowhere", "Hello", "page")))).toBe(
      "invalid_input",
    )
  })
})

describe("the order of the texts that an agent reads (spec 002, 004)", () => {
  test("the handbook comes first, then the own instructions, and the app tells the order", async () => {
    const s = await setup()
    const ada = await s.agent("Ada", "Be brief.")
    // No handbook: the text is the instructions as they were, with nothing new.
    expect(await s.ask(ada.id, "hi")).toStartWith("Be brief.")
    expect(systems.at(-1)).not.toContain("Handbook:")

    await s.save("Answer in Korean.")
    const system = await s.ask(ada.id, "hi again")
    expect(
      ascending(
        order(system, "Handbook:", "Answer in Korean.", "Your own instructions:", "Be brief."),
      ),
    ).toBe(true)
    expect(system).toContain("in this order: the handbook and your own instructions")
    expect(system).toContain("the later text wins")
    expect(system).toContain("The rules of the app always win over all of them")
    // The rules of the app and the workspace line come after the three texts.
    expect(system.indexOf("Your workspace folder")).toBeGreaterThan(system.indexOf("Be brief."))
  })

  test("the switch turns the handbook off for one agent; an empty handbook gives nothing", async () => {
    const s = await setup()
    const ada = await s.agent("Ada", "Be brief.")
    const bo = await s.agent("Bo", "Be bold.", false)
    expect(ada.readHandbook).toBe(true)
    expect(bo.readHandbook).toBe(false)
    await s.save("Answer in Korean.")
    expect(await s.ask(ada.id, "hi")).toContain("Answer in Korean.")
    expect(await s.ask(bo.id, "hi")).not.toContain("Answer in Korean.")
    // The switch counts from the next turn.
    await s.run(Agents.use((a) => a.update(bo.id, { readHandbook: true })))
    expect(await s.ask(bo.id, "hi again")).toContain("Answer in Korean.")
    await s.run(Agents.use((a) => a.update(ada.id, { readHandbook: false })))
    expect(await s.ask(ada.id, "hi again")).not.toContain("Answer in Korean.")
    // An agent with no instructions of its own still gets the handbook.
    const empty = await s.agent("Cy", "")
    expect(await s.ask(empty.id, "hi")).toContain("Answer in Korean.")
    // The handbook is empty again: nothing reaches any agent.
    await s.save("")
    expect(await s.ask(bo.id, "third")).not.toContain("Handbook:")
  })

  test("a change counts from the next turn, and a duplicate keeps the switch", async () => {
    const s = await setup()
    const ada = await s.agent("Ada", "Be brief.", false)
    await s.save("First text.")
    const copy = await s.run(Agents.use((a) => a.duplicate(ada.id, "copy")))
    expect(copy.readHandbook).toBe(false)
    await s.run(Agents.use((a) => a.update(ada.id, { readHandbook: true })))
    expect(await s.ask(ada.id, "one")).toContain("First text.")
    await s.save("Second text.")
    const next = await s.ask(ada.id, "two")
    expect(next).toContain("Second text.")
    expect(next).not.toContain("First text.")
  })
})

describe("export and import (spec 014)", () => {
  const app = (pick: { save?: string; open?: string }) => {
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

  test("the archive holds the handbook, and its history with keys hidden; an import restores them", async () => {
    const out = join(testPlatform().dataDir, "handbook-export.zip")
    const a = app({ save: out })
    const local = await a.run(Servers.use((s) => s.local))
    const ada = await a.run(
      Agents.use((x) =>
        x.create({
          serverId: local.id,
          name: "Ada",
          role: "",
          instructions: "One",
          readHandbook: false,
          model: null,
        }),
      ),
    )
    await a.run(Agents.use((x) => x.update(ada.id, { instructions: "Two" })))
    await a.run(Handbook.use((h) => h.save(local.id, "First text.", "page")))
    await a.run(Handbook.use((h) => h.save(local.id, "Second text.", "device")))
    // A key that was typed before it was stored: it is in the text when the export runs.
    const db = await a.run(Database.use((d) => Effect.succeed(d)))
    db.run(
      "INSERT INTO handbook_version (id, server_id, text, source, created_at) VALUES ('keyed', ?, ?, 'page', 1)",
      local.id,
      "Old: sk-abcdefghijklmnopqrstuvwxyz0123",
    )
    await a.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(out))
    for (const data of Object.values(entries))
      expect(Buffer.from(data).includes("sk-abcdefghijklmnopqrstuvwxyz0123")).toBe(false)
    const archived = join(testPlatform().dataDir, "handbook-archive.db")
    await Bun.write(archived, entries["robot.db"] as Uint8Array)
    const inArchive = new DatabaseSync(archived)
    expect(
      (
        inArchive.prepare("SELECT text FROM handbook_version ORDER BY created_at").all() as {
          text: string
        }[]
      ).map((r) => r.text),
    ).toEqual(["Old: [redacted]", "First text.", "Second text."])
    inArchive.close()

    // A fresh app restores the handbook with its history and the switch.
    const b = app({ open: out })
    await b.run(Data.use((d) => d.import()))
    const bLocal = await b.run(Servers.use((s) => s.local))
    expect(await b.run(Handbook.use((h) => h.get(bLocal.id)))).toMatchObject({
      serverId: bLocal.id,
      text: "Second text.",
    })
    expect(
      (await b.run(Handbook.use((h) => h.history(bLocal.id)))).map((v) => [v.text, v.source]),
    ).toEqual([
      ["Second text.", "device"],
      ["First text.", "page"],
      ["Old: [redacted]", "page"],
    ])
    const agents = await b.run(Agents.use((x) => x.list(bLocal.id, false)))
    expect(agents.map((x) => [x.name, x.readHandbook])).toEqual([["Ada", false]])
    // The history of the instructions of an agent comes back too (spec 002, 014).
    const bDb = await b.run(Database.use((d) => Effect.succeed(d)))
    expect(
      bDb
        .all<{ text: string }>("SELECT text FROM instruction_version ORDER BY created_at")
        .map((r) => r.text),
    ).toEqual(["One", "Two"])
  })
})
