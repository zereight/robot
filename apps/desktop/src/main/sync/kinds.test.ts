import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  MEMORY_TEXT_MAX,
  MEMORY_USER_TEXT_MAX,
  RUNTIME_KINDS,
  WORKFLOW_NOTES_MAX,
} from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "../services/Agents.ts"
import { Channels } from "../services/Channels.ts"
import { Database, type DatabaseService, openDatabase } from "../services/Database.ts"
import { Handbook } from "../services/Handbook.ts"
import { Routines } from "../services/Routines.ts"
import { Servers } from "../services/Servers.ts"
import { testRuntime } from "../services/testing.ts"
import { Workflows } from "../services/Workflows.ts"
import type { Ctx, Fields } from "./kinds.ts"
import { KIND_ORDER, KINDS } from "./kinds.ts"
import { parseOp } from "./wire.ts"

// What sync carries (spec 019) next to the data that other specs added later: the notes of a
// workflow (010), the new kinds of steps, the cards that ask and the notes of knowledge tools
// (016). Every kind is made from a first copy on a fresh database, and read back.

const NOW = 1_700_000_000_000
const stamp = [NOW, 0, "dev-b"]

const runtimes: ReturnType<typeof testRuntime>[] = []
afterAll(async () => {
  for (const r of runtimes) await r.runtime.dispose()
})

/** The database of a whole app, with an agent, a channel, a routine and a workflow in it. */
const source = async () => {
  const rt = testRuntime({ name: "Source" })
  runtimes.push(rt)
  const run = rt.runtime.runPromise
  const db = await run(Database.use((d) => Effect.succeed(d)))
  const serverId = (await run(Servers.use((s) => s.local))).id
  const ada = await run(
    Agents.use((a) =>
      a.create({
        serverId,
        name: "Ada",
        role: "Helper",
        instructions: "Be brief.",
        readHandbook: false,
        model: null,
      }),
    ),
  )
  const bo = await run(
    Agents.use((a) => a.create({ serverId, name: "Bo", role: "", instructions: "", model: null })),
  )
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId,
        name: "Team",
        topic: "Talk",
        instructions: "Write the answer as a list.",
        memberIds: [ada.id, bo.id],
        leadId: ada.id,
      }),
    ),
  )
  // The handbook has a history of two versions (spec 002, 019).
  await run(Handbook.use((h) => h.save(serverId, "Answer in Korean.", "page")))
  await run(Handbook.use((h) => h.save(serverId, "Answer in English.", "device")))
  const routine = await run(
    Routines.use((r) =>
      r.create({
        serverId,
        agentId: ada.id,
        name: "Check",
        prompt: "hello",
        schedule: { kind: "every", minutes: 5, from: NOW },
        place: { kind: "agent" },
      }),
    ),
  )
  const workflow = await run(
    Workflows.use((w) =>
      w.create({
        serverId,
        name: "Flow",
        trigger: { kind: "manual" },
        steps: [
          {
            id: "s1",
            kind: "agent",
            name: "Write",
            x: 0,
            y: 0,
            agentId: ada.id,
            prompt: "{{input}}",
            continueOnFailure: false,
            effort: "high",
          },
          {
            id: "s2",
            kind: "condition",
            name: "Is it long?",
            x: 1,
            y: 0,
            contains: "Is the text long?",
            mode: "ask",
            provider: { accountId: "acc-1", model: "mock" },
          },
          { id: "s3", kind: "approval", name: "OK?", x: 2, y: 0, message: "Go on?" },
          { id: "s4", kind: "post", name: "Post", x: 3, y: 0, channelId: channel.id, text: "Done" },
          { id: "s5", kind: "notify", name: "Tell me", x: 4, y: 0, title: "Finished" },
        ],
        edges: [
          { id: "e1", from: "s1", to: "s2" },
          { id: "e2", from: "s2", to: "s3", branch: "yes" },
          { id: "e3", from: "s3", to: "s4" },
          { id: "e4", from: "s4", to: "s5" },
        ],
        notes: [
          { id: "n1", text: "Remember the tone.", tone: "yellow", x: 10, y: 20 },
          { id: "n2", text: "Second note", tone: "pink", x: -5, y: 3 },
        ],
      }),
    ),
  )
  const tools = [
    {
      kind: "tool",
      id: "c1",
      name: "run_command",
      label: "ls",
      state: "waiting",
      input: "",
      output: "",
      ask: { kind: "approval", summary: "Run ls", askedAt: NOW, once: true },
    },
    {
      kind: "tool",
      id: "c2",
      name: "ask_user",
      label: "Pick",
      state: "waiting",
      input: "",
      output: "",
      ask: { kind: "question", question: "Which?", choices: ["a", "b"], askedAt: NOW },
    },
    {
      kind: "tool",
      id: "c3",
      name: "knowledge_write",
      label: "Alpha",
      state: "waiting",
      input: "",
      output: "",
      ask: { kind: "article", title: "Alpha", before: "old text", after: null, askedAt: NOW },
    },
    {
      kind: "tool",
      id: "c4",
      name: "knowledge_write",
      label: "Alpha",
      state: "done",
      input: "",
      output: "",
      knowledge: { kind: "write", title: "Alpha", change: "edit", changeId: "ch-1" },
    },
    {
      kind: "tool",
      id: "c5",
      name: "knowledge_read",
      label: "Beta",
      state: "done",
      input: "",
      output: "",
      knowledge: { kind: "read", title: "Beta" },
      decision: { answer: "allow", by: "MacBook 2" },
    },
    // A change from the chat, with its line and its Undo (spec 002).
    {
      kind: "tool",
      id: "c10",
      name: "settings",
      label: "settings",
      state: "done",
      input: "",
      output: "",
      settings: {
        changes: [
          {
            field: "model",
            before: { accountId: "acc-1", model: "mock", effort: null },
            after: { accountId: "acc-1", model: "o3-mini", effort: "high" },
          },
          { field: "instructions", before: "Be brief.", after: "Answer in Korean." },
          { field: "theme", before: "system", after: "light" },
          { field: "compactPlaces", before: false, after: true },
          { field: "face", before: { shape: 0, hue: 1 }, after: { shape: 5, hue: 9 } },
        ],
        versionId: "iv-1",
        undone: true,
      },
    },
    {
      kind: "tool",
      id: "c6",
      name: "knowledge_source",
      label: "data.bin",
      state: "failed",
      input: "",
      output: "",
      knowledge: { kind: "failed", title: "Beta", code: "knowledge_full" },
    },
    {
      kind: "tool",
      id: "c7",
      name: "knowledge_source",
      label: "data.bin",
      state: "done",
      input: "",
      output: "",
      knowledge: { kind: "source", name: "data.bin" },
    },
    // The lines of the memory tool hold ids only (spec 008, 019).
    {
      kind: "tool",
      id: "c8",
      name: "save_memory",
      label: "save_memory",
      state: "done",
      input: "",
      output: "Saved to memory.",
      memory: { kind: "saved", historyId: "hist-1" },
    },
    {
      kind: "tool",
      id: "c9",
      name: "save_memory",
      label: "save_memory",
      state: "done",
      input: "",
      output: "Suggested for memory.",
      memory: { kind: "suggested", proposalId: "prop-1" },
    },
    // A step of Muse Code that waits for an approval: the card holds the whole command.
    {
      kind: "tool",
      id: "tool-1",
      name: "bash",
      label: "bash: cat > notes.txt",
      state: "waiting",
      input: JSON.stringify({ command: "cat > notes.txt <<'EOF'\n".concat("x".repeat(12_000)) }),
      output: "",
      ask: {
        kind: "approval",
        summary: "cat > notes.txt <<'EOF'\n".concat("x".repeat(12_000)),
        askedAt: NOW,
      },
    },
  ]
  const sql = (text: string, ...args: (string | number | null)[]) => db.run(text, ...args)
  sql(
    "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('acc-1', 'custom', 'Mock', 'http://127.0.0.1:1/v1', ?)",
    NOW,
  )
  sql(
    "INSERT INTO memory (id, agent_id, text, source, created_at, updated_at) VALUES ('mem-1', ?, 'Likes tea', 'user', ?, ?)",
    ada.id,
    NOW,
    NOW,
  )
  sql(
    "INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at) VALUES ('msg-1', ?, 'agent', ?, 'done', ?, ?)",
    ada.id,
    JSON.stringify([{ kind: "text", text: "Hi" }, ...tools]),
    NOW,
    NOW,
  )
  // A thread with a fork origin, and the line "Compacted" in it (spec 003, 019).
  sql(
    "INSERT INTO thread (id, agent_id, title, titled, created_at, archived_at, fork_thread_id, fork_message_id) VALUES ('th-1', ?, 'Plan', 1, ?, NULL, NULL, 'msg-1')",
    ada.id,
    NOW,
  )
  sql(
    "INSERT INTO message (id, agent_id, thread_id, author, parts, status, created_at, finished_at) VALUES ('msg-2', ?, 'th-1', 'agent', ?, 'done', ?, ?)",
    ada.id,
    JSON.stringify([
      { kind: "compacted", summary: "Short summary", at: NOW, auto: true },
      { kind: "note", note: "compact_failed", code: "provider_error" },
    ]),
    NOW,
    NOW,
  )
  sql(
    "INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, created_at, finished_at) VALUES ('cm-1', ?, 'agent', ?, 'text', ?, 'done', ?, ?)",
    channel.id,
    ada.id,
    JSON.stringify([{ kind: "text", text: "Hello team" }, tools[3]]),
    NOW,
    NOW,
  )
  sql(
    "INSERT INTO task (id, agent_id, prompt, label, source, state, created_at) VALUES ('task-1', ?, 'Do it', 'Job', 'chat', 'done', ?)",
    ada.id,
    NOW,
  )
  sql(
    "INSERT INTO instruction_version (id, agent_id, text, source, created_at) VALUES ('iv-1', ?, 'Be brief.', 'chat', ?)",
    ada.id,
    NOW,
  )
  sql(
    "INSERT INTO routine_skip (id, routine_id, at, kind) VALUES ('skip-1', ?, ?, 'missed')",
    routine.id,
    NOW,
  )
  sql(
    "INSERT INTO workflow_run (id, workflow_id, state, trigger, trigger_text, started_at) VALUES ('run-1', ?, 'done', 'manual', '', ?)",
    workflow.id,
    NOW,
  )
  for (const [step, kind] of [
    ["s1", "agent"],
    ["s2", "condition"],
    ["s5", "notify"],
  ] as const) {
    sql(
      "INSERT INTO workflow_run_step (run_id, step_id, name, kind, state, input, result, error, branch, task_id) VALUES ('run-1', ?, ?, ?, 'done', '', '', '', '', NULL)",
      step,
      step,
      kind,
    )
  }
  // The user sections are the layout of one computer: the agent and the channel are in one here.
  sql(
    "INSERT INTO place_section (id, server_id, kind, name, name_key, position, created_at) VALUES ('sec-1', ?, 'agent', 'Research', 'research', 0, ?)",
    serverId,
    NOW,
  )
  sql(
    "INSERT INTO place_section (id, server_id, kind, name, name_key, position, created_at) VALUES ('sec-2', ?, 'channel', 'Teams', 'teams', 0, ?)",
    serverId,
    NOW,
  )
  sql("UPDATE agent SET place_section_id = 'sec-1' WHERE id = ?", ada.id)
  sql("UPDATE channel SET place_section_id = 'sec-2' WHERE id = ?", channel.id)
  // The memory choice, the proposals and the history of the first agent: sync must not carry them.
  sql("UPDATE agent SET memory_mode = 'ask' WHERE id = ?", ada.id)
  sql(
    "INSERT INTO memory_proposal (id, agent_id, text, created_at) VALUES ('prop-1', ?, 'Waits for the user', ?)",
    ada.id,
    NOW,
  )
  sql(
    "INSERT INTO memory_history (id, agent_id, memory_id, at, actor, kind, source, new_text) VALUES ('hist-1', ?, 'mem-1', ?, 'user', 'added', 'user', 'Likes tea')",
    ada.id,
    NOW,
  )
  // The knowledge of the first agent: sync must not carry it.
  sql("UPDATE agent SET knowledge_enabled = 1 WHERE id = ?", ada.id)
  sql(
    "INSERT INTO knowledge_file (agent_id, file, hash, editor, content) VALUES (?, 'Alpha.md', 'h', 'agent', 'secret article text')",
    ada.id,
  )
  sql(
    "INSERT INTO knowledge_change (id, agent_id, kind, title, file, earlier, actor, at) VALUES ('ch-1', ?, 'add', 'Alpha', 'Alpha.md', NULL, 'agent', ?)",
    ada.id,
    NOW,
  )
  return { db, serverId, ada, bo, channel, routine, workflow }
}

/** A database that records the text of every statement that it runs. */
const watched = (db: DatabaseService) => {
  const statements: string[] = []
  const wrapped: DatabaseService = {
    ...db,
    run: (text, ...args) => {
      statements.push(text)
      return db.run(text, ...args)
    },
    all: (text, ...args) => {
      statements.push(text)
      return db.all(text, ...args)
    },
    get: (text, ...args) => {
      statements.push(text)
      return db.get(text, ...args)
    },
  }
  return { db: wrapped, statements }
}

const target = (db: DatabaseService, dir: string): Ctx => {
  db.run(
    "INSERT INTO server (id, name, kind, position, created_at) VALUES ('srv-b', 'B', 'local', 0, 0)",
  )
  return {
    db,
    self: "dev-b",
    peer: () => ({ id: "dev-a", name: "Computer A" }),
    localServerId: () => "srv-b",
    accountOf: (id) => id,
    newWorkspace: (name, id) => {
      const path = join(dir, `${name}-${id}`)
      mkdirSync(path, { recursive: true })
      return path
    },
    facesDir: dir,
    removeSecret: () => {},
    now: () => NOW,
  }
}

const copy = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

describe("how far a turn went syncs with the task (spec 005, 019)", () => {
  const dirOf = () => join(testRuntime().dataDir, "kinds")
  const opOf = (fields: Fields) =>
    parseOp(
      {
        k: "task",
        i: "task-1",
        o: "dev-a",
        f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
      },
      NOW,
    )

  test("the progress is read with the task, arrives with it, and follows later changes", async () => {
    const a = await source()
    a.db.run("UPDATE task SET progress = 'sent' WHERE id = 'task-1'")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields.progress).toBe("sent")
    expect(KINDS.task.required).toContain("progress")
    // A first copy on the other computer keeps it.
    const b = target(openDatabase(":memory:"), dirOf())
    // The agent comes first, as in the order of the kinds.
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    expect(KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)).toBe(true)
    expect(KINDS.task.create(b, "task-1", fields)).toBe(true)
    expect(KINDS.task.read(b, "task-1")?.fields.progress).toBe("sent")
    // A later change reaches the copy.
    KINDS.task.write(b, "task-1", { progress: "started" })
    expect(KINDS.task.read(b, "task-1")?.fields.progress).toBe("started")
  })

  test("a task from before the progress was kept has none, and that crosses too", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields.progress).toBeNull()
    expect(opOf(fields)).toBeDefined()
  })

  test("only the three values pass the strict check", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    for (const progress of ["not_sent", "sent", "started", null])
      expect(opOf({ ...fields, progress }), String(progress)).toBeDefined()
    for (const progress of ["done", "", 2, true, {}])
      expect(opOf({ ...fields, progress }), String(progress)).toBeUndefined()
    // A first copy must name it.
    expect(KINDS.task.required).toContain("progress")
  })
})

describe("the done test and the verdict sync with the task (spec 004, 005, 019)", () => {
  const dirOf = () => join(testRuntime().dataDir, "kinds")
  const opOf = (fields: Fields) =>
    parseOp(
      {
        k: "task",
        i: "task-1",
        o: "dev-a",
        f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
      },
      NOW,
    )

  test("a part carries its done test, verdict, reason and times to the copy, and later changes follow", async () => {
    const a = await source()
    a.db.run(
      `UPDATE task SET done_test = 'Holds a title', verdict = 'not_met',
         verdict_reason = 'No title', judged_at = 70, decided_at = 80 WHERE id = 'task-1'`,
    )
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields).toMatchObject({
      doneTest: "Holds a title",
      verdict: "not_met",
      verdictReason: "No title",
      judgedAt: 70,
      decidedAt: 80,
    })
    for (const name of ["doneTest", "verdict", "verdictReason", "judgedAt", "decidedAt"])
      expect(KINDS.task.required).toContain(name)
    const b = target(openDatabase(":memory:"), dirOf())
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    expect(KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)).toBe(true)
    expect(KINDS.task.create(b, "task-1", fields)).toBe(true)
    expect(KINDS.task.read(b, "task-1")?.fields).toMatchObject({
      doneTest: "Holds a title",
      verdict: "not_met",
      verdictReason: "No title",
      judgedAt: 70,
      decidedAt: 80,
    })
    // The verdict that the lead gives later reaches the copy. The done test is set once.
    KINDS.task.write(b, "task-1", {
      verdict: "met",
      verdictReason: null,
      judgedAt: 90,
      doneTest: "Other",
    })
    expect(KINDS.task.read(b, "task-1")?.fields).toMatchObject({
      doneTest: "Holds a title",
      verdict: "met",
      verdictReason: null,
      judgedAt: 90,
    })
    expect(KINDS.task.fixed).toContain("doneTest")
  })

  test("a task with no done test and no verdict crosses with empty fields", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields).toMatchObject({
      doneTest: null,
      verdict: null,
      verdictReason: null,
      judgedAt: null,
      decidedAt: null,
    })
    expect(opOf(fields)).toBeDefined()
  })

  test("only the two verdicts pass the strict check", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    for (const verdict of ["met", "not_met", null])
      expect(opOf({ ...fields, verdict }), String(verdict)).toBeDefined()
    for (const verdict of ["Met", "failed", "", 1, true, {}])
      expect(opOf({ ...fields, verdict }), String(verdict)).toBeUndefined()
    for (const doneTest of [5, true, {}, "x".repeat(1001)])
      expect(opOf({ ...fields, doneTest }), String(doneTest)).toBeUndefined()
    expect(opOf({ ...fields, judgedAt: -1 })).toBeUndefined()
  })
})

describe("the moments of a task sync with it (spec 005, 019)", () => {
  const dirOf = () => join(testRuntime().dataDir, "kinds")
  const opOf = (fields: Fields) =>
    parseOp(
      {
        k: "task",
        i: "task-1",
        o: "dev-a",
        f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
      },
      NOW,
    )

  test("the end of the turn and the decision of the user reach the copy, and later changes follow", async () => {
    const a = await source()
    a.db.run(
      `UPDATE task SET ended_at = 60, ended_as = 'review', decision = 'changes',
         decision_text = 'Add a title', decided_at = 80 WHERE id = 'task-1'`,
    )
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields).toMatchObject({
      endedAt: 60,
      endedAs: "review",
      decision: "changes",
      decisionText: "Add a title",
    })
    for (const name of ["endedAt", "endedAs", "decision", "decisionText"])
      expect(KINDS.task.required).toContain(name)
    const b = target(openDatabase(":memory:"), dirOf())
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    expect(KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)).toBe(true)
    expect(KINDS.task.create(b, "task-1", fields)).toBe(true)
    expect(KINDS.task.read(b, "task-1")?.fields).toMatchObject({
      endedAt: 60,
      endedAs: "review",
      decision: "changes",
      decisionText: "Add a title",
    })
    KINDS.task.write(b, "task-1", { endedAs: "done", decision: "accepted", decisionText: null })
    expect(KINDS.task.read(b, "task-1")?.fields).toMatchObject({
      endedAs: "done",
      decision: "accepted",
      decisionText: null,
    })
  })

  test("a task with no moments crosses with empty fields; only known words pass the strict check", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields).toMatchObject({
      endedAt: null,
      endedAs: null,
      decision: null,
      decisionText: null,
    })
    expect(opOf(fields)).toBeDefined()
    for (const endedAs of ["done", "failed", "blocked", "cancelled", "review", null])
      expect(opOf({ ...fields, endedAs }), String(endedAs)).toBeDefined()
    for (const endedAs of ["Done", "running", "", 1, true, {}])
      expect(opOf({ ...fields, endedAs }), String(endedAs)).toBeUndefined()
    for (const decision of ["accepted", "changes", null])
      expect(opOf({ ...fields, decision }), String(decision)).toBeDefined()
    for (const decision of ["yes", "", 1, {}])
      expect(opOf({ ...fields, decision }), String(decision)).toBeUndefined()
    expect(opOf({ ...fields, endedAt: -1 })).toBeUndefined()
    expect(opOf({ ...fields, decisionText: 5 })).toBeUndefined()
  })
})

describe("the mark of a message from another agent syncs with the task (spec 029, 019)", () => {
  const dirOf = () => join(testRuntime().dataDir, "kinds")
  const opOf = (fields: Fields) =>
    parseOp(
      {
        k: "task",
        i: "task-1",
        o: "dev-a",
        f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
      },
      NOW,
    )

  test("a send and a reply reach the copy as they are; a task with no mark crosses with null", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const plain = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(plain.agentMessage).toBeNull()
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    for (const mark of ["send", "reply", null]) {
      a.db.run("UPDATE task SET source = 'agent', agent_message = ? WHERE id = 'task-1'", mark)
      const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
      expect(fields.agentMessage).toBe(mark)
      const b = target(openDatabase(":memory:"), dirOf())
      expect(KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)).toBe(true)
      expect(KINDS.task.create(b, "task-1", fields)).toBe(true)
      expect(KINDS.task.read(b, "task-1")?.fields.agentMessage).toBe(mark)
    }
  })

  test("the mark is set when the task is made and never changes after", () => {
    expect(KINDS.task.fixed).toContain("agentMessage")
    // A computer of an older step sends no mark. Its task still arrives, and is not a hand-off.
    expect(KINDS.task.required).not.toContain("agentMessage")
  })

  test("only the two known words pass the strict check", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    for (const agentMessage of ["send", "reply", null])
      expect(opOf({ ...fields, agentMessage }), String(agentMessage)).toBeDefined()
    for (const agentMessage of ["Send", "handoff", "", 1, true, {}])
      expect(opOf({ ...fields, agentMessage }), String(agentMessage)).toBeUndefined()
  })
})

describe("the usage of a task and the token limit sync (spec 005, 009, 019)", () => {
  const dirOf = () => join(testRuntime().dataDir, "kinds")
  const opOf = (kind: "task" | "routine", id: string, fields: Fields) =>
    parseOp(
      {
        k: kind,
        i: id,
        o: "dev-a",
        f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
      },
      NOW,
    )

  test("the numbers reach the copy of the task, and a later change follows", async () => {
    const a = await source()
    a.db.run(
      "UPDATE task SET input_tokens = 7000, output_tokens = 1200, cached_tokens = 5000, cost_micros = 4200, token_limit = 9000 WHERE id = 'task-1'",
    )
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields).toMatchObject({
      inputTokens: 7000,
      outputTokens: 1200,
      cachedTokens: 5000,
      costMicros: 4200,
      tokenLimit: 9000,
    })
    const b = target(openDatabase(":memory:"), dirOf())
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    expect(KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)).toBe(true)
    expect(KINDS.task.create(b, "task-1", fields)).toBe(true)
    expect(KINDS.task.read(b, "task-1")?.fields).toMatchObject({
      inputTokens: 7000,
      tokenLimit: 9000,
    })
    KINDS.task.write(b, "task-1", { inputTokens: 8000, outputTokens: 1300 })
    expect(KINDS.task.read(b, "task-1")?.fields).toMatchObject({
      inputTokens: 8000,
      outputTokens: 1300,
      cachedTokens: 5000,
    })
  })

  test("a number that was not reported stays null on both computers, never 0", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(fields).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costMicros: null,
      tokenLimit: null,
    })
    const b = target(openDatabase(":memory:"), dirOf())
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)
    KINDS.task.create(b, "task-1", fields)
    expect(KINDS.task.read(b, "task-1")?.fields.inputTokens).toBeNull()
  })

  test("a computer of an older step sends none, and its task still arrives", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const full = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    for (const name of [
      "inputTokens",
      "outputTokens",
      "cachedTokens",
      "costMicros",
      "tokenLimit",
    ]) {
      expect(KINDS.task.required).not.toContain(name)
      const { [name]: _gone, ...rest } = full
      expect(opOf("task", "task-1", rest as Fields), name).toBeDefined()
    }
  })

  test("only whole numbers of tokens pass the strict check", async () => {
    const a = await source()
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.task.read(ctxA, "task-1")?.fields) as Fields
    expect(opOf("task", "task-1", { ...fields, inputTokens: 12 })).toBeDefined()
    for (const bad of [-1, 1.5, "7", {}, true])
      expect(opOf("task", "task-1", { ...fields, inputTokens: bad }), String(bad)).toBeUndefined()
    expect(opOf("task", "task-1", { ...fields, tokenLimit: 999 })).toBeUndefined()
    expect(opOf("task", "task-1", { ...fields, tokenLimit: 10_000_001 })).toBeUndefined()
  })

  test("the token limit of a routine reaches the copy and follows a later change", async () => {
    const a = await source()
    a.db.run("UPDATE routine SET token_limit = 5000 WHERE id = ?", a.routine.id)
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dirOf()), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.routine.read(ctxA, a.routine.id)?.fields) as Fields
    expect(fields.tokenLimit).toBe(5000)
    expect(KINDS.routine.required).not.toContain("tokenLimit")
    const b = target(openDatabase(":memory:"), dirOf())
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)
    expect(KINDS.routine.create(b, a.routine.id, fields)).toBe(true)
    expect(KINDS.routine.read(b, a.routine.id)?.fields.tokenLimit).toBe(5000)
    KINDS.routine.write(b, a.routine.id, { tokenLimit: null })
    expect(KINDS.routine.read(b, a.routine.id)?.fields.tokenLimit).toBeNull()
    expect(opOf("routine", a.routine.id, { ...fields, tokenLimit: 12 })).toBeUndefined()
  })
})

describe("the note of a starter syncs with its message (spec 002, 019)", () => {
  const note = {
    kind: "note",
    note: "starter_not_made",
    what: "routine",
    name: "Weekday briefing",
    why: "limit",
  }

  test("the note passes the strict check, and a changed note does not", async () => {
    const a = await source()
    a.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('note-1', ?, 'agent', ?, 'done', ?)",
      a.ada.id,
      JSON.stringify([note]),
      NOW,
    )
    const dir = join(testRuntime().dataDir, "kinds")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.message.read(ctxA, "note-1")?.fields) as Fields
    const opOf = (parts: unknown) =>
      parseOp(
        {
          k: "message",
          i: "note-1",
          o: "dev-a",
          f: Object.fromEntries(
            Object.entries({ ...fields, parts }).map(([n, v]) => [n, { v, s: stamp }]),
          ),
        },
        NOW,
      )
    expect(opOf([note])).toBeDefined()
    expect(opOf([{ ...note, what: "skill", why: "error" }])).toBeDefined()
    // The old note of a watch still passes.
    expect(opOf([{ kind: "note", note: "watch_unchanged", routine: "Check" }])).toBeDefined()
    for (const bad of [
      { ...note, what: "agent" },
      { ...note, why: "full" },
      { ...note, name: "" },
      { ...note, name: "x".repeat(200) },
      { ...note, extra: "x" },
      { kind: "note", note: "starter_not_made", what: "routine", why: "limit" },
      { kind: "note", note: "other", routine: "Check" },
    ])
      expect(opOf([bad]), JSON.stringify(bad)).toBeUndefined()
  })

  test("the note arrives with its message and reads back the same", async () => {
    const a = await source()
    a.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('note-1', ?, 'agent', ?, 'done', ?)",
      a.ada.id,
      JSON.stringify([note]),
      NOW,
    )
    const dir = join(testRuntime().dataDir, "kinds")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const b = target(openDatabase(":memory:"), dir)
    const ada = KINDS.agent.read(ctxA, a.ada.id)
    expect(KINDS.agent.create(b, a.ada.id, copy(ada?.fields) as Fields)).toBe(true)
    const fields = copy(KINDS.message.read(ctxA, "note-1")?.fields) as Fields
    expect(KINDS.message.create(b, "note-1", fields)).toBe(true)
    expect(KINDS.message.read(b, "note-1")?.fields.parts).toEqual([note])
  })
})

describe("a handover syncs as messages and a thread do (spec 003, 007, 019)", () => {
  const card = {
    kind: "handover",
    brief: "Handover from Ada\n\nFirst request:\nFix it",
    fromName: "Ada",
    fromAgentId: "agent-ada",
    fromThreadId: null,
  }
  const line = {
    kind: "note",
    note: "handed_over",
    toName: "Bo",
    toAgentId: "agent-bo",
    toThreadId: "th-handover",
  }

  const opOf = (fields: Fields, parts: unknown) =>
    parseOp(
      {
        k: "message",
        i: "msg-card",
        o: "dev-a",
        f: Object.fromEntries(
          Object.entries({ ...fields, parts }).map(([n, v]) => [n, { v, s: stamp }]),
        ),
      },
      NOW,
    )

  test("the card and the muted line pass the strict check, and a changed one does not", async () => {
    const a = await source()
    a.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('msg-card', ?, 'user', ?, 'done', ?)",
      a.ada.id,
      JSON.stringify([card]),
      NOW,
    )
    const dir = join(testRuntime().dataDir, "kinds")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.message.read(ctxA, "msg-card")?.fields) as Fields
    expect(opOf(fields, [card])).toBeDefined()
    expect(opOf(fields, [{ ...card, fromThreadId: "th-1" }])).toBeDefined()
    expect(opOf(fields, [line])).toBeDefined()
    // The muted lines of a connection (spec 018): one with the name and nothing else.
    for (const note of ["connection_down", "connection_held"])
      expect(opOf(fields, [{ kind: "note", note, name: "Notes" }]), note).toBeDefined()
    // The muted line "Kept going (1 of 8)" (spec 005): two numbers and nothing else.
    expect(opOf(fields, [{ kind: "note", note: "kept_going", n: 1, of: 8 }])).toBeDefined()
    for (const bad of [
      { kind: "note", note: "kept_going", n: 1 },
      { kind: "note", note: "kept_going", n: "1", of: 8 },
      { kind: "note", note: "kept_going", n: -1, of: 8 },
      { kind: "note", note: "kept_going", n: 1, of: 8, extra: "x" },
    ])
      expect(opOf(fields, [bad]), JSON.stringify(bad)).toBeUndefined()
    for (const bad of [
      { kind: "note", note: "connection_held" },
      { kind: "note", note: "connection_held", name: "" },
      { kind: "note", note: "connection_held", name: "Notes", extra: "x" },
    ])
      expect(opOf(fields, [bad]), JSON.stringify(bad)).toBeUndefined()
    for (const bad of [
      { ...card, brief: 5 },
      { ...card, fromName: "" },
      { ...card, fromAgentId: "" },
      { ...card, fromThreadId: 7 },
      { ...card, extra: "x" },
      { kind: "handover", brief: "x", fromName: "Ada", fromAgentId: "a" },
      { ...line, toThreadId: "" },
      { ...line, toName: "x".repeat(300) },
      { ...line, extra: "x" },
      { kind: "note", note: "handed_over", toName: "Bo" },
    ])
      expect(opOf(fields, [bad]), JSON.stringify(bad)).toBeUndefined()
  })

  test("the card, the line and the thread with its mark arrive and read back the same", async () => {
    const a = await source()
    a.db.run(
      "INSERT INTO thread (id, agent_id, title, titled, created_at, sensitive_mark, updated_at) VALUES ('th-handover', ?, 'Handover from Ada', 1, ?, 'keys', ?)",
      a.ada.id,
      NOW,
      NOW + 5,
    )
    a.db.run(
      "INSERT INTO message (id, agent_id, thread_id, author, parts, status, created_at) VALUES ('msg-card', ?, 'th-handover', 'user', ?, 'done', ?)",
      a.ada.id,
      JSON.stringify([card]),
      NOW,
    )
    a.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('msg-line', ?, 'agent', ?, 'done', ?)",
      a.ada.id,
      JSON.stringify([line]),
      NOW,
    )
    const dir = join(testRuntime().dataDir, "kinds")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const b = target(openDatabase(":memory:"), dir)
    expect(
      KINDS.agent.create(b, a.ada.id, copy(KINDS.agent.read(ctxA, a.ada.id)?.fields) as Fields),
    ).toBe(true)
    const thread = KINDS.thread.read(ctxA, "th-handover")
    // A mark that changes moves the time of the thread, so sync stamps the change as new.
    expect(thread?.wall).toBe(NOW + 5)
    expect(thread?.fields.sensitive).toBe("keys")
    expect(KINDS.thread.create(b, "th-handover", copy(thread?.fields) as Fields)).toBe(true)
    expect(KINDS.thread.read(b, "th-handover")?.fields.sensitive).toBe("keys")
    for (const id of ["msg-card", "msg-line"])
      expect(
        KINDS.message.create(b, id, copy(KINDS.message.read(ctxA, id)?.fields) as Fields),
      ).toBe(true)
    expect(KINDS.message.read(b, "msg-card")?.fields.parts).toEqual([card])
    expect(KINDS.message.read(b, "msg-card")?.fields.threadId).toBe("th-handover")
    expect(KINDS.message.read(b, "msg-line")?.fields.parts).toEqual([line])
    // A later clear of the mark on one computer writes through the thread.
    KINDS.thread.write(b, "th-handover", { sensitive: null })
    expect(KINDS.thread.read(b, "th-handover")?.fields.sensitive).toBeNull()
    // A thread from a computer of an older step has no mark field: it makes a thread with none.
    const { sensitive: _drop, ...older } = copy(thread?.fields) as Fields
    expect(KINDS.thread.create(b, "th-old", older)).toBe(true)
    expect(KINDS.thread.read(b, "th-old")?.fields.sensitive).toBeNull()
  })

  test("the thread takes only a known label as its mark", () => {
    const op = (sensitive: unknown) =>
      parseOp(
        {
          k: "thread",
          i: "th-1",
          o: "dev-a",
          f: Object.fromEntries(
            Object.entries({
              agentId: "a",
              title: "T",
              titled: true,
              createdAt: NOW,
              archivedAt: null,
              sensitive,
            }).map(([n, v]) => [n, { v, s: stamp }]),
          ),
        },
        NOW,
      )
    expect(op("keys")).toBeDefined()
    expect(op(null)).toBeDefined()
    expect(op("passwords")).toBeUndefined()
    expect(op(3)).toBeUndefined()
  })
})

describe("one item of every kind is made from its first copy", () => {
  test("each kind passes the strict check, satisfies every column that must have a value, and reads back the same", async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds")
    const watch = watched(openDatabase(":memory:"))
    const b = target(watch.db, dir)
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }

    const seen: string[] = []
    for (const kind of KIND_ORDER) {
      const def = KINDS[kind]
      const ids = def.ids(a.db, "", 100)
      // The fixture holds at least one item of each kind.
      expect(ids.length, `an item of the kind ${kind}`).toBeGreaterThan(0)
      for (const id of ids) {
        const read = def.read(ctxA, id)
        expect(read, `${kind} ${id}`).toBeDefined()
        const fields = copy(read?.fields) as Fields
        for (const name of def.required) expect(name in fields, `${kind}.${name}`).toBe(true)
        // What goes over the link is checked field by field, as the other computer does.
        const op = parseOp(
          {
            k: kind,
            i: id,
            o: "dev-a",
            f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
          },
          NOW,
        )
        expect(op, `${kind} ${id} passes the strict check`).toBeDefined()
        expect(def.create(b, id, fields), `${kind} ${id} is made`).toBe(true)
        const back = def.read(b, id)
        expect(back, `${kind} ${id} is read back`).toBeDefined()
        const here = copy(back?.fields) as Fields
        for (const name of Object.keys(fields)) {
          // A name may change when it is taken, and the origin is this computer's id here.
          if (name === "origin" || name === "runsOn" || name === "sender") continue
          expect(here[name], `${kind}.${name}`).toEqual(fields[name] as never)
        }
        seen.push(`${kind}:${id}`)
      }
    }
    expect(new Set(seen.map((s) => s.split(":")[0])).size).toBe(KIND_ORDER.length)

    // The workflow arrived with its notes, and every new step kind.
    const wf = KINDS.workflow.read(b, a.workflow.id)?.fields
    expect(((wf?.notes ?? []) as unknown[]).length).toBe(2)
    expect(((wf?.steps ?? []) as { kind: string }[]).map((s) => s.kind)).toEqual([
      "agent",
      "condition",
      "approval",
      "post",
      "notify",
    ])
    // The tool cards arrived with their asks and their knowledge notes.
    const parts = (KINDS.message.read(b, "msg-1")?.fields.parts ?? []) as { kind: string }[]
    expect(parts.length).toBe(12)

    // The new agent and channel are in no user section here, and no section was made.
    expect(
      b.db
        .all("SELECT id FROM agent WHERE place_section_id IS NOT NULL")
        .concat(b.db.all("SELECT id FROM channel WHERE place_section_id IS NOT NULL")),
    ).toEqual([])
    expect(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM place_section")?.n).toBe(0)
    expect(
      b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent WHERE section = 'agents'")?.n,
    ).toBe(2)
    expect(
      watch.statements.filter(
        (x) => /place_section/i.test(x) && /^(INSERT|UPDATE)/i.test(x.trim()),
      ),
    ).toEqual([])

    // The knowledge of the agent did not travel: no statement touched a knowledge table, and the
    // new agent has no article.
    expect(watch.statements.filter((s) => /knowledge/i.test(s))).toEqual([])
    expect(
      b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_file")?.n,
      "articles of the agent here",
    ).toBe(0)
    expect(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_change")?.n).toBe(0)
    // The source still has its article.
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_file")?.n).toBe(1)

    // The history, the proposals and the choice of memory did not travel either (spec 019). The
    // item of memory did, and it made no history row.
    expect(watch.statements.filter((x) => /memory_(history|proposal|mode)/i.test(x))).toEqual([])
    expect(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory")?.n).toBe(1)
    expect(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_history")?.n).toBe(0)
    expect(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_proposal")?.n).toBe(0)
    expect(b.db.all("SELECT memory_mode FROM agent")).toEqual([
      { memory_mode: "now" },
      { memory_mode: "now" },
    ])
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_history")?.n).toBe(1)
    expect(a.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_proposal")?.n).toBe(1)
    expect(KINDS.agent.read(ctxA, a.ada.id)?.fields).not.toHaveProperty("memoryMode")
  })

  test("a change and a removal of every kind never touch a knowledge table", async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds-2")
    const watch = watched(openDatabase(":memory:"))
    const b = target(watch.db, dir)
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    for (const kind of KIND_ORDER) {
      for (const id of KINDS[kind].ids(a.db, "", 100)) {
        KINDS[kind].create(b, id, copy(KINDS[kind].read(ctxA, id)?.fields) as Fields)
      }
    }
    for (const kind of [...KIND_ORDER].reverse()) {
      for (const id of KINDS[kind].ids(b.db, "", 100)) {
        const fields = copy(KINDS[kind].read(b, id)?.fields) as Fields
        KINDS[kind].write(b, id, fields)
        KINDS[kind].remove(b, id)
        expect(KINDS[kind].read(b, id)).toBeUndefined()
      }
    }
    expect(watch.statements.filter((s) => /knowledge/i.test(s))).toEqual([])
    expect(watch.statements.filter((s) => /memory_(history|proposal|mode)/i.test(s))).toEqual([])
    expect(b.db.all("SELECT id FROM agent")).toEqual([])
  })
})

describe("an agent that is deleted on the other computer leaves the skills here (spec 017, 019)", () => {
  /** The copy of the agent on this computer, with three skills: only for it, shared, and for all. */
  const copyWithSkills = async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds-skills")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const b = target(openDatabase(":memory:"), dir)
    for (const id of [a.ada.id, a.bo.id]) {
      expect(KINDS.agent.create(b, id, copy(KINDS.agent.read(ctxA, id)?.fields) as Fields)).toBe(
        true,
      )
    }
    const skill = (id: string, agents: string[] | null) =>
      b.db.run(
        `INSERT INTO skill (id, server_id, name, name_key, instructions, agents, created_at)
         VALUES (?, 'srv-b', ?, ?, 'Do it.', ?, 0)`,
        id,
        id,
        id,
        agents === null ? null : JSON.stringify(agents),
      )
    skill("only", [a.ada.id])
    skill("shared", [a.ada.id, a.bo.id])
    skill("all", null)
    const agentsOf = (id: string) =>
      b.db.get<{ agents: string | null }>("SELECT agents FROM skill WHERE id = ?", id)?.agents
    return { a, b, agentsOf }
  }

  test("a skill that was only for the agent goes, and the agent leaves the others", async () => {
    const { a, b, agentsOf } = await copyWithSkills()
    KINDS.agent.remove(b, a.ada.id)
    expect(KINDS.agent.read(b, a.ada.id)).toBeUndefined()
    expect(b.db.all("SELECT id FROM skill ORDER BY id")).toEqual([{ id: "all" }, { id: "shared" }])
    expect(agentsOf("shared")).toBe(JSON.stringify([a.bo.id]))
    expect(agentsOf("all")).toBeNull()
  })

  test("a removal of an agent that is not here changes no skill", async () => {
    const { b } = await copyWithSkills()
    KINDS.agent.remove(b, "not-an-agent")
    expect(b.db.all("SELECT id FROM skill")).toHaveLength(3)
  })
})

describe("the notes and the steps of a workflow cross as the strict check allows", () => {
  const workflowOp = (extra: Record<string, unknown>) => {
    const field = (v: unknown) => ({ v, s: stamp })
    return {
      k: "workflow",
      i: "wf-1",
      o: "dev-b",
      f: {
        name: field("Flow"),
        trigger: field({ kind: "manual" }),
        steps: field([]),
        edges: field([]),
        notes: field([]),
        enabled: field(true),
        runsOn: field("dev-b"),
        createdAt: field(NOW),
        ...Object.fromEntries(Object.entries(extra).map(([n, v]) => [n, field(v)])),
      },
    }
  }
  const note = (extra: Record<string, unknown> = {}) => ({
    id: "n1",
    text: "A note",
    tone: "blue",
    x: 1,
    y: 2,
    ...extra,
  })

  test("a workflow needs its notes, and takes only notes of the right shape and size", () => {
    expect(parseOp(workflowOp({ notes: [note()] }), NOW)).toBeDefined()
    expect(parseOp(workflowOp({ notes: [] }), NOW)).toBeDefined()
    const bad = (notes: unknown) => expect(parseOp(workflowOp({ notes }), NOW)).toBeUndefined()
    bad("not a list")
    bad([note({ tone: "red" })])
    bad([note({ text: "x".repeat(2001) })])
    bad([note({ extra: true })])
    bad([note({ x: "1" })])
    bad([note({ id: "" })])
    bad(Array.from({ length: WORKFLOW_NOTES_MAX + 1 }, (_, i) => note({ id: `n${i}` })))
    expect(
      parseOp(
        workflowOp({
          notes: Array.from({ length: WORKFLOW_NOTES_MAX }, (_, i) => note({ id: `n${i}` })),
        }),
        NOW,
      ),
    ).toBeDefined()
  })

  test("a notify step, a condition that asks a model and the effort of a step pass; a wrong one does not", () => {
    const ok = (steps: unknown) => expect(parseOp(workflowOp({ steps }), NOW)).toBeDefined()
    const bad = (steps: unknown) => expect(parseOp(workflowOp({ steps }), NOW)).toBeUndefined()
    const base = { id: "s", name: "Step", x: 0, y: 0 }
    ok([{ ...base, kind: "notify", title: "Done" }])
    ok([
      {
        ...base,
        kind: "condition",
        contains: "Is it good?",
        mode: "ask",
        provider: { accountId: "acc", model: "m" },
      },
    ])
    ok([{ ...base, kind: "condition", contains: "yes" }])
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      ok([{ ...base, kind: "agent", agentId: "", prompt: "", continueOnFailure: false, effort }])
    }
    bad([{ ...base, kind: "notify", title: "x".repeat(101) }])
    bad([{ ...base, kind: "notify" }])
    bad([{ ...base, kind: "condition", contains: "x", mode: "guess" }])
    bad([{ ...base, kind: "condition", contains: "x", provider: { accountId: "a" } }])
    bad([
      {
        ...base,
        kind: "agent",
        agentId: "",
        prompt: "",
        continueOnFailure: false,
        effort: "extreme",
      },
    ])
    bad([{ ...base, kind: "script", code: "x" }])
  })

  test("the run of a notify step is a step kind that sync carries", () => {
    const op = {
      k: "wstep",
      i: "run-1|s5",
      o: "dev-b",
      f: Object.fromEntries(
        Object.entries({
          runId: "run-1",
          stepId: "s5",
          name: "Tell me",
          kind: "notify",
          state: "done",
          input: "",
          result: "",
          error: "",
          branch: "",
          taskId: null,
        }).map(([n, v]) => [n, { v, s: stamp }]),
      ),
    }
    expect(parseOp(op, NOW)).toBeDefined()
  })
})

describe("the cards that ask and the notes of knowledge tools in a message", () => {
  const message = (tool: Record<string, unknown>) => {
    const field = (v: unknown) => ({ v, s: stamp })
    return {
      k: "message",
      i: "m1",
      o: "dev-b",
      f: {
        agentId: field("agent-1"),
        author: field("agent"),
        parts: field([
          {
            kind: "tool",
            id: "c1",
            name: "t",
            label: "l",
            state: "waiting",
            input: "",
            output: "",
            ...tool,
          },
        ]),
        status: field("streaming"),
        error: field(null),
        replyTo: field(null),
        model: field(null),
        createdAt: field(NOW),
        finishedAt: field(null),
        editedAt: field(null),
        sender: field(null),
        origin: field("dev-b"),
      },
    }
  }
  const ok = (tool: Record<string, unknown>) => expect(parseOp(message(tool), NOW)).toBeDefined()
  const bad = (tool: Record<string, unknown>) => expect(parseOp(message(tool), NOW)).toBeUndefined()

  test("a protected card of a saved secret passes without a value; the end of the card passes", () => {
    const secret = {
      kind: "secret",
      name: "test_api",
      label: "Test key",
      reason: "To read it.",
      origin: "https://api.example.com",
      auth: { kind: "bearer" },
    }
    ok({ ask: secret })
    ok({ ask: { ...secret, replace: true, askedAt: NOW } })
    ok({ ask: { ...secret, auth: { kind: "header", header: "X-Key" } } })
    ok({ ask: { ...secret, auth: { kind: "basic", user: "ada" } } })
    ok({ secret: "saved" })
    ok({ secret: "cancelled" })
    // A card never carries a value, and an unknown field is refused.
    bad({ ask: { ...secret, value: "tok" } })
    bad({ ask: { ...secret, auth: { kind: "bearer", value: "tok" } } })
    bad({ ask: { ...secret, auth: { kind: "header" } } })
    bad({ ask: { ...secret, name: "" } })
    bad({ secret: "maybe" })
  })

  test("an approval, a question and an article card pass; a card with a wrong field does not", () => {
    ok({ ask: { kind: "approval", summary: "Run ls" } })
    ok({ ask: { kind: "approval", summary: "Run ls", askedAt: NOW, once: true } })
    ok({ ask: { kind: "question", question: "Which?", choices: ["a"], askedAt: NOW } })
    ok({ ask: { kind: "article", title: "Alpha", before: "old", after: "new", askedAt: NOW } })
    ok({ ask: { kind: "article", title: "Alpha", before: "old", after: null } })
    // The command of a step can be long, as long as its input.
    ok({ ask: { kind: "approval", summary: "x".repeat(12_000), askedAt: NOW } })
    bad({ ask: { kind: "approval", summary: "x".repeat(2_000_001) } })
    bad({ ask: { kind: "approval", summary: "Run ls", once: "yes" } })
    bad({ ask: { kind: "approval", summary: "Run ls", extra: 1 } })
    // A guarded step in a turn that holds outside content names its first source (spec 007).
    ok({
      ask: {
        kind: "approval",
        summary: "Say yes",
        once: true,
        outside: { kind: "page", host: "example.com" },
      },
    })
    ok({
      ask: { kind: "approval", summary: "x", once: true, outside: { kind: "agent", name: "Bo" } },
    })
    bad({ ask: { kind: "approval", summary: "x", outside: { kind: "page" } } })
    bad({ ask: { kind: "approval", summary: "x", outside: { kind: "mail", name: "a" } } })
    bad({ ask: { kind: "article", title: "Alpha", before: "old" } })
    bad({ ask: { kind: "article", title: "Alpha", before: null, after: "x" } })
    bad({ ask: { kind: "article", title: "Alpha", before: "old", after: 5 } })
    bad({ ask: { kind: "article", title: "Alpha", before: "old", after: "x", url: "x" } })
    bad({ ask: { kind: "article", title: "x".repeat(1000), before: "", after: "" } })
    bad({ ask: { kind: "script", summary: "x" } })
  })

  test("the note of a knowledge tool passes in each of its four forms; a wrong note does not", () => {
    ok({ knowledge: { kind: "read", title: "Beta" } })
    ok({ knowledge: { kind: "write", title: "A", change: "add", changeId: "ch-1" } })
    ok({ knowledge: { kind: "write", title: "A", change: "delete", changeId: "ch-1" } })
    ok({ knowledge: { kind: "source", name: "data.bin" } })
    ok({ knowledge: { kind: "failed", title: "A", code: "knowledge_full" } })
    bad({ knowledge: { kind: "write", title: "A", change: "move", changeId: "ch-1" } })
    bad({ knowledge: { kind: "write", title: "A", change: "add" } })
    bad({ knowledge: { kind: "read", title: "Beta", body: "the whole article" } })
    bad({ knowledge: { kind: "read", title: 5 } })
    bad({ knowledge: { kind: "other" } })
    bad({ knowledge: "read" })
  })

  test("the line of the memory tool passes in both forms and holds an id only", () => {
    ok({ memory: { kind: "saved", historyId: "h-1" } })
    ok({ memory: { kind: "suggested", proposalId: "p-1" } })
    bad({ memory: { kind: "saved" } })
    bad({ memory: { kind: "saved", historyId: "h-1", text: "Likes tea" } })
    bad({ memory: { kind: "suggested", proposalId: "" } })
    bad({ memory: { kind: "undone", historyId: "h-1" } })
    bad({ memory: "saved" })
  })

  test("the note of a change from the chat passes; a field that the agent may not change does not", () => {
    const change = (field: string, before: unknown, after: unknown) => ({
      settings: { changes: [{ field, before, after }] },
    })
    ok(change("name", "Ada", "Ava"))
    ok(change("role", "", "Writer"))
    ok(change("model", null, { accountId: "a", model: "m", effort: null }))
    ok(change("language", "system", "ko"))
    ok(change("reduceMotion", "on", "off"))
    ok({ settings: { changes: [{ field: "name", before: "A", after: "B" }], undone: false } })
    // The permission level is not a field of a change from the chat (spec 002).
    bad(change("permission", "ask_risky", "full"))
    bad(change("theme", "dark", "pink"))
    bad(change("face", { shape: 0, hue: 0 }, { shape: 6, hue: 0 }))
    bad(change("model", null, { accountId: "a", model: "m" }))
    bad(change("compactPlaces", false, "yes"))
    bad({ settings: { changes: [] } })
    bad({ settings: { changes: [{ field: "name", before: "A", after: "B" }], extra: 1 } })
    bad({ settings: { changes: [{ field: "name", before: "A", after: "B" }], undone: "yes" } })
  })
})

describe("memory in a sync (spec 008, 019)", () => {
  const field = (v: unknown) => ({ v, s: stamp })
  const itemOp = (extra: Record<string, unknown>) => ({
    k: "memory",
    i: "mem-9",
    o: "dev-b",
    f: {
      agentId: field("agent-1"),
      text: field("Likes tea"),
      source: field("user"),
      createdAt: field(NOW),
      updatedAt: field(NOW),
      ...Object.fromEntries(Object.entries(extra).map(([n, v]) => [n, field(v)])),
    },
  })

  test("an item that came from a proposal passes; an unknown source does not", () => {
    expect(parseOp(itemOp({ source: "proposal" }), NOW)).toBeDefined()
    expect(parseOp(itemOp({ source: "agent" }), NOW)).toBeDefined()
    expect(parseOp(itemOp({ source: "undo" }), NOW)).toBeUndefined()
  })

  test("the channel of a note is a field: an id or null passes; an empty id or a number does not", () => {
    expect(parseOp(itemOp({ channelId: "chan-1" }), NOW)).toBeDefined()
    expect(parseOp(itemOp({ channelId: null }), NOW)).toBeDefined()
    expect(parseOp(itemOp({ channelId: "" }), NOW)).toBeUndefined()
    expect(parseOp(itemOp({ channelId: 7 }), NOW)).toBeUndefined()
    // A computer of an older step sends no such field, and its item is a general item.
    expect(parseOp(itemOp({}), NOW)).toBeDefined()
  })

  test("a text typed by hand may be longer than the tool takes, up to the limit of the user", () => {
    expect(parseOp(itemOp({ text: "x".repeat(MEMORY_TEXT_MAX + 1) }), NOW)).toBeDefined()
    expect(parseOp(itemOp({ text: "x".repeat(MEMORY_USER_TEXT_MAX) }), NOW)).toBeDefined()
    expect(parseOp(itemOp({ text: "x".repeat(MEMORY_USER_TEXT_MAX + 1) }), NOW)).toBeUndefined()
    expect(parseOp(itemOp({ text: "   " }), NOW)).toBeUndefined()
  })

  test("the history, a proposal and the choice are not fields of an item or of an agent", () => {
    for (const name of ["history", "proposals", "memoryMode", "mode", "actor"]) {
      expect(parseOp(itemOp({ [name]: "x" }), NOW), name).toBeUndefined()
    }
    expect(Object.keys(KINDS.agent.fields)).not.toContain("memoryMode")
    expect(Object.keys(KINDS.memory.fields).sort()).toEqual(
      ["agentId", "channelId", "createdAt", "source", "text", "updatedAt"].sort(),
    )
  })
})

describe("the instruction history crosses with its agent (spec 002, 019)", () => {
  const version = (fields: Record<string, unknown>) => ({
    k: "iversion",
    i: "iv-1",
    o: "dev-b",
    f: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { v, s: stamp }])),
  })
  const good = { agentId: "agent-1", text: "Be brief.", source: "chat", createdAt: NOW }
  test("a version passes; a wrong source or text does not", () => {
    expect(parseOp(version(good), NOW)).toBeDefined()
    for (const source of ["profile", "device", "undo", "restore"])
      expect(parseOp(version({ ...good, source }), NOW)).toBeDefined()
    expect(parseOp(version({ ...good, source: "import" }), NOW)).toBeUndefined()
    expect(parseOp(version({ ...good, text: 5 }), NOW)).toBeUndefined()
    expect(parseOp(version({ ...good, createdAt: -1 }), NOW)).toBeUndefined()
  })
})

describe("the handbook crosses as versions, and the newest one is the handbook (spec 002, 019)", () => {
  const version = (fields: Record<string, unknown>) => ({
    k: "hversion",
    i: "hv-1",
    o: "dev-b",
    f: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { v, s: stamp }])),
  })
  const good = { text: "Answer in Korean.", source: "page", createdAt: NOW }
  test("a version passes in each of its four sources; a wrong source, text or time does not", () => {
    for (const source of ["page", "device", "restore", "import"])
      expect(parseOp(version({ ...good, source }), NOW)).toBeDefined()
    expect(parseOp(version({ ...good, source: "chat" }), NOW)).toBeUndefined()
    expect(parseOp(version({ ...good, text: 5 }), NOW)).toBeUndefined()
    expect(parseOp(version({ ...good, createdAt: -1 }), NOW)).toBeUndefined()
    expect(parseOp(version({ ...good, text: "x".repeat(40_001) }), NOW)).toBeUndefined()
    // The id of a server is not sent: each computer puts the version on its own server.
    expect(parseOp(version({ ...good, serverId: "s1" }), NOW)).toBeUndefined()
  })

  test("two versions made on two computers: the later one is the handbook and the other stays in the history", async () => {
    const rt = testRuntime({ name: "Handbook sync" })
    runtimes.push(rt)
    const run = rt.runtime.runPromise
    const db = await run(Database.use((d) => Effect.succeed(d)))
    const ctx = target(db, join(rt.dataDir, "hversion"))
    // The computer of the test has its own server (the helper adds it); the versions go there.
    const serverId = ctx.localServerId()
    // This computer wrote at time 2000. The other one wrote earlier (1000) and later (3000).
    await run(Handbook.use((h) => h.save(serverId, "Mine", "page")))
    db.run("UPDATE handbook_version SET created_at = 2000")
    expect(
      KINDS.hversion.create(ctx, "theirs-early", { ...good, text: "Early", createdAt: 1000 }),
    ).toBe(true)
    expect((await run(Handbook.use((h) => h.get(serverId)))).text).toBe("Mine")
    expect(
      KINDS.hversion.create(ctx, "theirs-late", { ...good, text: "Late", createdAt: 3000 }),
    ).toBe(true)
    const now = await run(Handbook.use((h) => h.get(serverId)))
    expect(now.text).toBe("Late")
    expect((await run(Handbook.use((h) => h.history(serverId)))).map((v) => v.text)).toEqual([
      "Late",
      "Mine",
      "Early",
    ])
    // The version sits on this computer's own server.
    expect(
      db.get<{ server_id: string }>(
        "SELECT server_id FROM handbook_version WHERE id = 'theirs-late'",
      )?.server_id,
    ).toBe(serverId)
    // A version never changes, and a removal takes it out of the history.
    KINDS.hversion.write(ctx, "theirs-late", { text: "Changed" })
    expect((await run(Handbook.use((h) => h.get(serverId)))).text).toBe("Late")
    KINDS.hversion.remove(ctx, "theirs-late")
    expect((await run(Handbook.use((h) => h.get(serverId)))).text).toBe("Mine")
  })

  test("the switch of an agent and the instructions of a channel are fields; a computer of an older step has none", async () => {
    expect(Object.keys(KINDS.agent.fields)).toContain("readHandbook")
    expect(Object.keys(KINDS.channel.fields)).toContain("instructions")
    expect(KINDS.agent.required).not.toContain("readHandbook")
    expect(KINDS.channel.required).not.toContain("instructions")
    const agentOp = (extra: Record<string, unknown>) => ({
      k: "agent",
      i: "a-1",
      o: "dev-b",
      f: Object.fromEntries(
        Object.entries({
          name: "Ada",
          role: "",
          instructions: "",
          face: { shape: 0, hue: 0 },
          model: null,
          archived: false,
          createdAt: NOW,
          ...extra,
        }).map(([k, v]) => [k, { v, s: stamp }]),
      ),
    })
    expect(parseOp(agentOp({ readHandbook: false }), NOW)).toBeDefined()
    expect(parseOp(agentOp({}), NOW)).toBeDefined()
    expect(parseOp(agentOp({ readHandbook: "no" }), NOW)).toBeUndefined()
    const channelOp = (extra: Record<string, unknown>) => ({
      k: "channel",
      i: "c-1",
      o: "dev-b",
      f: Object.fromEntries(
        Object.entries({
          name: "Team",
          topic: "",
          lead: null,
          members: [],
          createdAt: NOW,
          ...extra,
        }).map(([k, v]) => [k, { v, s: stamp }]),
      ),
    })
    expect(parseOp(channelOp({ instructions: "Use lists." }), NOW)).toBeDefined()
    expect(parseOp(channelOp({}), NOW)).toBeDefined()
    expect(parseOp(channelOp({ instructions: "x".repeat(4001) }), NOW)).toBeUndefined()
    expect(parseOp(channelOp({ instructions: 5 }), NOW)).toBeUndefined()
    // An agent from an older computer makes an agent that reads the handbook.
    const rt = testRuntime({ name: "Older step" })
    runtimes.push(rt)
    const db = await rt.runtime.runPromise(Database.use((d) => Effect.succeed(d)))
    const ctx = target(db, join(rt.dataDir, "older"))
    expect(
      KINDS.agent.create(ctx, "a-old", {
        name: "Old",
        role: "",
        instructions: "",
        face: { shape: 0, hue: 0 },
        model: null,
        archived: false,
        createdAt: NOW,
      }),
    ).toBe(true)
    expect(KINDS.agent.read(ctx, "a-old")?.fields.readHandbook).toBe(true)
    KINDS.agent.write(ctx, "a-old", { readHandbook: false })
    expect(KINDS.agent.read(ctx, "a-old")?.fields.readHandbook).toBe(false)
  })
})

describe("the accounts that sync carries (spec 006, 019)", () => {
  const field = (v: unknown) => ({ v, s: stamp })
  const accountOp = (vendor: unknown, extra: Record<string, unknown> = {}) => ({
    k: "account",
    i: "acc-1",
    o: "dev-b",
    f: {
      name: field("Work"),
      vendor: field(vendor),
      baseUrl: field(""),
      createdAt: field(NOW),
      ...Object.fromEntries(Object.entries(extra).map(([n, v]) => [n, field(v)])),
    },
  })
  const KINDS_OF_ACCOUNT = ["openai", "anthropic", "custom", ...RUNTIME_KINDS]

  test("one account of each kind passes the strict check; an unknown kind does not", () => {
    for (const vendor of KINDS_OF_ACCOUNT) {
      expect(parseOp(accountOp(vendor), NOW)).toBeDefined()
    }
    expect(parseOp(accountOp("gemini"), NOW)).toBeUndefined()
    expect(parseOp(accountOp(""), NOW)).toBeUndefined()
    expect(parseOp(accountOp(5), NOW)).toBeUndefined()
  })

  test("a separate sign-in, a key or a token is not a field of an account", () => {
    for (const name of ["signIn", "sign_in", "apiKey", "key", "token", "secret", "off"]) {
      expect(parseOp(accountOp("claude_code", { [name]: "abcdef123456" }), NOW)).toBeUndefined()
    }
  })

  test("an account with a separate sign-in leaves without it, and one that arrives has none", () => {
    const dir = join(testRuntime().dataDir, "accounts")
    const from = openDatabase(":memory:")
    const ctxFrom = target(from, dir)
    from.run(
      "INSERT INTO provider_account (id, kind, name, base_url, sign_in, created_at) VALUES ('acc-1', 'claude_code', 'Work', '', 'abcdefgh-1234', ?)",
      NOW,
    )
    const read = KINDS.account.read(ctxFrom, "acc-1")
    expect(Object.keys(read?.fields ?? {}).sort()).toEqual([
      "baseUrl",
      "createdAt",
      "name",
      "vendor",
    ])
    expect(JSON.stringify(read)).not.toContain("abcdefgh-1234")

    const to = openDatabase(":memory:")
    const ctxTo = target(to, dir)
    for (const vendor of KINDS_OF_ACCOUNT) {
      expect(
        KINDS.account.create(ctxTo, `acc-${vendor}`, {
          name: "Work",
          vendor,
          baseUrl: "",
          createdAt: NOW,
        }),
      ).toBe(true)
    }
    const rows = to.all<{ kind: string; sign_in: string | null; off: number }>(
      "SELECT kind, sign_in, off FROM provider_account ORDER BY kind",
    )
    expect(rows.length).toBe(KINDS_OF_ACCOUNT.length)
    // Nobody is signed in on this computer: no separate sign-in, and a vendor program is off.
    expect(rows.every((r) => r.sign_in === null)).toBe(true)
    expect(
      rows
        .filter((r) => r.off === 1)
        .map((r) => r.kind)
        .sort(),
    ).toEqual([...RUNTIME_KINDS].sort())
  })
})

describe("review of parts and blocked tasks cross with their task and channel (spec 004, 005, 019)", () => {
  const op = (kind: string, id: string, fields: Record<string, unknown>) => ({
    k: kind,
    i: id,
    o: "dev-a",
    f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
  })

  test("the setting Review parts is a field of the channel; a wrong value does not pass", async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds-review")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    // Off at first.
    const before = KINDS.channel.read(ctxA, a.channel.id)?.fields
    expect(before?.reviewParts).toBe(false)
    a.db.run("UPDATE channel SET review_parts = 1 WHERE id = ?", a.channel.id)
    const fields = copy(KINDS.channel.read(ctxA, a.channel.id)?.fields) as Fields
    expect(fields.reviewParts).toBe(true)
    expect(parseOp(op("channel", a.channel.id, fields), NOW)).toBeDefined()
    expect(
      parseOp(op("channel", a.channel.id, { ...fields, reviewParts: "yes" }), NOW),
    ).toBeUndefined()

    // The other computer makes the channel with the setting, and a change reaches it.
    const b = target(openDatabase(":memory:"), dir)
    expect(KINDS.channel.create(b, a.channel.id, { ...fields, members: [] })).toBe(true)
    expect(KINDS.channel.read(b, a.channel.id)?.fields.reviewParts).toBe(true)
    KINDS.channel.write(b, a.channel.id, { reviewParts: false })
    expect(KINDS.channel.read(b, a.channel.id)?.fields.reviewParts).toBe(false)
  })

  test("a channel from a computer that has no such setting counts as off", async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds-review-old")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const { reviewParts: _drop, ...older } = copy(
      KINDS.channel.read(ctxA, a.channel.id)?.fields,
    ) as Fields
    expect(parseOp(op("channel", "older", older), NOW)).toBeDefined()
    const b = target(openDatabase(":memory:"), dir)
    expect(KINDS.channel.create(b, "older", { ...older, members: [] })).toBe(true)
    expect(KINDS.channel.read(b, "older")?.fields.reviewParts).toBe(false)
  })

  test("a task in review or blocked passes with its reason; an unknown state does not", async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds-review-task")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const id = KINDS.task.ids(a.db, "", 10)[0] ?? ""
    const fields = copy(KINDS.task.read(ctxA, id)?.fields) as Fields
    for (const state of ["review", "blocked"]) {
      const blocked = state === "blocked"
      const next = {
        ...fields,
        state,
        error: blocked ? { code: "blocked", detail: "no access to the repository" } : null,
      }
      expect(parseOp(op("task", id, next), NOW), state).toBeDefined()
    }
    expect(parseOp(op("task", id, { ...fields, state: "approved" }), NOW)).toBeUndefined()

    // The state arrives on the other computer, which shows it.
    const b = target(openDatabase(":memory:"), dir)
    const agentFields = copy(KINDS.agent.read(ctxA, String(fields.agentId))?.fields) as Fields
    expect(KINDS.agent.create(b, String(fields.agentId), agentFields)).toBe(true)
    expect(KINDS.task.create(b, id, { ...fields, state: "review", error: null })).toBe(true)
    KINDS.task.write(b, id, {
      state: "blocked",
      error: { code: "blocked", detail: "no access to the repository" },
    })
    const row = KINDS.task.read(b, id)?.fields
    expect(row?.state).toBe("blocked")
    expect(row?.error).toEqual({ code: "blocked", detail: "no access to the repository" })
  })
})

describe("the outside mark of a place and the program mark of a message sync (spec 007, 019)", () => {
  const mark = { source: { kind: "teams" }, program: true }
  const op = (kind: string, id: string, fields: Record<string, unknown>) =>
    parseOp(
      {
        k: kind,
        i: id,
        o: "dev-a",
        f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
      },
      NOW,
    )

  test("the mark of a chat, a thread and a channel is read, arrives with the place, and a clear follows", async () => {
    const a = await source()
    const channelId = KINDS.channel.ids(a.db, "", 10)[0] ?? ""
    a.db.run("UPDATE agent SET outside_mark = ?", JSON.stringify(mark))
    a.db.run("UPDATE channel SET outside_mark = ?", JSON.stringify(mark))
    a.db.run(
      "INSERT INTO thread (id, agent_id, title, titled, created_at, outside_mark, updated_at) VALUES ('th-outside', ?, 'T', 1, ?, ?, ?)",
      a.ada.id,
      NOW,
      JSON.stringify({ source: { kind: "agent", name: "Bo" }, program: true }),
      NOW + 5,
    )
    const dir = join(testRuntime().dataDir, "kinds-outside")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const b = target(openDatabase(":memory:"), dir)

    const agent = copy(KINDS.agent.read(ctxA, a.ada.id)?.fields) as Fields
    expect(agent.outside).toEqual(mark)
    expect(KINDS.agent.create(b, a.ada.id, agent)).toBe(true)
    expect(KINDS.agent.read(b, a.ada.id)?.fields.outside).toEqual(mark)

    const thread = copy(KINDS.thread.read(ctxA, "th-outside")?.fields) as Fields
    expect(thread.outside).toEqual({ source: { kind: "agent", name: "Bo" }, program: true })
    expect(KINDS.thread.create(b, "th-outside", thread)).toBe(true)
    expect(KINDS.thread.read(b, "th-outside")?.fields.outside).toEqual(thread.outside)

    const channel = copy(KINDS.channel.read(ctxA, channelId)?.fields) as Fields
    expect(channel.outside).toEqual(mark)
    for (const member of channel.members as string[])
      if (member !== a.ada.id)
        KINDS.agent.create(b, member, copy(KINDS.agent.read(ctxA, member)?.fields) as Fields)
    expect(KINDS.channel.create(b, channelId, channel)).toBe(true)
    expect(KINDS.channel.read(b, channelId)?.fields.outside).toEqual(mark)

    // "Clear" on one computer writes through each place, and the thread time moves.
    KINDS.agent.write(b, a.ada.id, { outside: null })
    KINDS.channel.write(b, channelId, { outside: null })
    KINDS.thread.write(b, "th-outside", { outside: null })
    expect(KINDS.agent.read(b, a.ada.id)?.fields.outside).toBeNull()
    expect(KINDS.channel.read(b, channelId)?.fields.outside).toBeNull()
    expect(KINDS.thread.read(b, "th-outside")?.fields.outside).toBeNull()
    // A mark that changes moves the time of the thread, so sync stamps the change as new.
    expect(KINDS.thread.read(ctxA, "th-outside")?.wall).toBe(NOW + 5)
    // A new mark follows the same way.
    KINDS.agent.write(b, a.ada.id, { outside: mark })
    expect(KINDS.agent.read(b, a.ada.id)?.fields.outside).toEqual(mark)
  })

  test("a place from a computer of an older step has no mark field and makes a place with none", async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds-outside-old")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const b = target(openDatabase(":memory:"), dir)
    const { outside: _drop, ...older } = copy(KINDS.agent.read(ctxA, a.ada.id)?.fields) as Fields
    expect(KINDS.agent.create(b, a.ada.id, older)).toBe(true)
    expect(KINDS.agent.read(b, a.ada.id)?.fields.outside).toBeNull()
    // A write that does not name the mark keeps it.
    KINDS.agent.write(b, a.ada.id, { outside: mark })
    KINDS.agent.write(b, a.ada.id, { role: "New role" })
    expect(KINDS.agent.read(b, a.ada.id)?.fields.outside).toEqual(mark)
  })

  test("the sender of a message from Teams syncs with the message and its channel job (spec 028)", async () => {
    const a = await source()
    const channelId = KINDS.channel.ids(a.db, "", 10)[0] ?? ""
    a.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at, program_mark, teams_sender) VALUES ('m-1', ?, 'user', ?, 'done', ?, ?, 'Marta Kim')",
      a.ada.id,
      JSON.stringify([{ kind: "text", text: "From Teams" }]),
      NOW,
      JSON.stringify({ kind: "teams" }),
    )
    a.db.run(
      "INSERT INTO channel_message (id, channel_id, author, kind, parts, status, created_at, program_mark, teams_sender) VALUES ('c-1', ?, 'user', 'text', ?, 'done', ?, ?, 'Marta Kim')",
      channelId,
      JSON.stringify([{ kind: "text", text: "A job" }]),
      NOW,
      JSON.stringify({ kind: "teams" }),
    )
    const dir = join(testRuntime().dataDir, "kinds-teams-sender")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const b = target(openDatabase(":memory:"), dir)
    KINDS.agent.create(b, a.ada.id, copy(KINDS.agent.read(ctxA, a.ada.id)?.fields) as Fields)
    const channel = copy(KINDS.channel.read(ctxA, channelId)?.fields) as Fields
    for (const member of channel.members as string[])
      if (member !== a.ada.id)
        KINDS.agent.create(b, member, copy(KINDS.agent.read(ctxA, member)?.fields) as Fields)
    KINDS.channel.create(b, channelId, channel)

    const message = copy(KINDS.message.read(ctxA, "m-1")?.fields) as Fields
    expect(message.teamsSender).toBe("Marta Kim")
    expect(op("message", "m-1", message)).toBeDefined()
    expect(KINDS.message.create(b, "m-1", message)).toBe(true)
    expect(KINDS.message.read(b, "m-1")?.fields.teamsSender).toBe("Marta Kim")
    const job = copy(KINDS.cmessage.read(ctxA, "c-1")?.fields) as Fields
    expect(KINDS.cmessage.create(b, "c-1", job)).toBe(true)
    expect(KINDS.cmessage.read(b, "c-1")?.fields.teamsSender).toBe("Marta Kim")
    // A message of an older step has no sender, and a message of the user has none.
    const { teamsSender: _drop, ...older } = message
    expect(KINDS.message.create(b, "m-old", older)).toBe(true)
    expect(KINDS.message.read(b, "m-old")?.fields.teamsSender).toBeNull()
    // The strict check takes a text or null, and no long name.
    for (const bad of [5, { name: "x" }, "x".repeat(2000)])
      expect(op("message", "m-1", { ...message, teamsSender: bad })).toBeUndefined()
    expect(op("message", "m-1", { ...message, teamsSender: null })).toBeDefined()
  })

  test("the strict check takes only a source and a flag as the mark of a place", async () => {
    const a = await source()
    const dir = join(testRuntime().dataDir, "kinds-outside-check")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const fields = copy(KINDS.agent.read(ctxA, a.ada.id)?.fields) as Fields
    expect(op("agent", a.ada.id, { ...fields, outside: mark })).toBeDefined()
    expect(op("agent", a.ada.id, { ...fields, outside: null })).toBeDefined()
    for (const bad of [
      { source: { kind: "teams" } },
      { source: { kind: "teams" }, program: "yes" },
      { source: { kind: "teams", name: "x" }, program: true },
      { source: { kind: "other" }, program: true },
      { source: { kind: "teams" }, program: true, extra: 1 },
      "teams",
      5,
    ])
      expect(
        op("agent", a.ada.id, { ...fields, outside: bad }),
        JSON.stringify(bad),
      ).toBeUndefined()
  })

  test("the program mark of a message and of a channel message is read, arrives, and follows a write", async () => {
    const a = await source()
    const channelId = KINDS.channel.ids(a.db, "", 10)[0] ?? ""
    a.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at, program_mark) VALUES ('m-1', ?, 'user', ?, 'done', ?, ?)",
      a.ada.id,
      JSON.stringify([{ kind: "text", text: "From the program" }]),
      NOW,
      JSON.stringify({ kind: "teams" }),
    )
    a.db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES ('m-2', ?, 'user', ?, 'done', ?)",
      a.ada.id,
      JSON.stringify([{ kind: "text", text: "By the user" }]),
      NOW,
    )
    a.db.run(
      "INSERT INTO channel_message (id, channel_id, author, kind, parts, status, created_at, program_mark) VALUES ('c-1', ?, 'user', 'text', ?, 'done', ?, ?)",
      channelId,
      JSON.stringify([{ kind: "text", text: "A job" }]),
      NOW,
      JSON.stringify({ kind: "teams" }),
    )
    const dir = join(testRuntime().dataDir, "kinds-program-mark")
    const ctxA: Ctx = { ...target(openDatabase(":memory:"), dir), db: a.db, self: "dev-a" }
    const b = target(openDatabase(":memory:"), dir)
    KINDS.agent.create(b, a.ada.id, copy(KINDS.agent.read(ctxA, a.ada.id)?.fields) as Fields)
    const channel = copy(KINDS.channel.read(ctxA, channelId)?.fields) as Fields
    for (const member of channel.members as string[])
      if (member !== a.ada.id)
        KINDS.agent.create(b, member, copy(KINDS.agent.read(ctxA, member)?.fields) as Fields)
    KINDS.channel.create(b, channelId, channel)

    const marked = copy(KINDS.message.read(ctxA, "m-1")?.fields) as Fields
    const plain = copy(KINDS.message.read(ctxA, "m-2")?.fields) as Fields
    expect(marked.programMark).toEqual({ kind: "teams" })
    expect(plain.programMark).toBeNull()
    expect(op("message", "m-1", marked)).toBeDefined()
    expect(KINDS.message.create(b, "m-1", marked)).toBe(true)
    expect(KINDS.message.create(b, "m-2", plain)).toBe(true)
    expect(KINDS.message.read(b, "m-1")?.fields.programMark).toEqual({ kind: "teams" })
    expect(KINDS.message.read(b, "m-2")?.fields.programMark).toBeNull()

    const job = copy(KINDS.cmessage.read(ctxA, "c-1")?.fields) as Fields
    expect(job.programMark).toEqual({ kind: "teams" })
    expect(op("cmessage", "c-1", job)).toBeDefined()
    expect(KINDS.cmessage.create(b, "c-1", job)).toBe(true)
    expect(KINDS.cmessage.read(b, "c-1")?.fields.programMark).toEqual({ kind: "teams" })

    // The mark that a later write brings (the reply gets it when the turn starts).
    KINDS.message.write(b, "m-2", { programMark: { kind: "agent", name: "Bo" } })
    expect(KINDS.message.read(b, "m-2")?.fields.programMark).toEqual({ kind: "agent", name: "Bo" })
    KINDS.message.write(b, "m-2", { programMark: null })
    expect(KINDS.message.read(b, "m-2")?.fields.programMark).toBeNull()

    // A message from a computer of an older step has no field and makes a message with no mark.
    const { programMark: _drop, ...older } = marked
    expect(KINDS.message.create(b, "m-old", older)).toBe(true)
    expect(KINDS.message.read(b, "m-old")?.fields.programMark).toBeNull()
    // The strict check takes a source only.
    for (const bad of [{ kind: "other" }, "teams", { kind: "teams", name: "x" }, 5])
      expect(
        op("message", "m-1", { ...marked, programMark: bad }),
        JSON.stringify(bad),
      ).toBeUndefined()
  })
})
