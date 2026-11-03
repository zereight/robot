import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { checkStateText } from "@robot/shared"
import { migrate } from "../src/main/services/Database.ts"
import { migrations } from "../src/main/services/migrations.ts"
import {
  checkOutPath,
  type ExportOptions,
  exportItems,
  ItemsError,
  itemsToJsonl,
  type JudgeItem,
  openCopy,
  readCli,
  repositoryRoots,
  summaryText,
  writeItems,
} from "./judge-items-lib.ts"
import { callsFor, parseItems } from "./judge-replay-lib.ts"

// All data here is made for the tests, on the real schema of the app: the database is made with the
// real migrations, and the rows are written with plain SQL, so a change of the schema breaks a
// test. The words LBL, DONE, REPLY, MSG and SECRET mark text that a printed line must never hold.

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-items-"))
  dirs.push(dir)
  return dir
}

const BASE = Date.parse("2026-10-01T00:00:00Z")
/** A moment, as milliseconds after the start of the made data. */
const at = (ms: number) => BASE + ms

const text = (value: string) => JSON.stringify([{ kind: "text", text: value }])
/** The name of a made task without its marker: the texts of a part use it, so no text holds the id. */
const short = (id: string) => id.replace(/^TASKID-/, "")

interface PartInput {
  readonly id: string
  readonly job: string
  readonly channel: string
  readonly agent: string
  readonly label: string
  readonly doneTest?: string | null
  readonly state?: string
  readonly created: number
  readonly finished?: number | null
  readonly verdict?: "met" | "not_met"
  readonly reason?: string
  readonly judged?: number
  readonly decided?: number
  readonly decisionText?: string
}

interface MessageInput {
  readonly id: string
  readonly channel: string
  readonly author?: "user" | "agent"
  readonly agent?: string | null
  readonly parts: string
  readonly status?: string
  readonly at: number
  readonly task?: string | null
}

/** A database made with the real migrations, with helpers that write rows with plain SQL. */
const world = (file = join(tempDir(), "copy.db")) => {
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params)
  run(
    "INSERT INTO server (id, name, kind, position, created_at) VALUES ('srv', 'S', 'local', 0, 1)",
  )
  const made = {
    file,
    db,
    agent: (id: string, name: string, role: string) =>
      run(
        `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
           workspace, section, created_at, updated_at)
         VALUES (?, 'srv', ?, ?, ?, '', 0, 0, 'w', 's', 1, 1)`,
        id,
        name,
        name.toLowerCase(),
        role,
      ),
    channel: (id: string, name: string, topic: string, members: string[], lead: string) => {
      run(
        `INSERT INTO channel (id, server_id, name, name_key, topic, lead_agent_id, created_at, updated_at)
         VALUES (?, 'srv', ?, ?, ?, ?, 1, 1)`,
        id,
        name,
        name.toLowerCase(),
        topic,
        lead,
      )
      for (const [position, agent] of members.entries())
        run(
          "INSERT INTO channel_member (channel_id, agent_id, position) VALUES (?, ?, ?)",
          id,
          agent,
          position,
        )
    },
    job: (id: string, channel: string, lead: string, created: number) =>
      run(
        `INSERT INTO task (id, agent_id, prompt, label, source, source_id, state, created_at, finished_at)
         VALUES (?, ?, 'job', 'job', 'channel', ?, 'done', ?, ?)`,
        id,
        lead,
        channel,
        created,
        created + 1,
      ),
    part: (p: PartInput) =>
      run(
        `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, state, created_at,
           finished_at, done_test, verdict, verdict_reason, judged_at, decided_at, decision,
           decision_text)
         VALUES (?, ?, 'prompt', ?, 'channel', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id,
        p.agent,
        p.label,
        p.channel,
        p.job,
        p.state ?? "done",
        p.created,
        p.finished === undefined ? p.created + 10 : p.finished,
        p.doneTest === undefined ? `DONE-${short(p.id)}` : p.doneTest,
        p.verdict ?? null,
        p.reason ?? null,
        p.judged ?? null,
        p.decided ?? null,
        p.decided === undefined ? null : "changes",
        p.decisionText ?? null,
      ),
    message: (m: MessageInput) =>
      run(
        `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, task_id,
           created_at, finished_at)
         VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, ?)`,
        m.id,
        m.channel,
        m.author ?? "agent",
        m.agent === undefined ? null : m.agent,
        m.parts,
        m.status ?? "done",
        m.task ?? null,
        m.at,
        m.at,
      ),
    close: () => db.close(),
  }
  return made
}

/** The base world: a channel "Launch" with Lia (lead), Bo and Cy, and a channel "Docs" with no topic. */
const base = () => {
  const w = world()
  w.agent("AGENTID-lia", "Lia", "Leads the launch")
  w.agent("AGENTID-bo", "Bo", "Writes text")
  w.agent("AGENTID-cy", "Cy", "Checks facts")
  w.channel(
    "CHANNELID-launch",
    "Launch",
    "Ship the launch",
    ["AGENTID-lia", "AGENTID-bo", "AGENTID-cy"],
    "AGENTID-lia",
  )
  w.channel("CHANNELID-docs", "Docs", "", ["AGENTID-lia", "AGENTID-bo"], "AGENTID-lia")
  return w
}

const LAUNCH = "CHANNELID-launch"
const DOCS = "CHANNELID-docs"

const partOf = (
  w: ReturnType<typeof base>,
  id: string,
  job: string,
  extra: Partial<PartInput> & { created: number; reply?: string | null },
) => {
  const { reply, ...rest } = extra
  const channel = rest.channel ?? LAUNCH
  w.part({
    id,
    job,
    channel,
    agent: rest.agent ?? "AGENTID-bo",
    label: `LBL-${short(id)}`,
    ...rest,
  })
  if (reply !== null)
    w.message({
      id: `MSGID-${id}`,
      channel,
      agent: rest.agent ?? "AGENTID-bo",
      parts: text(reply ?? `REPLY-${short(id)}`),
      at: rest.created + 5,
      task: id,
    })
}

const run = (file: string, options: ExportOptions = { since: null, limit: null }) =>
  exportItems(file, options)

const fileState = (file: string) => {
  const info = statSync(file)
  return { bytes: readFileSync(file), mtimeMs: info.mtimeMs, size: info.size }
}

// ---------------------------------------------------------------------------- what is chosen

describe("the parts that are chosen", () => {
  test("two jobs with several parts: one item for each finished part that has a done test", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    w.job("JOBID-2", DOCS, "AGENTID-lia", at(200))
    partOf(w, "TASKID-a1", "JOBID-1", { created: at(1000), agent: "AGENTID-bo" })
    partOf(w, "TASKID-a2", "JOBID-1", { created: at(1100), agent: "AGENTID-cy" })
    partOf(w, "TASKID-b1", "JOBID-2", { created: at(1050), channel: DOCS })
    partOf(w, "TASKID-b2", "JOBID-2", { created: at(1200), channel: DOCS })
    partOf(w, "TASKID-a3", "JOBID-1", { created: at(1300), agent: "AGENTID-bo" })
    w.close()

    const { items, summary } = run(w.file)
    // The order is the order of time, whatever the job.
    expect(items.map((i) => i.label)).toEqual(["LBL-a1", "LBL-b1", "LBL-a2", "LBL-b2", "LBL-a3"])
    expect(items.map((i) => i.id)).toEqual([
      "real-0001",
      "real-0002",
      "real-0003",
      "real-0004",
      "real-0005",
    ])
    // One group for each job: the same value for its parts, a different one for another job.
    expect(items.map((i) => i.group)).toEqual([
      "job-0001",
      "job-0002",
      "job-0001",
      "job-0002",
      "job-0001",
    ])
    expect(summary).toMatchObject({ found: 5, written: 5, jobs: 2, overLimit: 0, beforeSince: 0 })
    const [first, second, third] = items as [JudgeItem, JudgeItem, JudgeItem]
    expect(first).toMatchObject({
      tag: "real",
      doneTest: "DONE-a1",
      reply: "REPLY-a1",
      member: "Bo",
      channel: "Launch",
      topic: "Ship the launch",
    })
    expect(third.member).toBe("Cy")
    expect(first.members).toEqual([
      { name: "Lia", role: "Leads the launch" },
      { name: "Bo", role: "Writes text" },
      { name: "Cy", role: "Checks facts" },
    ])
    // A channel with no topic has no "topic" field. The fields are these and no other.
    expect(second.channel).toBe("Docs")
    expect("topic" in second).toBe(false)
    expect(Object.keys(first).sort()).toEqual([
      "channel",
      "doneTest",
      "group",
      "id",
      "label",
      "member",
      "members",
      "messages",
      "reply",
      "tag",
      "topic",
    ])
  })

  test("a part with no done test, a part that is not done and a part with no reply are skipped and counted", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-ok", "JOBID-1", { created: at(1000) })
    partOf(w, "TASKID-null", "JOBID-1", { created: at(1010), doneTest: null })
    partOf(w, "TASKID-blank", "JOBID-1", { created: at(1020), doneTest: "   " })
    for (const [i, state] of ["failed", "blocked", "cancelled", "review", "running"].entries())
      partOf(w, `TASKID-${state}`, "JOBID-1", { created: at(1030 + i), state })
    partOf(w, "TASKID-noreply", "JOBID-1", { created: at(1100), reply: null })
    partOf(w, "TASKID-blankreply", "JOBID-1", { created: at(1110), reply: "  \n " })
    // A reply with a tool part only has no text.
    partOf(w, "TASKID-toolonly", "JOBID-1", {
      created: at(1120),
      reply: null,
    })
    w.message({
      id: "MSGID-tool",
      channel: LAUNCH,
      agent: "AGENTID-bo",
      parts: JSON.stringify([{ kind: "tool", name: "x" }]),
      at: at(1125),
      task: "TASKID-toolonly",
    })
    w.close()

    const { items, summary } = run(w.file)
    expect(items.map((i) => i.label)).toEqual(["LBL-ok"])
    expect(summary).toMatchObject({
      found: 11,
      written: 1,
      notDone: 5,
      noDoneTest: 2,
      noReply: 3,
      unreadable: 0,
    })
    const printed = summaryText(summary)
    expect(printed).toContain("Items written: 1, from 1 job")
    expect(printed).toContain("not done: 5")
    expect(printed).toContain("no done test: 2")
    expect(printed).toContain("no reply text: 3")
    expect(printed).not.toMatch(/LBL|DONE|REPLY|TASKID/)
  })

  test("a part of the user chat or a task with no parent job is not a part of a channel job", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-ok", "JOBID-1", { created: at(1000) })
    // A task of a chat (source "chat") and a task of a channel with no parent (a job) are not parts.
    w.db
      .prepare(
        `INSERT INTO task (id, agent_id, prompt, label, source, source_id, parent_id, state, created_at, done_test)
         VALUES ('TASKID-chat', 'AGENTID-bo', 'p', 'LBL-chat', 'chat', NULL, 'JOBID-1', 'done', ?, 'DONE-chat')`,
      )
      .run(at(1500))
    w.db
      .prepare(
        `INSERT INTO task (id, agent_id, prompt, label, source, source_id, state, created_at, done_test)
         VALUES ('TASKID-single', 'AGENTID-bo', 'p', 'LBL-single', 'channel', ?, 'done', ?, 'DONE-single')`,
      )
      .run(LAUNCH, at(1600))
    w.close()
    const { items, summary } = run(w.file)
    expect(items.map((i) => i.label)).toEqual(["LBL-ok"])
    expect(summary.found).toBe(1)
  })

  test("--since keeps the parts made on that date or later, and --limit keeps the newest", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    const day = 24 * 60 * 60 * 1000
    for (const n of [0, 1, 2, 3, 4])
      partOf(w, `TASKID-d${n}`, "JOBID-1", { created: at(n * day + 1000) })
    w.close()
    const since = at(2 * day)
    const all = run(w.file, { since, limit: null })
    expect(all.items.map((i) => i.label)).toEqual(["LBL-d2", "LBL-d3", "LBL-d4"])
    expect(all.summary).toMatchObject({ found: 5, beforeSince: 2, written: 3 })
    const limited = run(w.file, { since, limit: 2 })
    // The newest two. The ids start again at 1.
    expect(limited.items.map((i) => [i.id, i.label])).toEqual([
      ["real-0001", "LBL-d3"],
      ["real-0002", "LBL-d4"],
    ])
    expect(limited.summary).toMatchObject({ written: 2, overLimit: 1, beforeSince: 2 })
  })
})

// ------------------------------------------------------------------- what is never written

describe("what an item never holds", () => {
  test("the verdict, its reason and the decision of the user are not in the output", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-x1", "JOBID-1", {
      created: at(1000),
      verdict: "met",
      judged: at(5000),
    })
    partOf(w, "TASKID-x2", "JOBID-1", {
      created: at(1100),
      verdict: "not_met",
      reason: "SECRET-REASON of the verdict",
      judged: at(5000),
    })
    partOf(w, "TASKID-x3", "JOBID-1", {
      created: at(1200),
      decided: at(6000),
      decisionText: "SECRET-DECISION text of the user",
    })
    w.close()
    const { items } = run(w.file)
    expect(items).toHaveLength(3)
    const out = itemsToJsonl(items)
    expect(out).not.toContain("SECRET")
    expect(out).not.toMatch(/not_met|verdict|decision|decided|"human"/i)
    for (const item of items)
      for (const name of [
        "verdict",
        "verdictReason",
        "decision",
        "decisionText",
        "human",
        "judgedAt",
      ])
        expect(name in item).toBe(false)
  })

  test("the ids hold neither a task id nor a job id, and the group is no task id", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    w.job("JOBID-2", LAUNCH, "AGENTID-lia", at(200))
    partOf(w, "TASKID-one", "JOBID-1", { created: at(1000) })
    partOf(w, "TASKID-two", "JOBID-2", { created: at(1100) })
    w.close()
    const { items } = run(w.file)
    for (const item of items) {
      expect(item.id).toMatch(/^real-\d{4}$/)
      expect(item.group).toMatch(/^job-\d{4}$/)
    }
    const out = itemsToJsonl(items)
    expect(out).not.toMatch(/TASKID|JOBID|AGENTID|CHANNELID|MSGID/)
  })

  test("a reply of more than 1500 characters is written in full, and the newest reply of the part wins", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    const long = `START-${"x".repeat(2300)}-END`
    partOf(w, "TASKID-long", "JOBID-1", { created: at(1000), reply: long })
    // An older reply of the same part, and a reply of several text parts with a tool part between.
    w.message({
      id: "MSGID-older",
      channel: LAUNCH,
      agent: "AGENTID-bo",
      parts: text("OLDER reply"),
      at: at(1002),
      task: "TASKID-long",
    })
    partOf(w, "TASKID-many", "JOBID-1", { created: at(1100), reply: null })
    w.message({
      id: "MSGID-many",
      channel: LAUNCH,
      agent: "AGENTID-bo",
      parts: JSON.stringify([
        { kind: "text", text: "First. " },
        { kind: "tool", name: "t" },
        { kind: "text", text: "Second." },
      ]),
      at: at(1110),
      task: "TASKID-many",
    })
    w.close()
    const { items } = run(w.file)
    expect(items[0]?.reply).toBe(long)
    expect([...(items[0]?.reply ?? "")]).toHaveLength([...long].length)
    expect(items[1]?.reply).toBe("First. Second.")
    // The line of the file holds the whole reply too.
    expect(itemsToJsonl(items)).toContain(long)
  })
})

// -------------------------------------------------------------------------------- messages

describe("the messages of the channel", () => {
  const put = (
    w: ReturnType<typeof base>,
    id: string,
    when: number,
    options: {
      readonly author?: "user" | "agent"
      readonly agent?: string | null
      readonly status?: string
    } = {},
  ) =>
    w.message({
      id: `MSGID-${id}`,
      channel: LAUNCH,
      author: options.author ?? "agent",
      agent: options.agent === undefined ? "AGENTID-bo" : options.agent,
      parts: text(`MSG-${id}`),
      ...(options.status === undefined ? {} : { status: options.status }),
      at: at(when),
    })

  test("more than 12 messages: the last 12 before the verdict, oldest first", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(10))
    for (let n = 1; n <= 15; n++) put(w, String(n).padStart(2, "0"), n * 100)
    // The verdict came after message 13 (at 1300) and before message 14 (at 1400). The reply of
    // the part (made at 25) is the oldest message of all: it is one of the 14 before the verdict.
    partOf(w, "TASKID-p", "JOBID-1", { created: at(20), verdict: "met", judged: at(1350) })
    w.close()
    const { items } = run(w.file)
    expect(items[0]?.messages.map((m) => m.text)).toEqual([
      "MSG-02",
      "MSG-03",
      "MSG-04",
      "MSG-05",
      "MSG-06",
      "MSG-07",
      "MSG-08",
      "MSG-09",
      "MSG-10",
      "MSG-11",
      "MSG-12",
      "MSG-13",
    ])
  })

  test("a message after the verdict is left out, and a message between the end of the part and the verdict stays", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(10))
    put(w, "before", 500, { author: "user", agent: null })
    put(w, "same-moment", 2000)
    put(w, "after", 2500)
    put(w, "between", 1500)
    // The part ended at 1000 and was judged at 2000.
    partOf(w, "TASKID-p", "JOBID-1", {
      created: at(100),
      finished: at(1000),
      verdict: "not_met",
      reason: "SECRET",
      judged: at(2000),
    })
    w.close()
    const { items } = run(w.file)
    // A message made at the moment of the verdict is not older than it.
    expect(items[0]?.messages.map((m) => m.text)).toEqual(["REPLY-p", "MSG-before", "MSG-between"])
  })

  test("a part with no verdict sees the messages older than the end of the last part of its job", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(10))
    put(w, "1", 500, { author: "user", agent: null })
    // The first part ended at 1000, and the last part of the job ended at 3000.
    partOf(w, "TASKID-first", "JOBID-1", { created: at(100), finished: at(1000) })
    partOf(w, "TASKID-last", "JOBID-1", { created: at(200), finished: at(3000) })
    put(w, "2", 2500)
    put(w, "3", 3500)
    w.close()
    const { items } = run(w.file)
    expect(items).toHaveLength(2)
    // Both parts have no verdict: they see the same messages, up to the end of the last part.
    for (const item of items)
      expect(item.messages.map((m) => m.text)).toEqual([
        "REPLY-first",
        "REPLY-last",
        "MSG-1",
        "MSG-2",
      ])
  })

  test("only messages that are done or stopped are listed, named as the check text names them", () => {
    const w = base()
    w.agent("AGENTID-gone", "Gone", "Left the channel")
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(10))
    put(w, "a", 100, { author: "user", agent: null })
    put(w, "b", 200, { status: "stopped" })
    put(w, "c", 300, { status: "streaming" })
    put(w, "d", 400, { status: "error" })
    // An agent that is not a member of the channel, and a message with no agent, are named "Agent".
    put(w, "e", 500, { agent: "AGENTID-gone" })
    put(w, "f", 600, { agent: null })
    put(w, "g", 700, { agent: "AGENTID-lia" })
    // A message whose saved parts cannot be read is listed with no text.
    w.message({ id: "MSGID-bad", channel: LAUNCH, parts: "not json", at: at(800) })
    partOf(w, "TASKID-p", "JOBID-1", { created: at(50), judged: at(900), verdict: "met" })
    w.close()
    expect(run(w.file).items[0]?.messages).toEqual([
      { who: "Bo", text: "REPLY-p" },
      { who: "User", text: "MSG-a" },
      { who: "Bo", text: "MSG-b" },
      { who: "Agent", text: "MSG-e" },
      { who: "Agent", text: "MSG-f" },
      { who: "Lia", text: "MSG-g" },
      { who: "Agent", text: "" },
    ])
  })
})

// ---------------------------------------------------------------------------- the database

describe("the database", () => {
  const sample = () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-one", "JOBID-1", { created: at(1000), verdict: "met", judged: at(5000) })
    partOf(w, "TASKID-two", "JOBID-1", { created: at(1100) })
    return w
  }

  test("a database from an older version names the columns it lacks, with no stack trace", () => {
    // The database of the version before the done test and the verdict were added.
    const index = migrations.findIndex((sql) => sql.includes("ADD COLUMN done_test"))
    expect(index).toBeGreaterThan(0)
    const file = join(tempDir(), "old.db")
    const db = new DatabaseSync(file)
    for (const sql of migrations.slice(0, index)) db.exec(sql)
    db.close()

    let error: unknown
    try {
      run(file)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ItemsError)
    const message = (error as Error).message
    expect(message).toContain("task.done_test")
    expect(message).toContain("task.judged_at")
    expect(message).toContain("older version")
    expect(message).not.toContain("\n    at ")
  })

  test("a file that is not a database, and a missing file, give a clear message", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "text.db"), "this is SECRET text and not a database ".repeat(200))
    for (const file of [join(dir, "text.db"), join(dir, "none.db")]) {
      let message = ""
      try {
        run(file)
      } catch (e) {
        expect(e).toBeInstanceOf(ItemsError)
        message = (e as Error).message
      }
      expect(message).toContain("--db")
      expect(message).not.toContain("SECRET")
      expect(message).not.toContain(dir)
    }
    // A folder is no database.
    expect(() => run(dir)).toThrow("--db")
  })

  test("the file of the database is not changed: same bytes, same time, no new file", () => {
    const w = sample()
    w.close()
    const old = new Date("2026-01-02T03:04:05Z")
    utimesSync(w.file, old, old)
    const before = fileState(w.file)
    const listing = readdirSync(join(w.file, ".."))
    const { items } = run(w.file)
    expect(items).toHaveLength(2)
    const after = fileState(w.file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0)
    expect(readdirSync(join(w.file, ".."))).toEqual(listing)
  })

  test("a copy with a -wal file next to it is read with that file, and its database file is not changed", () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-one", "JOBID-1", { created: at(1000) })
    // Part one is in the database file; part two lives in the -wal file only.
    w.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    partOf(w, "TASKID-two", "JOBID-1", { created: at(1100) })
    const dir = tempDir()
    const copy = join(dir, "copy.db")
    copyFileSync(w.file, copy)
    copyFileSync(`${w.file}-wal`, `${copy}-wal`)
    w.close()
    const old = new Date("2026-01-02T03:04:05Z")
    utimesSync(copy, old, old)
    const before = fileState(copy)
    const { items } = run(copy)
    expect(items.map((i) => i.label)).toEqual(["LBL-one", "LBL-two"])
    const after = fileState(copy)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0)
    // Without the -wal file the copy has only part one.
    const plain = join(tempDir(), "plain.db")
    copyFileSync(copy, plain)
    expect(run(plain).items.map((i) => i.label)).toEqual(["LBL-one"])
  })

  test("a path with a space and a symbol in it opens", () => {
    const w = sample()
    w.close()
    const dir = join(tempDir(), "a folder #1 100%")
    mkdirSync(dir)
    const copy = join(dir, "my copy?.db")
    copyFileSync(w.file, copy)
    expect(run(copy).items).toHaveLength(2)
  })

  test("a statement that would write fails on the copy", () => {
    const w = sample()
    w.close()
    for (const wal of [false, true]) {
      const copy = join(tempDir(), "copy.db")
      copyFileSync(w.file, copy)
      // With a -wal file next to it the copy is opened the other way: both ways refuse a write.
      if (wal) writeFileSync(`${copy}-wal`, "")
      const before = fileState(copy)
      let db: ReturnType<typeof openCopy> | undefined
      try {
        db = openCopy(copy)
        expect(() => db?.run("DELETE FROM task")).toThrow()
        expect(() => db?.run("CREATE TABLE x (a)")).toThrow()
      } finally {
        db?.close()
      }
      expect(Buffer.compare(fileState(copy).bytes, before.bytes)).toBe(0)
    }
  })
})

// ------------------------------------------------------------------------------- the output

describe("the output file", () => {
  const dbFile = () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-one", "JOBID-1", { created: at(1000) })
    w.close()
    return w.file
  }

  test("a path inside this repository is refused, also through .. and through a link", () => {
    const [root] = repositoryRoots() as [string]
    // A guard against a wrong root: the repository root holds the rules of the project.
    expect(existsSync(join(root, "CLEANROOM.md"))).toBe(true)
    const db = dbFile()
    const dir = tempDir()
    const inside = [
      join(root, "judge-items-must-not-exist.jsonl"),
      join(root, "apps", "no-such-folder", "x.jsonl"),
      // The steps up and down stay in the text: they are not cut by a join.
      `${dir}/${relative(dir, root)}/x.jsonl`,
      `${root}/apps/../x.jsonl`,
    ]
    symlinkSync(join(root, "apps"), join(dir, "link"))
    inside.push(join(dir, "link", "x.jsonl"))
    for (const out of inside) {
      let message = ""
      try {
        checkOutPath(out, db, true)
      } catch (e) {
        expect(e).toBeInstanceOf(ItemsError)
        message = (e as Error).message
      }
      expect(message).toContain("--out is inside this repository")
      expect(message).not.toContain(root)
    }
    expect(existsSync(join(root, "judge-items-must-not-exist.jsonl"))).toBe(false)
    expect(existsSync(join(root, "apps", "x.jsonl"))).toBe(false)
    // A place outside the repository is fine.
    expect(() => checkOutPath(join(dir, "ok.jsonl"), db, false)).not.toThrow()
  })

  test("a linked worktree names the main checkout as part of the repository too", () => {
    const dir = tempDir()
    const main = join(dir, "main")
    const tree = join(dir, "trees", "wt")
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true })
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`)
    expect(repositoryRoots(tree)).toEqual([tree, main])
    // A checkout with a ".git" folder names only itself.
    expect(repositoryRoots(main)).toEqual([main])
    const db = dbFile()
    expect(() => checkOutPath(join(main, "x.jsonl"), db, false, repositoryRoots(tree))).toThrow(
      "--out is inside this repository",
    )
    expect(() => checkOutPath(join(dir, "x.jsonl"), db, false, repositoryRoots(tree))).not.toThrow()
  })

  test("an existing file is refused, and --force replaces it", () => {
    const db = dbFile()
    const { items } = run(db)
    const out = join(tempDir(), "items.jsonl")
    writeFileSync(out, "OLD CONTENT")
    expect(() => checkOutPath(out, db, false)).toThrow("exists")
    expect(() => writeItems(out, itemsToJsonl(items), false)).toThrow("exists")
    expect(readFileSync(out, "utf8")).toBe("OLD CONTENT")
    // With --force the check passes and the file is replaced.
    expect(() => checkOutPath(out, db, true)).not.toThrow()
    writeItems(out, itemsToJsonl(items), true)
    expect(readFileSync(out, "utf8")).toBe(itemsToJsonl(items))
  })

  test("the file has mode 0600, also when an older file was wider and was replaced", () => {
    const db = dbFile()
    const { items } = run(db)
    const dir = tempDir()
    const fresh = join(dir, "fresh.jsonl")
    writeItems(fresh, itemsToJsonl(items), false)
    expect(statSync(fresh).mode & 0o777).toBe(0o600)
    const old = join(dir, "old.jsonl")
    writeFileSync(old, "x")
    chmodSync(old, 0o644)
    writeItems(old, itemsToJsonl(items), true)
    expect(statSync(old).mode & 0o777).toBe(0o600)
  })

  test("the file has mode 0600 also when the umask of the process is stricter", () => {
    const db = dbFile()
    const { items } = run(db)
    const file = join(tempDir(), "strict.jsonl")
    const before = process.umask(0o277)
    try {
      writeItems(file, itemsToJsonl(items), false)
    } finally {
      process.umask(before)
    }
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("--out must be given, must have a folder, must not be a folder, and must not be the database", () => {
    const db = dbFile()
    const dir = tempDir()
    expect(() => readCli(["--db", db])).toThrow("--out")
    expect(() => readCli(["--out", join(dir, "x")])).toThrow("--db")
    expect(() => checkOutPath(join(dir, "no", "such", "x.jsonl"), db, false)).toThrow(
      "folder of --out",
    )
    expect(() => checkOutPath(dir, db, true)).toThrow("not a folder")
    expect(() => checkOutPath(db, db, true)).toThrow("same file as --db")
    // The database is still there.
    expect(existsSync(db)).toBe(true)
  })

  test("the options: a date for --since, a whole number for --limit, no value in a message", () => {
    expect(readCli(["--db", "d", "--out", "o"])).toMatchObject({
      since: null,
      limit: null,
      force: false,
    })
    expect(readCli(["--db", "d", "--out", "o", "--since", "2026-10-01"]).since).toBe(
      Date.parse("2026-10-01T00:00:00Z"),
    )
    expect(readCli(["--db", "d", "--out", "o", "--since", "2026-10-01T12:30:00+09:00"]).since).toBe(
      Date.parse("2026-10-01T03:30:00Z"),
    )
    expect(readCli(["--db", "d", "--out", "o", "--limit", "20", "--force"])).toMatchObject({
      limit: 20,
      force: true,
    })
    expect(readCli(["--help"]).help).toBe(true)
    for (const bad of [
      ["--since", "yesterday"],
      ["--since", "2026-13-45"],
      ["--limit", "0"],
      ["--limit", "-3"],
      ["--limit", "abc"],
      ["--since"],
    ])
      expect(() => readCli(["--db", "d", "--out", "o", ...bad])).toThrow(/--since|--limit/)
    let message = ""
    try {
      readCli(["--db", "d", "--out", "o", "--key=SECRET-KEY"])
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain("Unknown argument")
    expect(message).not.toContain("SECRET-KEY")
    expect(() => readCli(["--db", "d", "--out", "o", "SECRET-VALUE"])).toThrow("(a value)")
  })
})

// --------------------------------------------------------------------------- the round trip

describe("the round trip with the replay", () => {
  const scene = () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    w.message({
      id: "MSGID-u",
      channel: LAUNCH,
      author: "user",
      parts: text("MSG-user asks"),
      at: at(110),
    })
    w.message({
      id: "MSGID-l",
      channel: LAUNCH,
      agent: "AGENTID-lia",
      parts: text("MSG-lead plans"),
      at: at(120),
    })
    partOf(w, "TASKID-one", "JOBID-1", {
      created: at(1000),
      verdict: "met",
      judged: at(9000),
      reply: "Reply one",
    })
    partOf(w, "TASKID-two", "JOBID-1", {
      created: at(1100),
      verdict: "not_met",
      reason: "SECRET",
      judged: at(9000),
      reply: `Start of two ${"y".repeat(1800)} end of two`,
    })
    w.message({
      id: "MSGID-late",
      channel: LAUNCH,
      agent: "AGENTID-lia",
      parts: text("MSG-late"),
      at: at(9500),
    })
    w.close()
    return w
  }
  const labeled = (items: readonly JudgeItem[], human: string) =>
    items.map((item) => JSON.stringify({ ...item, human })).join("\n")

  test("the output with a label added goes through parseItems", () => {
    const { items } = run(scene().file)
    const parsed = parseItems(labeled(items, "pass"))
    expect(parsed.problems).toEqual([])
    expect(parsed.items.map((i) => i.id)).toEqual(["real-0001", "real-0002"])
    expect(parsed.items[1]).toMatchObject({
      tag: "real",
      human: "pass",
      member: "Bo",
      channel: "Launch",
    })
    expect(parsed.items[1]?.reply).toBe(items[1]?.reply as string)
  })

  test("the check text that the replay builds from an item equals the text of the app for the same data", () => {
    const { items } = run(scene().file)
    const parsed = parseItems(labeled(items, "pass")).items
    const [call] = callsFor("v1", parsed, 0, () => true)
    // The same data, written by hand and given to the shared function that the app uses.
    const expected = checkStateText({
      channel: "Launch",
      topic: "Ship the launch",
      members: [
        { name: "Lia", role: "Leads the launch" },
        { name: "Bo", role: "Writes text" },
        { name: "Cy", role: "Checks facts" },
      ],
      parts: [
        {
          agentName: "Bo",
          label: "LBL-one",
          state: "done",
          verdict: null,
          verdictReason: null,
          decided: false,
          error: null,
        },
        {
          agentName: "Bo",
          label: "LBL-two",
          state: "done",
          verdict: null,
          verdictReason: null,
          decided: false,
          error: null,
        },
      ],
      messages: [
        { who: "User", text: "MSG-user asks" },
        { who: "Lia", text: "MSG-lead plans" },
        { who: "Bo", text: "Reply one" },
        { who: "Bo", text: `Start of two ${"y".repeat(1800)} end of two` },
      ],
      judge: [
        {
          number: 1,
          agentName: "Bo",
          label: "LBL-one",
          doneTest: "DONE-one",
          reply: "Reply one",
        },
        {
          number: 2,
          agentName: "Bo",
          label: "LBL-two",
          doneTest: "DONE-two",
          reply: `Start of two ${"y".repeat(1800)} end of two`,
        },
      ],
    })
    expect(call?.user).toBe(expected)
    // The late message (after the verdict) is not in the text. The reason of the verdict is not either.
    expect(call?.user).not.toContain("MSG-late")
    expect(call?.user).not.toContain("SECRET")
  })

  test("the output without the field human makes parseItems fail with the line and the field and no value", () => {
    const { items } = run(scene().file)
    const text = itemsToJsonl(items)
    const { items: read, problems, unlabeled } = parseItems(text)
    expect(read).toEqual([])
    expect(unlabeled).toBe(0)
    expect(problems).toEqual([
      'line 1: "human" is missing, the item is not labeled yet',
      'line 2: "human" is missing, the item is not labeled yet',
    ])
    expect(problems.join("\n")).not.toMatch(/LBL|DONE|REPLY|MSG|Reply one|Launch/)
    // "counts" may read them, and counts them. An item with no label is never a skip.
    const counted = parseItems(text, { allowUnlabeled: true })
    expect(counted.problems).toEqual([])
    expect(counted.items).toEqual([])
    expect(counted.unlabeled).toBe(2)
  })
})

// ---------------------------------------------------------------------------- the command

describe("the command", () => {
  const script = resolve(import.meta.dirname, "judge-items.ts")
  const [root] = repositoryRoots() as [string]
  const exec = async (args: string[], cwd = tempDir(), command: string[] = ["bun", script]) => {
    const child = Bun.spawn([...command, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code: await child.exited, out, err }
  }
  const dbFile = () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-one", "JOBID-1", {
      created: at(1000),
      verdict: "not_met",
      reason: "SECRET",
      judged: at(5000),
    })
    partOf(w, "TASKID-two", "JOBID-1", { created: at(1100) })
    partOf(w, "TASKID-skip", "JOBID-1", { created: at(1200), doneTest: null })
    w.close()
    return w.file
  }

  test("writes the file, prints counts only, and does not change the database", async () => {
    const db = dbFile()
    const old = new Date("2026-01-02T03:04:05Z")
    utimesSync(db, old, old)
    const before = fileState(db)
    const dir = tempDir()
    const out = join(dir, "items.jsonl")
    const result = await exec(["--db", db, "--out", out])
    expect(result.code).toBe(0)
    expect(result.out).toContain("Items written: 2, from 1 job")
    expect(result.out).toContain("no done test: 1")
    for (const printed of [result.out, result.err]) {
      expect(printed).not.toMatch(/LBL|DONE|REPLY|MSG|SECRET|Launch|Lia|TASKID/)
      expect(printed).not.toContain(db)
    }
    expect(statSync(out).mode & 0o777).toBe(0o600)
    const lines = readFileSync(out, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(readFileSync(out, "utf8")).not.toMatch(/SECRET|not_met|"human"/)
    const after = fileState(db)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0)
  })

  test("--out inside the repository is refused and nothing is written there", async () => {
    const db = dbFile()
    const out = join(root, "judge-items-cli-must-not-exist.jsonl")
    const result = await exec(["--db", db, "--out", out, "--force"])
    expect(result.code).toBe(1)
    expect(result.err).toContain("--out is inside this repository")
    expect(result.err).not.toContain(root)
    expect(result.out).toBe("")
    expect(existsSync(out)).toBe(false)
  })

  test("an existing --out is refused, then replaced with --force, and the old file is kept at the refusal", async () => {
    const db = dbFile()
    const out = join(tempDir(), "items.jsonl")
    writeFileSync(out, "OLD CONTENT")
    const refused = await exec(["--db", db, "--out", out])
    expect(refused.code).toBe(1)
    expect(refused.err).toContain("--force")
    expect(readFileSync(out, "utf8")).toBe("OLD CONTENT")
    const forced = await exec(["--db", db, "--out", out, "--force"])
    expect(forced.code).toBe(0)
    expect(readFileSync(out, "utf8")).toContain('"id":"real-0001"')
    expect(statSync(out).mode & 0o777).toBe(0o600)
  })

  test("a database that lacks a column gives a clear message and writes no file", async () => {
    const index = migrations.findIndex((sql) => sql.includes("ADD COLUMN done_test"))
    const dir = tempDir()
    const file = join(dir, "old.db")
    const db = new DatabaseSync(file)
    for (const sql of migrations.slice(0, index)) db.exec(sql)
    db.close()
    const out = join(dir, "items.jsonl")
    const result = await exec(["--db", file, "--out", out])
    expect(result.code).toBe(1)
    expect(result.err).toContain("task.done_test")
    expect(result.err).not.toMatch(/\n\s+at /)
    expect(existsSync(out)).toBe(false)
  })

  test("a copy with no qualifying part writes no file, and says so", async () => {
    const w = base()
    w.job("JOBID-1", LAUNCH, "AGENTID-lia", at(100))
    partOf(w, "TASKID-none", "JOBID-1", { created: at(1000), doneTest: null })
    w.close()
    const out = join(tempDir(), "items.jsonl")
    const result = await exec(["--db", w.file, "--out", out])
    expect(result.code).toBe(1)
    expect(result.out).toContain("Items written: 0")
    expect(result.err).toContain("Nothing was written")
    expect(existsSync(out)).toBe(false)
  })

  test("the script of the repository passes the arguments after --, and --help shows the usage", async () => {
    const db = dbFile()
    const out = join(tempDir(), "items.jsonl")
    const result = await exec(
      ["judge-items", "--", "--db", db, "--out", out, "--limit", "1"],
      root,
      ["bun", "run"],
    )
    expect(result.code).toBe(0)
    expect(result.out).toContain("Items written: 1, from 1 job")
    expect(result.out).toContain("Parts left out by --limit: 1")
    const help = await exec(["--help"])
    expect(help.code).toBe(0)
    expect(help.out).toContain("COPY of the database")
    expect(help.out).toContain("read-only")
    expect(help.out).toContain("0600")
    const none = await exec([])
    expect(none.code).toBe(1)
    expect(none.err).toContain("--db")
  })
})
