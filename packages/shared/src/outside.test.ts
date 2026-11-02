import { describe, expect, test } from "bun:test"
import type { MessagePart } from "./chat.ts"
import {
  GUARDED_STEPS,
  type GuardLevel,
  guardDecision,
  holdOutside,
  hostOf,
  isOutsideSource,
  newTurnMark,
  outsideOfCall,
  outsideOfParts,
  starterOf,
} from "./outside.ts"

const LEVELS: readonly GuardLevel[] = ["read_only", "ask_all", "ask_risky", "full"]

describe("guardDecision", () => {
  test("in a turn that holds outside content a guarded step asks, except at Full access", () => {
    for (const level of ["ask_all", "ask_risky"] as const)
      for (const step of GUARDED_STEPS)
        expect(guardDecision({ step, level, outside: true, starter: "user" })).toBe("ask")
    for (const step of GUARDED_STEPS)
      expect(guardDecision({ step, level: "full", outside: true, starter: "user" })).toBe("run")
  })

  test("at Read only a memory save follows the outside rule; other guarded steps are refused", () => {
    expect(
      guardDecision({ step: "memory", level: "read_only", outside: true, starter: "user" }),
    ).toBe("ask")
    expect(
      guardDecision({ step: "memory", level: "read_only", outside: false, starter: "user" }),
    ).toBe("usual")
    for (const step of ["settings", "secret_request", "secret_new"] as const)
      for (const outside of [true, false])
        expect(guardDecision({ step, level: "read_only", outside, starter: "user" })).toBe(
          "refuse_read_only",
        )
  })

  test("a Deny rule refuses at every level, also at Full access", () => {
    for (const level of LEVELS)
      for (const step of GUARDED_STEPS)
        for (const outside of [true, false])
          expect(guardDecision({ step, level, outside, starter: "user", denied: true })).toBe(
            "refuse_rule",
          )
  })

  test("with no outside content the guard adds nothing to a turn that the user started", () => {
    for (const level of ["ask_all", "ask_risky"] as const)
      for (const step of GUARDED_STEPS)
        expect(guardDecision({ step, level, outside: false, starter: "user" })).toBe("usual")
  })

  test("a turn that the user did not start asks before a change of the agent's own settings", () => {
    for (const starter of ["routine", "workflow", "agent"] as const) {
      for (const level of ["ask_all", "ask_risky"] as const)
        expect(guardDecision({ step: "settings", level, outside: false, starter })).toBe("ask")
      expect(guardDecision({ step: "settings", level: "full", outside: false, starter })).toBe(
        "run",
      )
      // A memory save of such a turn with no outside content does not ask.
      expect(guardDecision({ step: "memory", level: "ask_risky", outside: false, starter })).toBe(
        "usual",
      )
    }
  })
})

describe("the mark of a turn", () => {
  test("the first source stays until the turn ends", () => {
    const mark = newTurnMark("user")
    expect(mark.source).toBeNull()
    holdOutside(mark, null)
    expect(mark.source).toBeNull()
    holdOutside(mark, { kind: "page", host: "a.test" })
    holdOutside(mark, { kind: "page", host: "b.test" })
    expect(mark.source).toEqual({ kind: "page", host: "a.test" })
  })

  test("a turn that another agent or a watch routine starts holds outside content from its start", () => {
    expect(newTurnMark("agent", { kind: "agent", name: "Bo" }).source).toEqual({
      kind: "agent",
      name: "Bo",
    })
    expect(newTurnMark("routine", { kind: "routine", name: "Watch" }).starter).toBe("routine")
  })

  test("the starter comes from the source of the task", () => {
    expect(starterOf("chat")).toBe("user")
    expect(starterOf("channel")).toBe("user")
    expect(starterOf("routine")).toBe("routine")
    expect(starterOf("workflow")).toBe("workflow")
  })
})

describe("outside content of a tool call", () => {
  const input = (args: unknown) => JSON.stringify(args)

  test("pages, browser reads, sources from an address and connection tools give outside content", () => {
    expect(outsideOfCall("fetch_url", input({ url: "https://news.test/a" }))).toEqual({
      kind: "page",
      host: "news.test",
    })
    expect(outsideOfCall("browser_open", input({ url: "http://127.0.0.1:9/x" }))).toEqual({
      kind: "page",
      host: "127.0.0.1",
    })
    expect(outsideOfCall("browser_read", "{}")).toEqual({ kind: "page", host: "" })
    expect(outsideOfCall("add_source", input({ url: "https://docs.test/" }))).toEqual({
      kind: "page",
      host: "docs.test",
    })
    expect(outsideOfCall("mcp__github__list_issues", "{}")).toEqual({
      kind: "connection",
      connection: "github",
      tool: "list_issues",
    })
    expect(outsideOfCall("WebFetch", input({ url: "https://x.test/" }))).toEqual({
      kind: "page",
      host: "x.test",
    })
  })

  test("files, commands, clicks, a source from a file and memory are not outside content", () => {
    for (const name of ["read_file", "write_file", "run_command", "save_memory", "browser_click"])
      expect(outsideOfCall(name, input({ path: "a.txt", url: "https://x.test" }))).toBeNull()
    expect(outsideOfCall("add_source", input({ path: "notes.txt" }))).toBeNull()
  })

  test("a turn that waited through a restart gets its mark back from the saved parts", () => {
    const tool = (
      name: string,
      state: "done" | "failed" | "waiting",
      args: unknown,
      extra: Partial<Extract<MessagePart, { kind: "tool" }>> = {},
    ): MessagePart => ({
      kind: "tool",
      id: name,
      name,
      label: name,
      state,
      input: input(args),
      output: "",
      ...extra,
    })
    expect(outsideOfParts([tool("read_file", "done", { path: "a" })])).toBeNull()
    expect(
      outsideOfParts([
        { kind: "text", text: "Looking." },
        tool("fetch_url", "done", { url: "https://page.test/" }),
        tool("save_memory", "waiting", { text: "x" }),
      ]),
    ).toEqual({ kind: "page", host: "page.test" })
    // The card that waits names the source, also when the steps do not show it.
    expect(
      outsideOfParts([
        tool(
          "save_memory",
          "waiting",
          { text: "x" },
          {
            ask: {
              kind: "approval",
              summary: "x",
              once: true,
              outside: { kind: "agent", name: "Bo" },
            },
          },
        ),
      ]),
    ).toEqual({ kind: "agent", name: "Bo" })
  })
})

test("hostOf and isOutsideSource", () => {
  expect(hostOf("https://www.example.com:8080/a?b")).toBe("www.example.com")
  expect(hostOf("not a url")).toBe("")
  expect(isOutsideSource({ kind: "page", host: "a.test" })).toBe(true)
  expect(isOutsideSource({ kind: "connection", connection: "c", tool: "t" })).toBe(true)
  expect(isOutsideSource({ kind: "agent", name: "Bo" })).toBe(true)
  expect(isOutsideSource({ kind: "page", host: "a", extra: 1 })).toBe(false)
  expect(isOutsideSource({ kind: "other", name: "x" })).toBe(false)
  expect(isOutsideSource({ kind: "agent", name: "x".repeat(501) })).toBe(false)
  expect(isOutsideSource(null)).toBe(false)
})
