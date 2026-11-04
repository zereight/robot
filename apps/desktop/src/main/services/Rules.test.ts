import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  newTurnMark,
  type PermissionLevel,
  RULES_MAX,
  type RuleInput,
  type RuleStep,
  type ToolAsk,
} from "@robot/shared"
import { Effect } from "effect"
import type { ApprovalRequest } from "../runtimes/types.ts"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { CurrentActor } from "./actor.ts"
import { Database } from "./Database.ts"
import { Rules } from "./Rules.ts"
import { Servers } from "./Servers.ts"
import { type ToolContext, Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

/** One app with a stand-in data folder and home folder, an agent, and a way to answer its cards. */
const harness = async (permission: PermissionLevel = "ask_risky") => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const make = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({ serverId: local.id, name, role: "", instructions: "", model: null }),
      ),
    )
  const agent = await make("Ada")
  await run(Agents.use((a) => a.update(agent.id, { permission })))
  mkdirSync(agent.workspace, { recursive: true })
  const asks: ToolAsk[] = []
  const events: string[] = []
  /** What the next card gets as its answer, and which device answers (none = this computer). */
  const reply: { answer: string; by: string | null } = { answer: "allow", by: null }
  const context = (over: Partial<ToolContext> = {}): ToolContext => ({
    agentId: agent.id,
    workspace: agent.workspace,
    permission,
    signal: new AbortController().signal,
    onWaiting: (callId, ask) => {
      if (!ask) return
      asks.push(ask)
      const send = Tools.use((x) => x.respond(agent.id, callId, reply.answer))
      void run(
        reply.by
          ? send.pipe(
              Effect.provideService(CurrentActor, { id: `device-${reply.by}`, name: reply.by }),
            )
          : send,
      )
    },
    onMemory: () => {},
    onKnowledge: () => {},
    onRefused: (callId, why) => events.push(`refused:${callId}:${why}`),
    onRuleAllowed: (callId) => events.push(`allowed:${callId}`),
    knowledgeChanges: { count: 0 },
    turn: newTurnMark("user"),
    taskId: null,
    ...over,
  })
  let n = 0
  const exec = (name: string, args: object, over: Partial<ToolContext> = {}) =>
    run(
      Tools.use((x) =>
        Effect.promise(() =>
          x.execute(context(over), { id: `c${++n}`, name, input: JSON.stringify(args) }),
        ),
      ),
    )
  const rule = (input: Partial<RuleInput> & Pick<RuleInput, "kind" | "text">) =>
    run(Rules.use((r) => r.add({ agentId: agent.id, decision: "allow", ...input } as RuleInput)))
  const log = () => run(ActionLog.use((l) => l.list()))
  const db = () => run(Database.use((d) => Effect.succeed(d)))
  return { t, run, local, agent, make, asks, events, reply, context, exec, rule, log, db }
}

describe("the list of rules", () => {
  test("rules come newest first, and the list filters by agent and by decision", async () => {
    const h = await harness()
    const other = await h.make("Bo")
    let now = 1000
    const real = Date.now
    Date.now = () => now++
    try {
      await h.rule({ kind: "shell", text: "ls" })
      await h.rule({ kind: "web", text: "example.com", decision: "deny" })
      await h.run(
        Rules.use((r) => r.add({ agentId: null, kind: "shell", text: "pwd", decision: "allow" })),
      )
      await h.run(
        Rules.use((r) =>
          r.add({ agentId: other.id, kind: "shell", text: "cat", decision: "deny" }),
        ),
      )
    } finally {
      Date.now = real
    }
    const list = (filter = {}) => h.run(Rules.use((r) => r.list(filter)))
    expect((await list()).map((r) => r.text)).toEqual(["cat", "pwd", "example.com", "ls"])
    expect((await list({ agentId: h.agent.id })).map((r) => r.text)).toEqual(["example.com", "ls"])
    expect((await list({ agentId: null })).map((r) => r.text)).toEqual(["pwd"])
    expect((await list({ decision: "deny" })).map((r) => r.text)).toEqual(["cat", "example.com"])
    expect((await list({ agentId: h.agent.id, decision: "allow" })).map((r) => r.text)).toEqual([
      "ls",
    ])
  })

  test("a rule is edited in place and deleted", async () => {
    const h = await harness()
    const made = await h.rule({ kind: "shell", text: "ls" })
    expect(made).toMatchObject({ source: "list", decision: "allow", readable: true })
    const changed = await h.run(
      Rules.use((r) =>
        r.update(made.id, { agentId: null, kind: "web", text: "Example.com", decision: "deny" }),
      ),
    )
    expect(changed).toMatchObject({
      id: made.id,
      agentId: null,
      kind: "web",
      text: "example.com",
      decision: "deny",
      createdAt: made.createdAt,
    })
    await h.run(Rules.use((r) => r.remove(made.id)))
    expect(await h.run(Rules.use((r) => r.list()))).toEqual([])
    // A rule that was deleted already is not an error.
    await h.run(Rules.use((r) => r.remove(made.id)))
    const missing = await h.run(
      Rules.use((r) =>
        r.update("none", { agentId: null, kind: "shell", text: "x", decision: "allow" }),
      ).pipe(Effect.flip),
    )
    expect(missing).toMatchObject({ code: "rule_not_found" })
  })

  test("a rule equal to one that exists is refused; another decision or agent is not equal", async () => {
    const h = await harness()
    const other = await h.make("Bo")
    await h.rule({ kind: "web", text: "example.com" })
    const code = async (input: RuleInput) =>
      (await h.run(Rules.use((r) => r.add(input)).pipe(Effect.flip))).code
    expect(
      await code({ agentId: h.agent.id, kind: "web", text: "Example.com", decision: "allow" }),
    ).toBe("rule_duplicate")
    // The edit of a rule into another rule is refused as well.
    const second = await h.rule({ kind: "web", text: "other.com" })
    expect(
      (
        await h.run(
          Rules.use((r) =>
            r.update(second.id, {
              agentId: h.agent.id,
              kind: "web",
              text: "example.com",
              decision: "allow",
            }),
          ).pipe(Effect.flip),
        )
      ).code,
    ).toBe("rule_duplicate")
    await h.rule({ kind: "web", text: "example.com", decision: "deny" })
    await h.run(
      Rules.use((r) =>
        r.add({ agentId: other.id, kind: "web", text: "example.com", decision: "allow" }),
      ),
    )
    await h.run(
      Rules.use((r) =>
        r.add({ agentId: null, kind: "web", text: "example.com", decision: "allow" }),
      ),
    )
    expect(await h.run(Rules.use((r) => r.list()))).toHaveLength(5)
  })

  test("the match text holds 1 to 500 characters", async () => {
    const h = await harness()
    const code = async (text: string) =>
      (
        await h.run(
          Rules.use((r) => r.add({ agentId: null, kind: "shell", text, decision: "allow" })).pipe(
            Effect.flip,
          ),
        )
      ).code
    expect(await code("")).toBe("rule_text_invalid")
    expect(await code("x".repeat(501))).toBe("rule_text_invalid")
    await h.run(
      Rules.use((r) =>
        r.add({ agentId: null, kind: "shell", text: "x".repeat(500), decision: "allow" }),
      ),
    )
  })

  test("a server holds at most 500 rules", async () => {
    const h = await harness()
    const db = await h.db()
    for (let i = 0; i < RULES_MAX; i++)
      db.run(
        `INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
         VALUES (?, ?, NULL, 'shell', ?, NULL, 'allow', 'list', ?)`,
        `r${i}`,
        h.local.id,
        `cmd${i}`,
        i,
      )
    const refused = await h.run(
      Rules.use((r) =>
        r.add({ agentId: null, kind: "shell", text: "one more", decision: "allow" }),
      ).pipe(Effect.flip),
    )
    expect(refused).toMatchObject({ code: "rules_full" })
    // The card of a step offers no "Always allow" when no rule can be saved.
    h.reply.answer = "always"
    await h.exec("run_command", { command: `rm "${join(h.t.dataDir, "none.txt")}"` })
    expect(h.asks[0]).toMatchObject({ kind: "approval", once: true })
    expect(await h.run(Rules.use((r) => r.list()))).toHaveLength(RULES_MAX)
  })

  test("deleting an agent deletes its rules, and a rule for all agents stays", async () => {
    const h = await harness()
    const other = await h.make("Bo")
    await h.rule({ kind: "shell", text: "ls" })
    await h.run(
      Rules.use((r) => r.add({ agentId: other.id, kind: "shell", text: "pwd", decision: "deny" })),
    )
    await h.run(
      Rules.use((r) => r.add({ agentId: null, kind: "shell", text: "date", decision: "allow" })),
    )
    await h.run(Agents.use((a) => a.archive(h.agent.id)))
    await h.run(Agents.use((a) => a.remove(h.agent.id)))
    expect((await h.run(Rules.use((r) => r.list()))).map((r) => r.text).sort()).toEqual([
      "date",
      "pwd",
    ])
  })

  test("a rule for an agent that does not exist is refused", async () => {
    const h = await harness()
    const refused = await h.run(
      Rules.use((r) =>
        r.add({ agentId: "nobody", kind: "shell", text: "ls", decision: "allow" }),
      ).pipe(Effect.flip),
    )
    expect(refused).toMatchObject({ code: "rule_agent_gone" })
  })
})

describe("what a rule matches, with real paths", () => {
  test("a folder rule holds for a path inside it, also through a link", async () => {
    const h = await harness("full")
    const real = join(h.t.dataDir, "private")
    const link = join(h.t.dataDir, "shortcut")
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    writeFileSync(join(real, "a.txt"), "old")
    await h.rule({ kind: "file", text: real, decision: "deny" })
    // The path of the step goes through a link, and the rule names the real place.
    const viaLink = await h.exec("write_file", { path: join(link, "a.txt"), content: "new" })
    expect(viaLink).toMatchObject({ failed: true, notRun: true, refused: "rule" })
    expect(readFileSync(join(real, "a.txt"), "utf8")).toBe("old")
    // A place that is not inside the folder is not denied.
    const sibling = join(h.t.dataDir, "private-two")
    mkdirSync(sibling)
    const ok = await h.exec("write_file", { path: join(sibling, "b.txt"), content: "ok" })
    expect(ok.failed).toBe(false)
    expect(readFileSync(join(sibling, "b.txt"), "utf8")).toBe("ok")
  })

  test("a rule for the link names the real place too", async () => {
    const h = await harness("full")
    const real = join(h.t.dataDir, "private")
    const link = join(h.t.dataDir, "shortcut")
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    await h.rule({ kind: "file", text: link, decision: "deny" })
    const direct = await h.exec("write_file", { path: join(real, "a.txt"), content: "x" })
    expect(direct).toMatchObject({ refused: "rule" })
    expect(existsSync(join(real, "a.txt"))).toBe(false)
  })

  test("a file that does not exist yet is checked by its folder", async () => {
    const h = await harness("full")
    const real = join(h.t.dataDir, "private")
    const link = join(h.t.dataDir, "shortcut")
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link)
    await h.rule({ kind: "file", text: real, decision: "deny" })
    const made = await h.exec("write_file", { path: join(link, "deep", "new.txt"), content: "x" })
    expect(made).toMatchObject({ refused: "rule" })
    expect(existsSync(join(real, "deep"))).toBe(false)
  })
})

describe("the order of the decisions for a step", () => {
  test("a Deny rule refuses at Full access: the card says so, the file stays, the agent goes on", async () => {
    const h = await harness("full")
    const folder = join(h.t.dataDir, "locked")
    mkdirSync(folder)
    writeFileSync(join(folder, "a.txt"), "keep")
    const rule = await h.rule({ kind: "file", text: folder, decision: "deny" })
    const outcome = await h.exec("write_file", { path: join(folder, "a.txt"), content: "changed" })
    expect(outcome).toMatchObject({ failed: true, notRun: true, refused: "rule" })
    expect(outcome.output).toContain("Denied by a rule")
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("keep")
    expect(h.asks).toEqual([])
    expect((await h.log()).length).toBe(0)
    // The next step of the turn runs.
    const next = await h.exec("run_command", { command: "echo go" })
    expect(next).toMatchObject({ failed: false })
    expect(rule.id).toBeTruthy()
  })

  test("a Deny rule and an Allow rule that both match: the step is refused", async () => {
    const h = await harness("ask_risky")
    await h.rule({ kind: "shell", text: "echo", decision: "allow" })
    await h.rule({ kind: "shell", text: "echo", decision: "deny" })
    const outcome = await h.exec("run_command", { command: "echo hi" })
    expect(outcome).toMatchObject({ failed: true, refused: "rule" })
    expect(h.asks).toEqual([])
  })

  test("Read only comes first: an Allow rule does not open a step that it refuses", async () => {
    const h = await harness("read_only")
    await h.rule({ kind: "shell", text: "echo" })
    const outcome = await h.exec("run_command", { command: "echo hi" })
    expect(outcome).toMatchObject({ failed: true, refused: "read_only" })
    expect(h.events).toEqual([])
  })

  test("an Allow rule lets a step run where the level would ask, and the card says so", async () => {
    const h = await harness("ask_all")
    await h.rule({ kind: "shell", text: "echo" })
    const outcome = await h.exec("run_command", { command: "echo hello" })
    expect(outcome.output).toContain("hello")
    expect(h.asks).toEqual([])
    expect(h.events).toEqual(["allowed:c1"])
    // A step that no rule meets still asks at this level.
    await h.exec("run_command", { command: "pwd" })
    expect(h.asks).toHaveLength(1)
  })

  test("an Allow rule for example.com does not let the agent fetch www.example.com", async () => {
    const h = await harness("ask_all")
    await h.rule({ kind: "web", text: "example.com" })
    h.reply.answer = "deny"
    const same = await h.exec("fetch_url", { url: "https://example.com/" })
    // No card; the look-up of the stand-in network fails, which is not a question for the user.
    expect(h.asks).toEqual([])
    expect(same.output).not.toContain("denied")
    const www = await h.exec("fetch_url", { url: "https://www.example.com/" })
    expect(h.asks).toHaveLength(1)
    expect(www.output).toContain("denied")
  })

  test("a Deny rule for a host refuses the fetch before any question", async () => {
    const h = await harness("ask_all")
    await h.rule({ kind: "web", text: "example.com", decision: "deny" })
    const outcome = await h.exec("fetch_url", { url: "https://example.com/" })
    expect(outcome).toMatchObject({ failed: true, notRun: true, refused: "rule" })
    expect(h.asks).toEqual([])
  })

  test("an Allow rule for a command does not cover a command that starts another command", async () => {
    const h = await harness("ask_all")
    await h.rule({ kind: "shell", text: "echo" })
    h.reply.answer = "deny"
    const chained = await h.exec("run_command", { command: "echo a ; echo b" })
    expect(chained.output).toContain("denied")
    expect(h.asks).toHaveLength(1)
  })

  test("an Allow rule for all agents opens the step of any agent", async () => {
    const h = await harness("ask_all")
    await h.run(
      Rules.use((r) => r.add({ agentId: null, kind: "shell", text: "echo", decision: "allow" })),
    )
    const outcome = await h.exec("run_command", { command: "echo shared" })
    expect(outcome.output).toContain("shared")
    expect(h.asks).toEqual([])
  })
})

describe("Always allow for this agent", () => {
  test("it saves one Allow rule, the same step runs next time, and the log has two entries", async () => {
    const h = await harness("ask_risky")
    h.reply.answer = "always"
    // A command that deletes outside the workspace is risky, so it asks at this level.
    const command = `rm -f "${join(h.t.dataDir, "gone.txt")}"`
    await h.exec("run_command", { command })
    expect(h.asks[0]).toMatchObject({ kind: "approval", summary: command })
    expect((h.asks[0] as { once?: boolean }).once).toBeUndefined()
    const rules = await h.run(Rules.use((r) => r.list()))
    expect(rules).toMatchObject([
      { agentId: h.agent.id, kind: "shell", text: command, decision: "allow", source: "card" },
    ])
    h.asks.length = 0
    await h.exec("run_command", { command })
    expect(h.asks).toEqual([])
    expect(h.events).toContain("allowed:c2")
    // The log has the two entries: the card first, then the rule. The watch of the task writes
    // them; here the decisions are read as the watch reads them.
    const second = await h.run(Tools.use((x) => Effect.sync(() => x.decision(h.agent.id, "c2"))))
    expect(second).toMatchObject({
      decidedBy: "allow_rule",
      rule: { id: rules[0]?.id, kind: "shell", text: command },
    })
    const first = await h.run(Tools.use((x) => Effect.sync(() => x.decision(h.agent.id, "c1"))))
    expect(first).toMatchObject({ decidedBy: "user", rule: null })
  })

  test("a rule that exists is kept, not made twice", async () => {
    const h = await harness("ask_all")
    const step: RuleStep = { kind: "shell", command: "echo one" }
    const save = () => h.run(Rules.use((r) => Effect.sync(() => r.saveFromCard(h.agent.id, step))))
    const first = await save()
    const again = await save()
    expect(again?.id).toBe(first?.id)
    expect(await h.run(Rules.use((r) => r.list()))).toHaveLength(1)
    // The text of the step is over the limit: no rule is made.
    const long: RuleStep = { kind: "shell", command: "x".repeat(501) }
    expect(
      await h.run(Rules.use((r) => Effect.sync(() => r.saveFromCard(h.agent.id, long)))),
    ).toBeNull()
  })

  test("a card for a step that has no rules has no 'Always allow'", async () => {
    const h = await harness("ask_all")
    h.reply.answer = "always"
    await h.exec("browser_open", { url: "https://example.com/" })
    expect(h.asks[0]).toMatchObject({ kind: "approval", once: true })
    expect(await h.run(Rules.use((r) => r.list()))).toEqual([])
  })

  test("a linked device that sends 'always' gives one 'allow' and keeps no rule", async () => {
    const h = await harness("ask_risky")
    h.reply.answer = "always"
    h.reply.by = "Phone"
    const command = `rm -f "${join(h.t.dataDir, "gone.txt")}"`
    await h.exec("run_command", { command })
    expect(await h.run(Rules.use((r) => r.list()))).toEqual([])
    // The next run asks again.
    await h.exec("run_command", { command })
    expect(h.asks).toHaveLength(2)
  })

  test("a Deny rule on the server refuses a step that a client asked for", async () => {
    const h = await harness("ask_risky")
    await h.rule({ kind: "shell", text: "rm", decision: "deny" })
    h.reply.by = "Phone"
    const outcome = await h.exec("run_command", { command: "rm -f nothing.txt" })
    expect(outcome).toMatchObject({ refused: "rule" })
    expect(h.asks).toEqual([])
  })
})

describe("a rule that cannot be read", () => {
  const unreadable = async (h: Awaited<ReturnType<typeof harness>>, text: string) =>
    (await h.db()).run(
      `INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
       VALUES ('bad', ?, ?, 'shell', ?, NULL, 'maybe', 'list', 1)`,
      h.local.id,
      h.agent.id,
      text,
    )

  test("it is marked on the list, allows and denies nothing, and can be deleted", async () => {
    const h = await harness()
    await unreadable(h, "echo")
    const [bad] = await h.run(Rules.use((r) => r.list()))
    expect(bad).toMatchObject({ id: "bad", readable: false, decision: null, kind: "shell" })
    await h.run(Rules.use((r) => r.remove("bad")))
    expect(await h.run(Rules.use((r) => r.list()))).toEqual([])
  })

  test("a step that meets it asks the user, also at Full access, and the log says so", async () => {
    const h = await harness("full")
    await unreadable(h, "echo")
    const outcome = await h.exec("run_command", { command: "echo hi" })
    expect(outcome.output).toContain("hi")
    expect(h.asks).toHaveLength(1)
    // The card has no "Always allow": a rule that was saved would not open the step.
    expect(h.asks[0]).toMatchObject({ kind: "approval", once: true, unreadable: true })
    const entry = (await h.log())[0]
    // The log entry for a command comes from the task watch; this call has no task, so read the
    // decision as the watch does.
    expect(entry).toBeUndefined()
    const decision = await h.run(Tools.use((x) => Effect.sync(() => x.decision(h.agent.id, "c1"))))
    expect(decision).toMatchObject({
      decidedBy: "unreadable_rule",
      rule: { id: "bad", kind: "shell", text: "echo" },
    })
    // A step it does not meet runs with no question.
    h.asks.length = 0
    await h.exec("run_command", { command: "pwd" })
    expect(h.asks).toEqual([])
  })

  test("Deny on that card refuses the step", async () => {
    const h = await harness("full")
    await unreadable(h, "echo")
    h.reply.answer = "deny"
    const outcome = await h.exec("run_command", { command: "echo hi" })
    expect(outcome).toMatchObject({ failed: true })
    expect(outcome.output).toContain("denied")
  })

  test("a Deny rule that can be read still wins over it", async () => {
    const h = await harness("full")
    await unreadable(h, "echo")
    await h.rule({ kind: "shell", text: "echo", decision: "deny" })
    const outcome = await h.exec("run_command", { command: "echo hi" })
    expect(outcome).toMatchObject({ refused: "rule" })
    expect(h.asks).toEqual([])
  })
})

describe("a step that a program of a vendor asks about", () => {
  const request = (
    step: RuleStep | undefined,
    over: Partial<ApprovalRequest> = {},
  ): ApprovalRequest => ({
    callId: "v1",
    risky: true,
    key: "run_command:test",
    summary: "summary",
    ...(step ? { step } : {}),
    ...over,
  })
  const ask = (h: Awaited<ReturnType<typeof harness>>, req: ApprovalRequest) =>
    h.run(Tools.use((x) => Effect.promise(() => x.approval(h.context(), req))))

  test("a Deny rule refuses the step at Full access, and the card is marked", async () => {
    const h = await harness("full")
    await h.rule({ kind: "shell", text: "rm", decision: "deny" })
    expect(await ask(h, request({ kind: "shell", command: "rm -rf x" }))).toBe(false)
    expect(h.events).toEqual(["refused:v1:rule"])
    expect(h.asks).toEqual([])
  })

  test("an Allow rule lets the step run, and 'always' saves a rule for the same command", async () => {
    const h = await harness("ask_risky")
    h.reply.answer = "always"
    const step: RuleStep = { kind: "shell", command: "make deploy" }
    expect(await ask(h, request(step))).toBe(true)
    expect(await h.run(Rules.use((r) => r.list()))).toMatchObject([
      { kind: "shell", text: "make deploy" },
    ])
    h.asks.length = 0
    expect(await ask(h, request(step))).toBe(true)
    expect(h.asks).toEqual([])
    expect(h.events).toContain("allowed:v1")
  })

  test("a path that is not absolute is read from the workspace of the agent", async () => {
    const h = await harness("ask_risky")
    const folder = join(h.agent.workspace, "src")
    await h.rule({ kind: "file", text: folder, decision: "deny" })
    expect(await ask(h, request({ kind: "file", path: "src/a.ts" }))).toBe(false)
  })

  test("a step with no rules follows the level and its card has no 'always'", async () => {
    const h = await harness("ask_all")
    h.reply.answer = "always"
    expect(await ask(h, request(undefined, { risky: false, key: "web_search" }))).toBe(true)
    expect(h.asks[0]).toMatchObject({ once: true })
    expect(await h.run(Rules.use((r) => r.list()))).toEqual([])
  })
})

describe("a request with a saved secret", () => {
  test("a rule for the name and the method, or the name and any method, is looked up", async () => {
    const h = await harness()
    await h.rule({ kind: "secret", text: "Stripe", detail: "POST" })
    await h.rule({ kind: "secret", text: "Github", detail: null })
    const look = (step: RuleStep) =>
      h.run(Rules.use((r) => Effect.sync(() => r.verdict(h.agent.id, step).kind)))
    expect(await look({ kind: "secret", name: "stripe", method: "POST" })).toBe("allow")
    expect(await look({ kind: "secret", name: "Stripe", method: "DELETE" })).toBe("none")
    expect(await look({ kind: "secret", name: "GITHUB", method: "PATCH" })).toBe("allow")
  })

  test("a tool of a connection is looked up with stand-in names", async () => {
    const h = await harness()
    await h.rule({ kind: "connection", text: "Notes", detail: "read_note" })
    await h.rule({ kind: "connection", text: "Calendar", detail: null, decision: "deny" })
    const look = (connection: string, tool: string) =>
      h.run(
        Rules.use((r) =>
          Effect.sync(() => r.verdict(h.agent.id, { kind: "connection", connection, tool }).kind),
        ),
      )
    expect(await look("Notes", "read_note")).toBe("allow")
    expect(await look("Notes", "delete_note")).toBe("none")
    expect(await look("Calendar", "anything")).toBe("deny")
  })
})
