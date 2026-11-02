import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { RUNTIME_KINDS, WORKFLOW_NOTES_MAX } from "@robot/shared"
import { Effect } from "effect"
import { Agents } from "../services/Agents.ts"
import { Channels } from "../services/Channels.ts"
import { Database, type DatabaseService, openDatabase } from "../services/Database.ts"
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
      a.create({ serverId, name: "Ada", role: "Helper", instructions: "Be brief.", model: null }),
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
        memberIds: [ada.id, bo.id],
        leadId: ada.id,
      }),
    ),
  )
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
    expect(parts.length).toBe(9)

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
    expect(b.db.all("SELECT id FROM agent")).toEqual([])
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
