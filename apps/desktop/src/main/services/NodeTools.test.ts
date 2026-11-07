import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PermissionLevel } from "@robot/shared"
import { Effect } from "effect"
import type { ApprovalRequest } from "../runtimes/types.ts"
import { ActionLog } from "./ActionLog.ts"
import type { CardReply } from "./Cards.ts"
import { Database } from "./Database.ts"
import { makeNodeTools, type NodeCard, type NodeToolContext, toolClock } from "./NodeTools.ts"
import { Platform } from "./Platform.ts"
import { Rules } from "./Rules.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

const LEVELS: PermissionLevel[] = ["read_only", "ask_all", "ask_risky", "ask_unsure", "full"]

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const flow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Tools" })))
  const rules = await run(Rules.use((x) => Effect.succeed(x)))
  const actionLog = await run(ActionLog.use((x) => Effect.succeed(x)))
  const platform = await run(Platform.use((x) => Effect.succeed(x)))
  const tools = makeNodeTools({ rules, actionLog, platform })
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "robot-tools-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "robot-outside-")))
  const cards: NodeCard[] = []
  let answer: CardReply["answer"] = "deny"
  const controller = new AbortController()
  const make = (
    level: PermissionLevel,
    marks: NodeToolContext["marks"] = { outside: null, program: false, sensitive: null },
  ): NodeToolContext => ({
    workflowId: flow.id,
    workspace,
    level,
    signal: controller.signal,
    taskId: "task-1",
    marks,
    ask: async (card) => {
      cards.push(card)
      return { answer } as CardReply
    },
    onMarks: () => {},
  })
  const log = () =>
    run(
      Database.use((d) =>
        Effect.sync(() =>
          d.all<{
            kind: string
            access: string | null
            target: string
            decided_by: string
            result: string
          }>("SELECT kind, access, target, decided_by, result FROM action_log ORDER BY rowid"),
        ),
      ),
    )
  return {
    ...t,
    run,
    flow,
    rules,
    platform,
    tools,
    workspace,
    outside,
    cards,
    controller,
    make,
    log,
    answer: (a: CardReply["answer"]) => {
      answer = a
    },
    deny: (path: string) =>
      run(rules.add({ workflowId: flow.id, kind: "file", text: path, decision: "deny" })),
    call: (ctx: NodeToolContext, name: string, args: Record<string, unknown>) =>
      tools.execute(ctx, { id: `c-${Math.random()}`, name, input: JSON.stringify(args) }),
  }
}

describe("search_files obeys the rules of read_file (spec 007)", () => {
  test("a Deny rule hides the file at every level, and read_file refuses it too", async () => {
    for (const level of LEVELS) {
      const t = await setup()
      mkdirSync(join(t.workspace, "private"))
      writeFileSync(join(t.workspace, "private", "p.txt"), "DENIED-CONTENT\n")
      writeFileSync(join(t.workspace, "open.txt"), "DENIED-CONTENT is also here\n")
      await t.deny(join(t.workspace, "private"))
      const ctx = t.make(level)
      // "Ask for everything" asks for the search itself: the user allows it.
      t.answer("allow")
      const read = await t.call(ctx, "read_file", { path: "private/p.txt" })
      expect(read.failed).toBe(true)
      expect(read.output).not.toContain("DENIED-CONTENT")
      const found = await t.call(ctx, "search_files", { query: "DENIED-CONTENT" })
      expect(found.failed).toBe(false)
      expect(found.output).toContain("open.txt:1")
      expect(found.output).not.toContain("private")
      expect(found.output).not.toContain("p.txt")
      // The log has an entry for the search, and a refused entry for the hidden folder.
      const entries = await t.log()
      expect(
        entries.some((e) => e.kind === "file" && e.result === "ran" && e.target === t.workspace),
      ).toBe(true)
      expect(
        entries.some(
          (e) =>
            e.result === "refused" &&
            e.decided_by === "deny_rule" &&
            e.target === join(t.workspace, "private"),
        ),
      ).toBe(true)
    }
  })

  test("a Deny rule on the whole folder refuses the search", async () => {
    const t = await setup()
    writeFileSync(join(t.workspace, "a.txt"), "needle\n")
    await t.deny(t.workspace)
    const found = await t.call(t.make("full"), "search_files", { query: "needle" })
    expect(found.failed).toBe(true)
    expect(found.notRun).toBe(true)
    expect(found.output).not.toContain("a.txt")
    expect((await t.log()).at(-1)).toMatchObject({ result: "refused", decided_by: "deny_rule" })
  })

  test("a link that leads out of the folder is not followed", async () => {
    const t = await setup()
    writeFileSync(join(t.outside, "secret.txt"), "OUTSIDE-NEEDLE\n")
    symlinkSync(t.outside, join(t.workspace, "link"))
    symlinkSync(join(t.outside, "secret.txt"), join(t.workspace, "file-link.txt"))
    writeFileSync(join(t.workspace, "own.txt"), "no match\n")
    const found = await t.call(t.make("full"), "search_files", { query: "OUTSIDE-NEEDLE" })
    expect(found.output).toBe("No matches.")
  })

  test("Stop interrupts a search at once", async () => {
    const t = await setup()
    for (let d = 0; d < 40; d++) {
      mkdirSync(join(t.workspace, `d${d}`))
      for (let f = 0; f < 50; f++) writeFileSync(join(t.workspace, `d${d}`, `f${f}.txt`), "line\n")
    }
    const ctx = t.make("full")
    const started = Date.now()
    const search = t.call(ctx, "search_files", { query: "never-found" })
    t.controller.abort()
    await expect(search).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3000)
    expect((await t.log()).at(-1)).toMatchObject({ kind: "file", result: "stopped" })
  })

  test("a file in a credential place makes the task hold a sensitive read, a hit or not", async () => {
    const t = await setup()
    mkdirSync(join(t.platform.homeDir, ".ssh"), { recursive: true })
    writeFileSync(join(t.platform.homeDir, ".ssh", "id_test"), "KEYDATA\n")
    const ctx = { ...t.make("full"), workspace: t.platform.homeDir }
    await t.call(ctx, "search_files", { query: "nothing-here" })
    expect(ctx.marks.sensitive).not.toBeNull()
  })
})

describe("paths and links (spec 007)", () => {
  test("a path with ../ that leaves the folder is a risky step: it asks, and Deny reads nothing", async () => {
    const t = await setup()
    writeFileSync(join(t.outside, "note.txt"), "OUT-OF-FOLDER\n")
    const ctx = t.make("ask_risky")
    const read = await t.call(ctx, "read_file", {
      path: `../${t.outside.split("/").at(-1)}/note.txt`,
    })
    expect(t.cards).toHaveLength(1)
    expect(read.failed).toBe(true)
    expect(read.output).not.toContain("OUT-OF-FOLDER")
    const write = await t.call(ctx, "write_file", {
      path: `../${t.outside.split("/").at(-1)}/new.txt`,
      content: "x",
    })
    expect(write.failed).toBe(true)
    expect(existsSync(join(t.outside, "new.txt"))).toBe(false)
  })

  test("a link out of the folder is outside for read and for write", async () => {
    const t = await setup()
    writeFileSync(join(t.outside, "secret.txt"), "VIA-LINK\n")
    symlinkSync(t.outside, join(t.workspace, "link"))
    const ctx = t.make("ask_risky")
    const read = await t.call(ctx, "read_file", { path: "link/secret.txt" })
    expect(t.cards).toHaveLength(1)
    expect(read.output).not.toContain("VIA-LINK")
    const write = await t.call(ctx, "write_file", { path: "link/made.txt", content: "x" })
    expect(t.cards).toHaveLength(2)
    expect(write.failed).toBe(true)
    expect(existsSync(join(t.outside, "made.txt"))).toBe(false)
    // The user allows once: the step runs, as the card said.
    t.answer("allow")
    const allowed = await t.call(ctx, "write_file", { path: "link/made.txt", content: "x" })
    expect(allowed.failed).toBe(false)
    expect(readFileSync(join(t.outside, "made.txt"), "utf8")).toBe("x")
  })

  test("read_file does not load a huge file whole", async () => {
    const t = await setup()
    writeFileSync(join(t.workspace, "big.txt"), "a".repeat(5_000_000))
    const read = await t.call(t.make("full"), "read_file", { path: "big.txt" })
    expect(read.failed).toBe(false)
    expect(read.output.length).toBeLessThan(110_000)
    expect(read.output).toContain("[cut:")
  })
})

describe("Read only (spec 007)", () => {
  test("a write and a command do not run: the file is not written", async () => {
    const t = await setup()
    const ctx = t.make("read_only")
    const write = await t.call(ctx, "write_file", { path: "w.txt", content: "x" })
    expect(write).toMatchObject({ failed: true, refused: "read_only", notRun: true })
    expect(existsSync(join(t.workspace, "w.txt"))).toBe(false)
    const command = await t.call(ctx, "run_command", { command: "touch made-by-command.txt" })
    expect(command).toMatchObject({ failed: true, refused: "read_only", notRun: true })
    expect(existsSync(join(t.workspace, "made-by-command.txt"))).toBe(false)
    expect(t.cards).toHaveLength(0)
    expect((await t.log()).map((e) => [e.kind, e.result, e.decided_by])).toEqual([
      ["file", "refused", "level"],
      ["shell", "refused", "level"],
    ])
  })

  test("an Allow rule does not open a step that Read only refuses", async () => {
    const t = await setup()
    await t.run(
      t.rules.add({
        workflowId: t.flow.id,
        kind: "shell",
        text: "touch allowed.txt",
        decision: "allow",
      }),
    )
    const out = await t.call(t.make("read_only"), "run_command", { command: "touch allowed.txt" })
    expect(out.refused).toBe("read_only")
    expect(existsSync(join(t.workspace, "allowed.txt"))).toBe(false)
  })
})

describe("fetch and marks (spec 007)", () => {
  test("a fetch gives the outside mark with the host of the page", async () => {
    const t = await setup()
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hello") })
    try {
      t.answer("allow")
      const ctx = t.make("ask_risky")
      const out = await t.call(ctx, "fetch_url", { url: `http://127.0.0.1:${server.port}/` })
      expect(out.failed).toBe(false)
      expect(out.output).toContain("hello")
      // A local address is a hard step: it asked.
      expect(t.cards).toHaveLength(1)
      expect(ctx.marks.outside).toEqual({ kind: "page", host: "127.0.0.1" })
    } finally {
      server.stop(true)
    }
  })

  test("the address that is never allowed is refused at Full access, by the app", async () => {
    const t = await setup()
    const ctx = t.make("full")
    const out = await t.call(ctx, "fetch_url", { url: "http://169.254.169.254/latest/" })
    expect(out).toMatchObject({ failed: true, notRun: true, refused: "address" })
    expect(t.cards).toHaveLength(0)
    expect(ctx.marks.outside).toBeNull()
    expect((await t.log()).at(-1)).toMatchObject({
      kind: "web",
      result: "refused",
      decided_by: "app",
    })
  })
})

describe("Stop ends a command with its children (spec 005)", () => {
  test("the process of a command is gone after Stop", async () => {
    const t = await setup()
    const pidFile = join(t.workspace, "pid.txt")
    const ctx = t.make("full")
    const run = t.call(ctx, "run_command", { command: `echo $$ > pid.txt; exec sleep 30` })
    const until = Date.now() + 5000
    while (!existsSync(pidFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(pid).toBeGreaterThan(1)
    t.controller.abort()
    await run.catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    expect(() => process.kill(pid, 0)).toThrow()
    toolClock.commandMs = 120_000
  })
})

describe("a step of a vendor program (spec 007)", () => {
  const shell = (command: string, risky = false): ApprovalRequest => ({
    callId: "p1",
    risky,
    key: `run_command:${command.split(" ")[0]}`,
    summary: command,
    step: { kind: "shell", command },
  })

  test("a write to a control place asks at Ask for risky steps, as for the tools of the app", async () => {
    const t = await setup()
    t.answer("allow")
    const ctx = t.make("ask_risky")
    const zshrc = join(t.platform.homeDir, ".zshrc")
    const allowed = await t.tools.approval(ctx, shell(`echo alias x=y >> ${zshrc}`))
    expect(allowed).toBe(true)
    expect(t.cards).toHaveLength(1)
    // A harmless command runs with no card.
    await t.tools.approval(ctx, shell("echo hello"))
    expect(t.cards).toHaveLength(1)
    // A file write to the same place asks too.
    await t.tools.approval(ctx, {
      callId: "p2",
      risky: false,
      key: "write_file",
      summary: `Write: ${zshrc}`,
      step: { kind: "file", path: zshrc },
    })
    expect(t.cards).toHaveLength(2)
  })

  test("every guarded step has an entry: allowed, denied on a card, rule-allowed, rule-denied", async () => {
    const t = await setup()
    const ctx = t.make("ask_all")
    t.answer("allow")
    await t.tools.approval(ctx, shell("echo one"))
    t.answer("deny")
    expect(await t.tools.approval(ctx, shell("echo two"))).toBe(false)
    await t.run(
      t.rules.add({ workflowId: t.flow.id, kind: "shell", text: "echo three", decision: "allow" }),
    )
    expect(await t.tools.approval(ctx, shell("echo three"))).toBe(true)
    await t.run(
      t.rules.add({ workflowId: t.flow.id, kind: "shell", text: "echo four", decision: "deny" }),
    )
    expect(await t.tools.approval(ctx, shell("echo four"))).toBe(false)
    expect((await t.log()).map((e) => [e.target, e.result, e.decided_by])).toEqual([
      ["echo one", "ran", "user"],
      ["echo two", "refused", "user"],
      ["echo three", "ran", "allow_rule"],
      ["echo four", "refused", "deny_rule"],
    ])
  })

  test("Read only refuses a step that the program asks about, with an entry", async () => {
    const t = await setup()
    const ctx = t.make("read_only")
    expect(await t.tools.approval(ctx, shell("touch x"))).toBe(false)
    expect(
      await t.tools.approval(ctx, {
        callId: "p3",
        risky: false,
        key: "read_file",
        summary: "Read: a.txt",
        step: { kind: "file", path: join(t.workspace, "a.txt") },
      }),
    ).toBe(true)
    expect((await t.log()).map((e) => [e.result, e.decided_by])).toEqual([
      ["refused", "level"],
      ["ran", "level"],
    ])
  })

  test("a fetch of the address that is never allowed is refused for a program too", async () => {
    const t = await setup()
    const ctx = t.make("full")
    const refused = await t.tools.approval(ctx, {
      callId: "p4",
      risky: false,
      key: "fetch_url",
      summary: "http://169.254.169.254/",
      step: { kind: "web", host: "169.254.169.254" },
    })
    expect(refused).toBe(false)
    expect((await t.log()).at(-1)).toMatchObject({ result: "refused", decided_by: "app" })
  })

  test("tool steps set the marks: outside content, and a sensitive read", async () => {
    const t = await setup()
    const ctx = t.make("full")
    t.tools.observe(ctx, {
      id: "a",
      name: "Read",
      input: JSON.stringify({ file_path: join(t.workspace, "in.txt") }),
    })
    expect(ctx.marks.outside).toBeNull()
    t.tools.observe(ctx, {
      id: "b",
      name: "Read",
      input: JSON.stringify({ file_path: join(t.platform.homeDir, ".ssh", "id_rsa") }),
    })
    expect(ctx.marks.sensitive).not.toBeNull()
    expect(ctx.marks.outside).not.toBeNull()
    const web = t.make("full")
    t.tools.observe(web, {
      id: "c",
      name: "WebFetch",
      input: JSON.stringify({ url: "https://example.com/page" }),
    })
    expect(web.marks.outside).toEqual({ kind: "page", host: "example.com" })
    const unknown = t.make("full")
    t.tools.observe(unknown, { id: "d", name: "mystery_tool", input: "{}" })
    expect(unknown.marks.outside).not.toBeNull()
    const mcp = t.make("full")
    t.tools.observe(mcp, { id: "e", name: "docs.search", input: "{}" })
    expect(mcp.marks.outside).toEqual({ kind: "connection", connection: "docs", tool: "search" })
    const quiet = t.make("full")
    t.tools.observe(quiet, { id: "f", name: "TodoWrite", input: "{}" })
    expect(quiet.marks.outside).toBeNull()
  })

  test("a tool step that no card decided gets an entry; one that a card decided gets none twice", async () => {
    const t = await setup()
    const ctx = t.make("ask_risky")
    // The program asked for this command, and the app answered.
    await t.tools.approval(ctx, shell("echo asked"))
    t.tools.observe(ctx, {
      id: "x1",
      name: "Bash",
      input: JSON.stringify({ command: "echo asked" }),
    })
    // This one the program ran with no question.
    t.tools.observe(ctx, {
      id: "x2",
      name: "Bash",
      input: JSON.stringify({ command: "echo free" }),
    })
    expect((await t.log()).map((e) => [e.target, e.decided_by])).toEqual([
      ["echo asked", "level"],
      ["echo free", "level"],
    ])
  })
})
