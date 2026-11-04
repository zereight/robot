import { describe, expect, test } from "bun:test"
import { AGENT_ROLE_MAX } from "./agents.ts"
import {
  choiceText,
  isPickable,
  type RoleEntry,
  roleChoices,
  roleKey,
  roleList,
  startMark,
  stepMark,
} from "./roles.ts"

const agent = (role: string, archived = false) => ({ role, archived })

describe("the list of roles", () => {
  test("it counts the agents of each role, in alphabetical order", () => {
    const list = roleList([agent("Writer"), agent("Designer"), agent("Writer"), agent("QA")])
    expect(list).toEqual([
      { name: "Designer", count: 1 },
      { name: "QA", count: 1 },
      { name: "Writer", count: 2 },
    ])
  })

  test("spellings that differ only in case are one role, and the first spelling shows", () => {
    const list = roleList([agent("Designer"), agent("designer"), agent("DESIGNER")])
    expect(list).toEqual([{ name: "Designer", count: 3 }])
    // The first one found wins, not the first in the alphabet.
    expect(roleList([agent("designer"), agent("Designer")])).toEqual([
      { name: "designer", count: 2 },
    ])
  })

  test("spaces at both ends do not make a new role", () => {
    expect(roleList([agent("Writer"), agent("  Writer "), agent("   ")])).toEqual([
      { name: "Writer", count: 2 },
    ])
  })

  test("an agent with no role line adds nothing", () => {
    expect(roleList([agent(""), agent("")])).toEqual([])
  })

  test("an archived agent is not in the list, and its role leaves when no other agent has it", () => {
    const list = roleList([agent("Designer", true), agent("Writer"), agent("Writer", true)])
    expect(list).toEqual([{ name: "Writer", count: 1 }])
    // The archived agent keeps its line, and a restore brings the role back.
    expect(roleList([agent("Designer", false), agent("Writer")])).toEqual([
      { name: "Designer", count: 1 },
      { name: "Writer", count: 1 },
    ])
  })

  test("an agent that has no archived flag counts", () => {
    expect(roleList([{ role: "Writer" }])).toEqual([{ name: "Writer", count: 1 }])
  })

  test("the order ignores case and puts numbers in order", () => {
    const list = roleList([agent("beta"), agent("Alpha"), agent("Agent 10"), agent("Agent 2")])
    expect(list.map((r) => r.name)).toEqual(["Agent 2", "Agent 10", "Alpha", "beta"])
  })

  test("the order is the same for any order of agents", () => {
    const names = ["b", "A", "c", "a", "B"]
    const forward = roleList(names.map((n) => agent(n)))
    const back = roleList([...names].reverse().map((n) => agent(n)))
    expect(forward.map((r) => roleKey(r.name))).toEqual(back.map((r) => roleKey(r.name)))
  })

  test("the key ignores case and the form of the letters", () => {
    expect(roleKey(" Designer ")).toBe(roleKey("designer"))
    // "é" as one character and as two characters is one spelling.
    expect(roleKey("caf\u00e9")).toBe(roleKey("cafe\u0301"))
  })

  test("Korean roles list like any other", () => {
    expect(roleList([agent("작가"), agent("디자이너"), agent("작가")])).toEqual([
      { name: "디자이너", count: 1 },
      { name: "작가", count: 2 },
    ])
  })
})

const roles: RoleEntry[] = [
  { name: "Art designer", count: 1 },
  { name: "Designer", count: 2 },
  { name: "Writer", count: 3 },
]

describe("the choices of the role field", () => {
  test("with no text, every role shows and there is no Add", () => {
    expect(roleChoices(roles, "").map((c) => [c.kind, c.name])).toEqual([
      ["role", "Art designer"],
      ["role", "Designer"],
      ["role", "Writer"],
    ])
    expect(roleChoices(roles, "   ")).toHaveLength(3)
  })

  test("typed text keeps the roles that hold it, ignoring case, in the same order", () => {
    const choices = roleChoices(roles, "SIGN")
    expect(choices.map((c) => [c.kind, c.name])).toEqual([
      ["role", "Art designer"],
      ["role", "Designer"],
      ["add", "SIGN"],
    ])
  })

  test("the last choice is Add with the typed text, when no role is the same as the text", () => {
    const choices = roleChoices(roles, "  Qa tester ")
    expect(choices).toEqual([{ kind: "add", name: "Qa tester", off: false }])
    const partial = roleChoices(roles, "writ")
    expect(partial.map((c) => c.kind)).toEqual(["role", "add"])
    expect(partial.at(-1)).toEqual({ kind: "add", name: "writ", off: false })
  })

  test("a text that is the same as a listed role, ignoring case, has no Add", () => {
    for (const text of ["designer", "DESIGNER", " Designer "]) {
      const choices = roleChoices(roles, text)
      expect(choices.some((c) => c.kind === "add")).toBe(false)
      expect(choices.map((c) => c.name)).toEqual(["Art designer", "Designer"])
    }
  })

  test("the spelling of the list wins, wherever the role stands in the list", () => {
    // "Art designer" stands first, but Enter must pick "Designer" for the text "designer".
    const choices = roleChoices(roles, "designer")
    const at = startMark(choices, "designer")
    expect(choiceText(choices[at] as never)).toBe("Designer")
  })

  test("the mark starts on the first choice when no role is the same as the text", () => {
    expect(startMark(roleChoices(roles, ""), "")).toBe(0)
    expect(startMark(roleChoices(roles, "sign"), "sign")).toBe(0)
    // Only "Add" is left, so the mark starts on it.
    const only = roleChoices(roles, "Qa tester")
    expect(startMark(only, "Qa tester")).toBe(0)
  })

  test("a text over 120 characters keeps Add in the list, but off", () => {
    const long = "x".repeat(AGENT_ROLE_MAX + 1)
    const [add] = roleChoices(roles, long)
    expect(add).toEqual({ kind: "add", name: long, off: true })
    expect(isPickable(add as never)).toBe(false)
    expect(startMark([add as never], long)).toBe(-1)
    // 120 characters still fit.
    expect(roleChoices(roles, "x".repeat(AGENT_ROLE_MAX))[0]).toMatchObject({ off: false })
  })

  test("the limit counts characters, not UTF-16 units", () => {
    const fits = "😀".repeat(AGENT_ROLE_MAX)
    expect(roleChoices([], fits)[0]).toMatchObject({ kind: "add", off: false })
    expect(roleChoices([], `${fits}😀`)[0]).toMatchObject({ kind: "add", off: true })
  })

  test("no role and no text give no choice, and nothing to pick", () => {
    expect(roleChoices([], "")).toEqual([])
    expect(startMark([], "")).toBe(-1)
  })
})

describe("the mark of the role list", () => {
  test("up and down move the mark and go round at the ends", () => {
    const choices = roleChoices(roles, "")
    expect(stepMark(choices, 0, 1)).toBe(1)
    expect(stepMark(choices, 2, 1)).toBe(0)
    expect(stepMark(choices, 0, -1)).toBe(2)
    expect(stepMark(choices, 1, -1)).toBe(0)
  })

  test("a step skips the Add that is off", () => {
    const long = "x".repeat(AGENT_ROLE_MAX + 1)
    const choices = roleChoices(roles, long)
    // Only the off choice is in the list: there is nowhere to go.
    expect(stepMark(choices, -1, 1)).toBe(-1)
    const mixed = [
      { kind: "role", name: "A", count: 1 },
      { kind: "add", name: long, off: true },
    ] as const
    expect(stepMark(mixed, 0, 1)).toBe(0)
    expect(stepMark(mixed, 0, -1)).toBe(0)
  })

  test("with no mark, down lands on the first choice and up on the last", () => {
    const choices = roleChoices(roles, "")
    expect(stepMark(choices, -1, 1)).toBe(0)
    expect(stepMark(choices, -1, -1)).toBe(2)
  })
})
