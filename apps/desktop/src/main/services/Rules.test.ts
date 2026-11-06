import { describe, expect, test } from "bun:test"
import type { RuleInput, RuleStep } from "@robot/shared"
import { Effect } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Database } from "./Database.ts"
import { Rules } from "./Rules.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

/** One app with a stand-in data folder and home folder, and a workflow. */
const harness = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const make = (name: string) => run(Workflows.use((w) => w.create({ serverId: local.id, name })))
  const workflow = await make("Ada")
  const rule = (input: Partial<RuleInput> & Pick<RuleInput, "kind" | "text">) =>
    run(
      Rules.use((r) =>
        r.add({ workflowId: workflow.id, decision: "allow", ...input } as RuleInput),
      ),
    )
  const log = () => run(ActionLog.use((l) => l.list()))
  const db = () => run(Database.use((d) => Effect.succeed(d)))
  return { t, run, local, workflow, make, rule, log, db }
}

describe("the list of rules", () => {
  test("rules come newest first, and the list filters by workflow and by decision", async () => {
    const h = await harness()
    const other = await h.make("Bo")
    let now = 1000
    const real = Date.now
    Date.now = () => now++
    try {
      await h.rule({ kind: "shell", text: "ls" })
      await h.rule({ kind: "web", text: "example.com", decision: "deny" })
      await h.run(
        Rules.use((r) =>
          r.add({ workflowId: null, kind: "shell", text: "pwd", decision: "allow" }),
        ),
      )
      await h.run(
        Rules.use((r) =>
          r.add({ workflowId: other.id, kind: "shell", text: "cat", decision: "deny" }),
        ),
      )
    } finally {
      Date.now = real
    }
    const list = (filter = {}) => h.run(Rules.use((r) => r.list(filter)))
    expect((await list()).map((r) => r.text)).toEqual(["cat", "pwd", "example.com", "ls"])
    expect((await list({ workflowId: h.workflow.id })).map((r) => r.text)).toEqual([
      "example.com",
      "ls",
    ])
    expect((await list({ workflowId: null })).map((r) => r.text)).toEqual(["pwd"])
    expect((await list({ decision: "deny" })).map((r) => r.text)).toEqual(["cat", "example.com"])
    expect(
      (await list({ workflowId: h.workflow.id, decision: "allow" })).map((r) => r.text),
    ).toEqual(["ls"])
  })

  test("a rule is edited in place and deleted", async () => {
    const h = await harness()
    const made = await h.rule({ kind: "shell", text: "ls" })
    expect(made).toMatchObject({ source: "list", decision: "allow", readable: true })
    const changed = await h.run(
      Rules.use((r) =>
        r.update(made.id, { workflowId: null, kind: "web", text: "Example.com", decision: "deny" }),
      ),
    )
    expect(changed).toMatchObject({
      id: made.id,
      workflowId: null,
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
        r.update("none", { workflowId: null, kind: "shell", text: "x", decision: "allow" }),
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
      await code({
        workflowId: h.workflow.id,
        kind: "web",
        text: "Example.com",
        decision: "allow",
      }),
    ).toBe("rule_duplicate")
    // The edit of a rule into another rule is refused as well.
    const second = await h.rule({ kind: "web", text: "other.com" })
    expect(
      (
        await h.run(
          Rules.use((r) =>
            r.update(second.id, {
              workflowId: h.workflow.id,
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
        r.add({ workflowId: other.id, kind: "web", text: "example.com", decision: "allow" }),
      ),
    )
    await h.run(
      Rules.use((r) =>
        r.add({ workflowId: null, kind: "web", text: "example.com", decision: "allow" }),
      ),
    )
    expect(await h.run(Rules.use((r) => r.list()))).toHaveLength(5)
  })

  test("the match text holds 1 to 500 characters", async () => {
    const h = await harness()
    const code = async (text: string) =>
      (
        await h.run(
          Rules.use((r) =>
            r.add({ workflowId: null, kind: "shell", text, decision: "allow" }),
          ).pipe(Effect.flip),
        )
      ).code
    expect(await code("")).toBe("rule_text_invalid")
    expect(await code("x".repeat(501))).toBe("rule_text_invalid")
    await h.run(
      Rules.use((r) =>
        r.add({ workflowId: null, kind: "shell", text: "x".repeat(500), decision: "allow" }),
      ),
    )
  })

  test("a rule for a workflow that does not exist is refused", async () => {
    const h = await harness()
    const refused = await h.run(
      Rules.use((r) =>
        r.add({ workflowId: "nobody", kind: "shell", text: "ls", decision: "allow" }),
      ).pipe(Effect.flip),
    )
    expect(refused).toMatchObject({ code: "rule_workflow_gone" })
  })
})

describe("what a rule matches, with real paths", () => {})

describe("the order of the decisions for a step", () => {})

describe("Always allow for this agent", () => {})

describe("a rule that cannot be read", () => {
  const unreadable = async (h: Awaited<ReturnType<typeof harness>>, text: string) =>
    (await h.db()).run(
      `INSERT INTO permission_rule (id, server_id, workflow_id, kind, match_text, detail, decision, source, created_at)
       VALUES ('bad', ?, ?, 'shell', ?, NULL, 'maybe', 'list', 1)`,
      h.local.id,
      h.workflow.id,
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
})

describe("a request with a saved secret", () => {
  test("a rule for the name and the method, or the name and any method, is looked up", async () => {
    const h = await harness()
    await h.rule({ kind: "secret", text: "Stripe", detail: "POST" })
    await h.rule({ kind: "secret", text: "Github", detail: null })
    const look = (step: RuleStep) =>
      h.run(Rules.use((r) => Effect.sync(() => r.verdict(h.workflow.id, step).kind)))
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
          Effect.sync(
            () => r.verdict(h.workflow.id, { kind: "connection", connection, tool }).kind,
          ),
        ),
      )
    expect(await look("Notes", "read_note")).toBe("allow")
    expect(await look("Notes", "delete_note")).toBe("none")
    expect(await look("Calendar", "anything")).toBe("deny")
  })
})
