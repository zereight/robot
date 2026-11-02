import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  AGENT_NAME_MAX,
  AGENT_NAMES,
  AgentCreate,
  charLength,
  copyName,
  faceFromName,
  filterAgents,
  nameKey,
  suggestName,
} from "./agents.ts"
import { catalogues } from "./i18n/index.ts"

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

  test("agent search matches name or role, every word, ignoring case", () => {
    const list = [
      { name: "Lia", role: "Code reviewer" },
      { name: "Bo", role: "Researcher" },
      { name: "리아", role: "번역가" },
    ]
    const names = (q: string) => filterAgents(list, q).map((a) => a.name)
    expect(names("")).toEqual(["Lia", "Bo", "리아"])
    expect(names("   ")).toEqual(["Lia", "Bo", "리아"])
    expect(names("LI")).toEqual(["Lia"])
    expect(names("re")).toEqual(["Lia", "Bo"])
    expect(names("code review")).toEqual(["Lia"])
    expect(names("review code")).toEqual(["Lia"])
    expect(names("번역")).toEqual(["리아"])
    expect(names("zzz")).toEqual([])
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

  describe("name suggestions", () => {
    const names = ["Nova", "Orbit", "Pixel"]
    const none = () => false

    test("picks a name from the list, by the random number", () => {
      expect(suggestName(names, none, "", () => 0)).toBe("Nova")
      expect(suggestName(names, none, "", () => 0.5)).toBe("Orbit")
      expect(suggestName(names, none, "", () => 0.999999)).toBe("Pixel")
    })

    test("skips taken names, ignoring case", () => {
      const used = new Set(["nova", "pixel"])
      const taken = (n: string) => used.has(nameKey(n))
      for (const r of [0, 0.5, 0.999999])
        expect(suggestName(names, taken, "", () => r)).toBe("Orbit")
    })

    test("gives a new name each time: it skips the name in the field", () => {
      expect(suggestName(names, none, "NOVA", () => 0)).toBe("Orbit")
      expect(suggestName(names, none, " orbit ", () => 0.5)).toBe("Pixel")
    })

    test("adds a number when the only free name is the one in the field", () => {
      const taken = (n: string) => ["orbit", "pixel"].includes(nameKey(n))
      expect(suggestName(names, taken, "Nova", () => 0)).toBe("Nova 2")
    })

    test("adds a number when every name is taken", () => {
      const used = new Set(names.map(nameKey))
      const taken = (n: string) => used.has(nameKey(n))
      expect(suggestName(names, taken, "", () => 0)).toBe("Nova 2")
      used.add("nova 2")
      expect(suggestName(names, taken, "", () => 0)).toBe("Nova 3")
    })

    test("a numbered name stays within 40 characters", () => {
      const long = ["x".repeat(AGENT_NAME_MAX)]
      const name = suggestName(
        long,
        (n) => nameKey(n) === nameKey(long[0] ?? ""),
        "",
        () => 0,
      )
      expect(charLength(name)).toBe(AGENT_NAME_MAX)
      expect(name.endsWith(" 2")).toBe(true)
    })

    test("returns an empty name for an empty list", () => {
      expect(suggestName([], none, "")).toBe("")
    })

    test("the name list holds at least 80 different English first names", () => {
      expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(80)
      expect(new Set(AGENT_NAMES.map(nameKey)).size).toBe(AGENT_NAMES.length)
      for (const n of AGENT_NAMES) {
        expect(n).toMatch(/^[A-Z][a-z]+$/)
        expect(charLength(n)).toBeLessThanOrEqual(AGENT_NAME_MAX)
      }
    })

    for (const [locale, catalogue] of Object.entries(catalogues)) {
      test(`${locale} has no names in its catalogue: names stay English`, () => {
        expect(Object.keys(catalogue).filter((k) => k.startsWith("agents.suggest.name."))).toEqual(
          [],
        )
      })
    }
  })
})
