import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SEARCH_CAP, SEARCH_PAGE, type SearchHit } from "@robot/shared"
import { Effect, Layer } from "effect"
import { tempDir } from "../test-temp.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Database, type DatabaseService, openDatabase } from "./Database.ts"
import { migrations } from "./migrations.ts"
import { Search } from "./Search.ts"
import { Servers } from "./Servers.ts"
import { managedRuntime, testRuntime } from "./testing.ts"

const text = (value: string) => JSON.stringify([{ kind: "text", text: value }])

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const db = await run(Database.use((d) => Effect.succeed(d)))
  let clock = 1_000
  const agent = (name: string) =>
    run(Agents.use((a) => a.create({ serverId: server.id, name, role: "", instructions: "" })))
  const channel = (name: string, memberIds: string[] = []) =>
    run(
      Channels.use((c) =>
        c.create({ serverId: server.id, name, topic: "", memberIds, leadId: null }),
      ),
    )
  /** A message of a direct chat. Time goes forward by itself. */
  const say = (
    agentId: string,
    body: string,
    options: { author?: "user" | "agent"; status?: string; at?: number; id?: string } = {},
  ) => {
    const id = options.id ?? `m${++clock}`
    db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      agentId,
      options.author ?? "user",
      text(body),
      options.status ?? "done",
      options.at ?? clock,
    )
    return id
  }
  const post = (
    channelId: string,
    body: string,
    options: { author?: "user" | "agent"; agentId?: string; at?: number } = {},
  ) => {
    const id = `c${++clock}`
    db.run(
      "INSERT INTO channel_message (id, channel_id, author, agent_id, parts, status, created_at) VALUES (?, ?, ?, ?, ?, 'done', ?)",
      id,
      channelId,
      options.author ?? "user",
      options.agentId ?? null,
      text(body),
      options.at ?? clock,
    )
    return id
  }
  const page = (query: string, offset = 0) =>
    run(Search.use((s) => s.page(server.id, query, offset)))
  const ids = async (query: string) => (await page(query)).hits.map((h) => h.messageId)
  const forAgent = (agentId: string, query: string) =>
    run(Search.use((s) => Effect.succeed(s.forAgent(agentId, query))))
  return { ...t, run, server, db, agent, channel, say, post, page, ids, forAgent }
}

describe("what a message must hold", () => {
  test("every word, as a part of a word, in any order and any case", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const hit = t.say(ada.id, "The budget is 4200 euros")
    t.say(ada.id, "The budget is final")
    t.say(ada.id, "Only euros here")
    expect(await t.ids("euros budget")).toEqual([hit])
    expect(await t.ids("BUDGET EUROS")).toEqual([hit])
    expect(await t.ids("bud")).toHaveLength(2)
    expect(await t.ids("4200")).toEqual([hit])
    expect(await t.ids("dget uros")).toEqual([hit])
    expect(await t.ids("euros dollars")).toEqual([])
  })

  test("the last word matches while it is typed", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const hit = t.say(ada.id, "The budget is 4200 euros")
    expect(await t.ids("euros b")).toEqual([hit])
    expect(await t.ids("euros bu")).toEqual([hit])
    expect(await t.ids("euros budgets")).toEqual([])
  })

  test("letters with accents and other scripts fold the same way", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const cafe = t.say(ada.id, "Le CAFÉ est ouvert")
    const korean = t.say(ada.id, "올해 예산은 4200유로입니다")
    expect(await t.ids("café")).toEqual([cafe])
    expect(await t.ids("ÉCOLE café")).toEqual([])
    expect(await t.ids("예산 유로")).toEqual([korean])
    expect(await t.ids("예산")).toEqual([korean])
  })

  test("a text of fewer than 2 characters finds nothing; 2 characters search", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const hit = t.say(ada.id, "ok then, go ahead")
    t.say(ada.id, "nothing here")
    expect((await t.page("o")).hits).toEqual([])
    expect((await t.page("   ")).hits).toEqual([])
    expect(await t.ids("ok")).toEqual([hit])
    expect(await t.ids("OK go")).toEqual([hit])
  })

  test("a short word and a long word together", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const both = t.say(ada.id, "go to the budget meeting")
    t.say(ada.id, "the budget meeting is over")
    t.say(ada.id, "go home")
    expect(await t.ids("go budget")).toEqual([both])
    expect(await t.ids("budget go")).toEqual([both])
    expect(await t.ids("e budget")).toHaveLength(2)
  })

  test("only the first 6 words count", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const hit = t.say(ada.id, "one two three four five six")
    expect(await t.ids("one two three four five six seven eight")).toEqual([hit])
    // The sixth word still counts.
    expect(await t.ids("one two three four five missing seven")).toEqual([])
  })

  test("a quote, a percent sign and a star in the text are plain characters", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const hit = t.say(ada.id, 'He said "stop" at 100% of the *rate*')
    expect(await t.ids('"stop"')).toEqual([hit])
    expect(await t.ids("100% *rate*")).toEqual([hit])
    expect(await t.ids("NEAR(stop")).toEqual([])
    expect(await t.ids("stop OR zzz")).toEqual([])
    expect(await t.ids("stop AND rate")).toEqual([])
  })

  test("markup in a message stays plain text in the hit", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.say(ada.id, "Send <b>bold</b> text")
    const hit = (await t.page("bold")).hits[0] as SearchHit
    expect(hit.snippet).toBe("Send <b>bold</b> text")
    expect(hit.snippet.slice(hit.marks[0]?.[0], hit.marks[0]?.[1])).toBe("bold")
    expect(hit.marks).toHaveLength(1)
  })
})

describe("what the search covers", () => {
  test("messages of the user and of agents, in chats and in channels", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const room = await t.channel("launch", [ada.id])
    const a = t.say(ada.id, "falcon from the user", { author: "user" })
    const b = t.say(ada.id, "falcon from the agent", { author: "agent" })
    const c = t.post(room.id, "falcon in the channel", { author: "user" })
    const d = t.post(room.id, "falcon from a member", { author: "agent", agentId: ada.id })
    const found = (await t.page("falcon")).hits
    expect(found.map((h) => h.messageId).sort()).toEqual([a, b, c, d].sort())
    const byId = new Map(found.map((h) => [h.messageId, h]))
    expect(byId.get(a)).toMatchObject({ kind: "agent", placeName: "Ada", author: "user" })
    expect(byId.get(b)).toMatchObject({ kind: "agent", placeName: "Ada", author: "agent" })
    expect(byId.get(c)).toMatchObject({ kind: "channel", placeName: "launch", author: "user" })
    expect(byId.get(d)).toMatchObject({ kind: "channel", placeName: "launch", author: "agent" })
    expect(byId.get(a)?.placeId).toBe(ada.id)
    expect(byId.get(c)?.placeId).toBe(room.id)
  })

  test("not tool cards, thinking, files, or a reply that still streams", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('p1', ?, 'agent', ?, 'done', 5)",
      ada.id,
      JSON.stringify([
        { kind: "thinking", text: "secretthought" },
        {
          kind: "tool",
          id: "t",
          name: "run_command",
          label: "toollabel",
          state: "done",
          input: "toolinput",
          output: "tooloutput",
        },
        { kind: "file", name: "filename.txt", path: "attachments/filename.txt", size: 3 },
        { kind: "text", text: "the visible answer" },
      ]),
    )
    const streaming = t.say(ada.id, "streamingtext", { author: "agent", status: "streaming" })
    for (const word of ["secretthought", "toollabel", "toolinput", "tooloutput", "filename"]) {
      expect(await t.ids(word)).toEqual([])
    }
    expect(await t.ids("visible answer")).toEqual(["p1"])
    expect(await t.ids("streamingtext")).toEqual([])
    // The reply ends: it can be found.
    t.db.run("UPDATE message SET status = 'done' WHERE id = ?", streaming)
    expect(await t.ids("streamingtext")).toEqual([streaming])
  })

  test("parts of one message join in order", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('p1', ?, 'agent', ?, 'done', 5)",
      ada.id,
      JSON.stringify([
        { kind: "text", text: "first part " },
        { kind: "thinking", text: "hidden" },
        { kind: "text", text: "second part" },
      ]),
    )
    expect((await t.page("first second")).hits[0]?.snippet).toBe("first part second part")
  })

  test("a stopped or failed reply keeps its text in the search", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const a = t.say(ada.id, "partial answer one", { author: "agent", status: "stopped" })
    const b = t.say(ada.id, "partial answer two", { author: "agent", status: "failed" })
    expect((await t.ids("partial")).sort()).toEqual([a, b].sort())
  })

  test("an edit changes what the message matches; a delete removes it", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const id = t.say(ada.id, "before the edit")
    expect(await t.ids("before")).toEqual([id])
    t.db.run("UPDATE message SET parts = ? WHERE id = ?", text("after the edit"), id)
    expect(await t.ids("before")).toEqual([])
    expect(await t.ids("after")).toEqual([id])
    t.db.run("DELETE FROM message WHERE id = ?", id)
    expect(await t.ids("after")).toEqual([])
  })

  test("a message that is written again leaves one entry, not two", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const id = t.say(ada.id, "same message")
    t.db.run("DELETE FROM message_text")
    t.db.run("INSERT INTO message_fts (message_fts) VALUES ('rebuild')")
    // The row is replaced: SQLite fires no delete trigger for the old row.
    t.db.run(
      "INSERT OR REPLACE INTO message (id, agent_id, author, parts, status, created_at) VALUES (?, ?, 'user', ?, 'done', 9)",
      id,
      ada.id,
      text("same message again"),
    )
    expect(await t.ids("same")).toEqual([id])
    expect(t.db.get("SELECT COUNT(*) AS n FROM message_text")).toEqual({ n: 1 })
  })

  test("deleting an agent or a channel deletes its messages from the search", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const room = await t.channel("launch")
    t.say(ada.id, "gone with the agent")
    t.post(room.id, "gone with the channel")
    expect(await t.ids("gone")).toHaveLength(2)
    t.db.run("DELETE FROM channel WHERE id = ?", room.id)
    expect(await t.ids("gone")).toHaveLength(1)
    t.db.run("DELETE FROM agent WHERE id = ?", ada.id)
    expect(await t.ids("gone")).toEqual([])
    expect(t.db.get("SELECT COUNT(*) AS n FROM message_text")).toEqual({ n: 0 })
    expect(t.db.all("SELECT rowid FROM message_fts WHERE message_fts MATCH '\"gon\"'")).toEqual([])
  })

  test("the chats of an archived agent are skipped, and they match again after a restore", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const bo = await t.agent("Bo")
    const mine = t.say(ada.id, "shared word")
    const other = t.say(bo.id, "shared word")
    expect((await t.ids("shared")).sort()).toEqual([mine, other].sort())
    await t.run(Agents.use((a) => a.archive(ada.id)))
    expect(await t.ids("shared")).toEqual([other])
    // A word of 2 characters takes the other way through the data. It skips the chat as well.
    expect(await t.ids("sh")).toEqual([other])
    await t.run(Agents.use((a) => a.restore(ada.id)))
    expect((await t.ids("shared")).sort()).toEqual([mine, other].sort())
  })

  test("another server holds other messages", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.say(ada.id, "local message")
    expect((await t.run(Search.use((s) => s.page("another-server", "local", 0)))).hits).toEqual([])
  })
})

describe("the order and the pages", () => {
  test("newest first", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const room = await t.channel("launch")
    const first = t.say(ada.id, "topic one", { at: 100 })
    const third = t.post(room.id, "topic three", { at: 300 })
    const second = t.say(ada.id, "topic two", { at: 200 })
    expect(await t.ids("topic")).toEqual([third, second, first])
    // The same order for a word that the index does not hold.
    expect(await t.ids("to")).toEqual([third, second, first])
  })

  test("hits come 20 at a time", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.db.transaction(() => {
      for (let i = 0; i < 45; i++) t.say(ada.id, `needle ${i}`, { at: 1000 + i })
    })
    const first = await t.page("needle")
    expect(first.hits).toHaveLength(SEARCH_PAGE)
    expect(first.more).toBe(true)
    expect(first.capped).toBe(false)
    expect(first.hits[0]?.snippet).toBe("needle 44")
    const second = await t.page("needle", 20)
    expect(second.hits[0]?.snippet).toBe("needle 24")
    expect(second.more).toBe(true)
    const third = await t.page("needle", 40)
    expect(third.hits.map((h) => h.snippet)).toEqual([
      "needle 4",
      "needle 3",
      "needle 2",
      "needle 1",
      "needle 0",
    ])
    expect(third.more).toBe(false)
  })

  test("at most 200 hits; more matches end the group with the request for more words", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.db.transaction(() => {
      for (let i = 0; i < 230; i++) t.say(ada.id, `needle ${i}`, { at: 1000 + i })
    })
    const all: SearchHit[] = []
    for (let offset = 0; offset < 400; offset += SEARCH_PAGE) {
      const next = await t.page("needle", offset)
      all.push(...next.hits)
      expect(next.capped).toBe(true)
      if (!next.more) break
    }
    expect(all).toHaveLength(SEARCH_CAP)
    expect(all[0]?.snippet).toBe("needle 229")
    expect(all.at(-1)?.snippet).toBe("needle 30")
    expect(new Set(all.map((h) => h.messageId)).size).toBe(SEARCH_CAP)
    expect((await t.page("needle", SEARCH_CAP)).hits).toEqual([])
    // A narrower text is not capped.
    const narrow = await t.page("needle 229")
    expect(narrow.hits).toHaveLength(1)
    expect(narrow.capped).toBe(false)
  })

  test("exactly 200 matches are not capped", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.db.transaction(() => {
      for (let i = 0; i < SEARCH_CAP; i++) t.say(ada.id, `needle ${i}`, { at: 1000 + i })
    })
    const last = await t.page("needle", SEARCH_CAP - SEARCH_PAGE)
    expect(last.hits).toHaveLength(SEARCH_PAGE)
    expect(last.more).toBe(false)
    expect(last.capped).toBe(false)
  })

  test("a word of 2 characters pages through more rows than one read holds", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.db.transaction(() => {
      for (let i = 0; i < 1300; i++)
        t.say(ada.id, i % 100 === 0 ? `zq mark ${i}` : `filler ${i}`, { at: 1000 + i })
    })
    const first = await t.page("zq")
    // 13 messages hold the word; they lie in three steps of 500 rows.
    expect(first.hits).toHaveLength(13)
    expect(first.hits[0]?.snippet).toBe("zq mark 1200")
    expect(first.hits.at(-1)?.snippet).toBe("zq mark 0")
    expect(first.more).toBe(false)
  })
})

describe("a hit", () => {
  test("it names the place, the time and a piece around the first matching word", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const long = `${"lorem ipsum ".repeat(40)}the budget is 4200 euros ${"dolor sit ".repeat(40)}`
    t.say(ada.id, long, { at: 4242 })
    const hit = (await t.page("euros budget")).hits[0] as SearchHit
    expect(hit.createdAt).toBe(4242)
    expect(hit.snippet.length).toBeLessThanOrEqual(120)
    expect(hit.snippet.startsWith("…")).toBe(true)
    expect(hit.snippet.endsWith("…")).toBe(true)
    expect(hit.marks.map(([a, b]) => hit.snippet.slice(a, b))).toEqual(["budget", "euros"])
  })
})

describe("the tool for an agent", () => {
  test("it reads the chats and the channels of the agent, and no other place", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const bo = await t.agent("Bo")
    const withAda = await t.channel("with-ada", [ada.id, bo.id])
    const withoutAda = await t.channel("without-ada", [bo.id])
    t.say(ada.id, "the code name is Falcon")
    t.say(bo.id, "Bo knows Osprey")
    t.post(withAda.id, "shared Heron note")
    t.post(withoutAda.id, "private Kestrel note")

    const falcon = await t.forAgent(ada.id, "falcon")
    expect(falcon.failed).toBe(false)
    expect(falcon.output).toContain("Falcon")
    expect(falcon.output).toContain("chat with Ada")
    expect((await t.forAgent(ada.id, "heron")).output).toContain("channel #with-ada")
    // No part in the place, no hit.
    expect((await t.forAgent(ada.id, "osprey")).output).toContain("No past message matches")
    expect((await t.forAgent(ada.id, "kestrel")).output).toContain("No past message matches")
    expect((await t.forAgent(bo.id, "kestrel")).output).toContain("Kestrel")
  })

  test("it gives 10 hits at most, newest first, with pieces of 300 characters at most", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    t.db.transaction(() => {
      for (let i = 0; i < 25; i++)
        t.say(ada.id, `needle ${i} ${"padding ".repeat(80)}`, { at: 1000 + i })
    })
    const { output } = await t.forAgent(ada.id, "needle")
    expect(output).toContain("Found 10 past messages")
    expect(output).toContain("needle 24")
    expect(output).toContain("needle 15")
    expect(output).not.toContain("needle 14 ")
    const quotes = [...output.matchAll(/written by [^:]+: "(.*)"$/gm)].map((m) => m[1] ?? "")
    expect(quotes).toHaveLength(10)
    for (const quote of quotes) expect(quote.length).toBeLessThanOrEqual(300)
    expect(quotes.join("").length).toBeLessThanOrEqual(4000)
  })

  test("it names who wrote a hit, and skips an archived chat", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    const room = await t.channel("launch", [ada.id])
    t.say(ada.id, "needle from the user", { author: "user" })
    t.say(ada.id, "needle from the agent", { author: "agent" })
    t.post(room.id, "needle from a member", { author: "agent", agentId: ada.id })
    const { output } = await t.forAgent(ada.id, "needle")
    expect(output).toContain('written by the user: "needle from the user"')
    expect(output).toContain('written by Ada: "needle from the agent"')
    expect(output).toContain("channel #launch")
    expect(output).toContain('written by Ada: "needle from a member"')
    await t.run(Agents.use((a) => a.archive(ada.id)))
    const after = (await t.forAgent(ada.id, "needle")).output
    expect(after).not.toContain("chat with Ada")
    expect(after).toContain("channel #launch")
  })

  test("a text that is too short is a failed call", async () => {
    const t = await setup()
    const ada = await t.agent("Ada")
    expect((await t.forAgent(ada.id, "a")).failed).toBe(true)
    expect((await t.forAgent(ada.id, "")).failed).toBe(true)
  })
})

describe("the speed", () => {
  const WORDS =
    "alpha beta gamma delta budget euros project falcon summary release meeting notes review plan design test deploy server client token update change report quality simple complex margin invoice travel hotel flight".split(
      " ",
    )
  const sentence = (i: number) => {
    let x = (i * 2654435761) % 4294967296
    const out: string[] = []
    for (let k = 0; k < 40; k++) {
      x = (x * 1103515245 + 12345) % 2147483648
      out.push(WORDS[x % WORDS.length] as string)
    }
    return `${out.join(" ")} n${i}`
  }

  test("the first 20 hits come within 1 second when the server holds 50,000 messages", async () => {
    // The database is made up to the step before the search, filled with plain inserts, and then
    // opened the way the app opens it: the step of the search runs on all the messages.
    const at = migrations.findIndex((sql) => sql.includes("CREATE VIRTUAL TABLE message_fts"))
    expect(at).toBeGreaterThan(0)
    const file = join(tempDir("robot-search-"), "robot.db")
    const raw = new DatabaseSync(file)
    raw.exec("PRAGMA foreign_keys = ON")
    for (const sql of migrations.slice(0, at)) raw.exec(sql)
    raw.exec(`PRAGMA user_version = ${at}`)
    raw.exec(
      "INSERT INTO server (id, name, kind, position, created_at) VALUES ('s','S','local',0,0)",
    )
    for (const id of ["a", "b"])
      raw.exec(`INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape,
        face_hue, workspace, section, created_at, updated_at)
        VALUES ('${id}','s','${id}','${id}','','',0,0,'/w','agents',0,0)`)
    const insert = raw.prepare(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES (?, ?, ?, ?, 'done', ?)",
    )
    raw.exec("BEGIN")
    for (let i = 0; i < 50_000; i++)
      insert.run(`m${i}`, i % 2 ? "a" : "b", i % 3 ? "user" : "agent", text(sentence(i)), i)
    raw.exec("COMMIT")
    raw.close()

    const db: DatabaseService = openDatabase(file)
    expect(db.get("SELECT COUNT(*) AS n FROM message_text")).toEqual({ n: 50_000 })
    const runtime = managedRuntime(Search.layer.pipe(Layer.provide(Layer.succeed(Database, db))))
    const search = (query: string, offset = 0) =>
      runtime.runPromise(Search.use((s) => s.page("s", query, offset)))
    await search("warm") // The first call loads the code.

    for (const query of ["budget euros", "alpha", "falcon deploy token", "n49999", "eu"]) {
      const started = performance.now()
      const result = await search(query)
      const took = performance.now() - started
      expect(result.hits.length).toBeGreaterThan(0)
      // A bound with room for a slow machine. The measured time is a few milliseconds.
      expect(took).toBeLessThan(1000)
      if (query === "budget euros") expect(result.hits).toHaveLength(SEARCH_PAGE)
    }
    // A word that is rare and short makes the app read the rows. It still ends in good time.
    const started = performance.now()
    await search("n4")
    expect(performance.now() - started).toBeLessThan(3000)
    await runtime.dispose()
  }, 60_000)
})
