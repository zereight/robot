import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentCreate, copyName, faceFromName, nameKey } from "./agents.ts"

describe("agents", () => {
  test("names are 1 to 40 characters after trimming", () => {
    const ok = (name: string) =>
      Schema.is(AgentCreate)({ serverId: "s", name, role: "", instructions: "" })
    expect(ok("A")).toBe(true)
    expect(ok("가".repeat(40))).toBe(true)
    expect(ok("가".repeat(41))).toBe(false)
    expect(ok("   ")).toBe(false)
  })

  test("roles are at most 120 characters", () => {
    const ok = (role: string) =>
      Schema.is(AgentCreate)({ serverId: "s", name: "A", role, instructions: "" })
    expect(ok("x".repeat(120))).toBe(true)
    expect(ok("x".repeat(121))).toBe(false)
  })

  test("copies are named 'Name copy', then 'Name copy 2'", () => {
    const names = new Set(["writer"])
    const taken = (n: string) => names.has(nameKey(n))
    const first = copyName("Writer", " copy", taken)
    expect(first).toBe("Writer copy")
    names.add(nameKey(first))
    expect(copyName("Writer", " copy", taken)).toBe("Writer copy 2")
  })

  test("a copy name stays within 40 characters", () => {
    const long = "x".repeat(40)
    const name = copyName(long, " copy", () => false)
    expect([...name].length).toBe(40)
    expect(name.endsWith(" copy")).toBe(true)
  })

  test("the same name gives the same face", () => {
    expect(faceFromName("Ada")).toEqual(faceFromName("Ada"))
  })
})
