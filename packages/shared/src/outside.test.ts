import { describe, expect, test } from "bun:test"
import type { MessagePart } from "./chat.ts"
import {
  carriesProgramMark,
  GUARDED_STEPS,
  type GuardLevel,
  guardDecision,
  holdOutside,
  holdProgram,
  hostOf,
  isOutsideSource,
  newTurnMark,
  OUTSIDE_SOURCE_KINDS,
  type OutsideSource,
  outsideOfCall,
  outsideOfParts,
  starterOf,
  type TurnStarter,
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

describe("guardDecision and the program mark (spec 007, 023)", () => {
  const STARTERS: readonly TurnStarter[] = ["user", "routine", "workflow", "agent", "program"]
  const STEPS = GUARDED_STEPS

  test("a turn with the program mark asks at every level that does not refuse, also at Full access", () => {
    for (const step of STEPS)
      for (const starter of STARTERS)
        for (const outside of [true, false]) {
          for (const level of ["ask_all", "ask_risky", "full"] as const)
            expect(guardDecision({ step, level, outside, program: true, starter })).toBe("ask")
          // At Read only, the steps that Read only refuses stay refused.
          expect(guardDecision({ step, level: "read_only", outside, program: true, starter })).toBe(
            step === "memory" ? "ask" : "refuse_read_only",
          )
        }
  })

  test("a Deny rule still refuses in a turn with the program mark, at every level", () => {
    for (const level of LEVELS)
      for (const step of STEPS)
        expect(
          guardDecision({
            step,
            level,
            outside: true,
            program: true,
            starter: "program",
            denied: true,
          }),
        ).toBe("refuse_rule")
  })

  test("the program mark is outside content, also when the input says no outside content", () => {
    expect(
      guardDecision({
        step: "memory",
        level: "ask_risky",
        outside: false,
        program: true,
        starter: "user",
      }),
    ).toBe("ask")
  })

  test("a turn with no program mark runs at Full access, as before, whatever the starter", () => {
    for (const step of STEPS)
      for (const starter of STARTERS)
        for (const outside of [true, false])
          for (const program of [false, undefined])
            expect(
              guardDecision({
                step,
                level: "full",
                outside,
                ...(program === false ? { program } : {}),
                starter,
              }),
            ).toBe("run")
  })

  test("the rows for levels, starters and the mark agree with the spec", () => {
    // [level, outside, program, starter, step] -> verdict, one row for each rule of spec 007.
    const rows: [GuardLevel, boolean, boolean, TurnStarter, (typeof STEPS)[number], string][] = [
      ["full", false, false, "user", "settings", "run"],
      ["full", true, false, "user", "settings", "run"],
      ["full", true, false, "agent", "settings", "run"],
      ["full", false, true, "user", "settings", "ask"],
      ["full", true, true, "program", "settings", "ask"],
      ["full", true, true, "program", "memory", "ask"],
      ["full", true, true, "program", "secret_request", "ask"],
      ["ask_risky", false, false, "program", "settings", "ask"],
      ["ask_risky", false, false, "program", "memory", "usual"],
      ["ask_all", true, false, "user", "memory", "ask"],
      ["ask_risky", true, true, "user", "secret_new", "ask"],
      ["read_only", true, true, "program", "settings", "refuse_read_only"],
      ["read_only", true, true, "program", "memory", "ask"],
    ]
    for (const [level, outside, program, starter, step, verdict] of rows)
      expect(guardDecision({ step, level, outside, program, starter })).toBe(verdict as never)
  })
})

describe("the program mark of a turn", () => {
  const teams: OutsideSource = { kind: "teams" }

  test("a source from Teams gives the turn the program mark from its start", () => {
    const mark = newTurnMark("program", teams)
    expect(mark.program).toBe(true)
    expect(mark.source).toEqual(teams)
    expect(newTurnMark("agent", { kind: "agent", name: "Bo" }).program).toBe(false)
    expect(newTurnMark("user").program).toBe(false)
  })

  test("a turn with no source holds no program mark, also when the caller says it does", () => {
    expect(newTurnMark("user", null, null, true).program).toBe(false)
  })

  test("the mark can come by a later rule, and the first source stays", () => {
    const mark = newTurnMark("agent", { kind: "agent", name: "Bo" })
    expect(mark.program).toBe(false)
    holdProgram(mark, teams)
    expect(mark.program).toBe(true)
    expect(mark.source).toEqual({ kind: "agent", name: "Bo" })
    const plain = newTurnMark("user")
    holdProgram(plain, teams)
    expect(plain.source).toEqual(teams)
    expect(plain.program).toBe(true)
  })

  test("a later source from Teams gives the mark, also when it is not the first source", () => {
    const mark = newTurnMark("user")
    holdOutside(mark, { kind: "page", host: "a.test" })
    expect(mark.program).toBe(false)
    holdOutside(mark, teams)
    expect(mark.program).toBe(true)
    expect(mark.source).toEqual({ kind: "page", host: "a.test" })
  })

  test("one function says which source kinds carry the mark", () => {
    expect(carriesProgramMark({ kind: "teams" })).toBe(true)
    expect(carriesProgramMark(null)).toBe(false)
    expect(carriesProgramMark(undefined)).toBe(false)
    for (const source of [
      { kind: "page", host: "a.test" },
      { kind: "connection", connection: "c", tool: "t" },
      { kind: "secret", name: "s" },
      { kind: "routine", name: "r" },
      { kind: "agent", name: "a" },
    ] satisfies OutsideSource[])
      expect(carriesProgramMark(source)).toBe(false)
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
    // A message from Teams is a turn that the user did not start (spec 007, 028).
    expect(starterOf("teams")).toBe("program")
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
    for (const name of [
      "read_file",
      "write_file",
      "run_command",
      "save_memory",
      "browser_click",
      "browser_ask_look",
    ])
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
  // A message from Teams (028) has a kind and no other data.
  expect(isOutsideSource({ kind: "teams" })).toBe(true)
  expect(isOutsideSource({ kind: "teams", name: "x" })).toBe(false)
  expect(isOutsideSource({ kind: "page", host: "a", extra: 1 })).toBe(false)
  expect(isOutsideSource({ kind: "other", name: "x" })).toBe(false)
  expect(isOutsideSource({ kind: "agent", name: "x".repeat(501) })).toBe(false)
  expect(isOutsideSource(null)).toBe(false)
})

test("every source kind is a kind that the type guard accepts", () => {
  const sample: Record<(typeof OUTSIDE_SOURCE_KINDS)[number], OutsideSource> = {
    page: { kind: "page", host: "a.test" },
    connection: { kind: "connection", connection: "c", tool: "t" },
    secret: { kind: "secret", name: "s" },
    routine: { kind: "routine", name: "r" },
    agent: { kind: "agent", name: "a" },
    teams: { kind: "teams" },
  }
  expect([...OUTSIDE_SOURCE_KINDS].map(String).sort()).toEqual(Object.keys(sample).sort())
  for (const kind of OUTSIDE_SOURCE_KINDS) expect(isOutsideSource(sample[kind])).toBe(true)
})
