import { describe, expect, test } from "bun:test"
import { MAX_OPS_PER_BATCH, parseBatch, parseOp } from "./wire.ts"

const NOW = 1_700_000_000_000
const stamp = [NOW, 0, "dev-b"]
const agentFields = {
  name: { v: "Ada", s: stamp },
  role: { v: "", s: stamp },
  instructions: { v: "Be brief.", s: stamp },
  face: { v: { shape: 1, hue: 2 }, s: stamp },
  model: { v: null, s: stamp },
  archived: { v: false, s: stamp },
  createdAt: { v: NOW, s: stamp },
}
const agentOp = (extra: Record<string, unknown> = {}) => ({
  k: "agent",
  i: "agent-1",
  f: agentFields,
  o: "dev-b",
  ...extra,
})

describe("a change from the other computer is untrusted", () => {
  test("a well formed change is read with real stamps", () => {
    const op = parseOp(agentOp(), NOW)
    expect(op?.kind).toBe("agent")
    expect(op?.fields.get("name")).toEqual({ value: "Ada", stamp: { l: NOW, c: 0, n: "dev-b" } })
  })

  test("it refuses a kind that it does not know", () => {
    expect(parseOp(agentOp({ k: "secret" }), NOW)).toBeUndefined()
    expect(parseOp(agentOp({ k: "__proto__" }), NOW)).toBeUndefined()
  })

  test("it refuses a field that sync does not carry: the folder, the level and the rules stay local", () => {
    for (const name of ["workspace", "permission", "memoryEnabled", "allow", "secret", "apiKey"]) {
      const op = agentOp({ f: { ...agentFields, [name]: { v: "x", s: stamp } } })
      expect(parseOp(op, NOW)).toBeUndefined()
    }
  })

  test("it refuses extra keys on the change and on its fields", () => {
    expect(parseOp(agentOp({ extra: 1 }), NOW)).toBeUndefined()
    expect(
      parseOp(agentOp({ f: { ...agentFields, name: { v: "Ada", s: stamp, x: 1 } } }), NOW),
    ).toBeUndefined()
  })

  test("it refuses an id that could name a path or a statement", () => {
    for (const id of ["../etc", "a/b", "a b", "x';--", "", "a".repeat(101)]) {
      expect(parseOp(agentOp({ i: id }), NOW)).toBeUndefined()
    }
  })

  test("it refuses a value of the wrong type or size", () => {
    expect(
      parseOp(agentOp({ f: { ...agentFields, name: { v: 12, s: stamp } } }), NOW),
    ).toBeUndefined()
    expect(
      parseOp(agentOp({ f: { ...agentFields, name: { v: "x".repeat(500), s: stamp } } }), NOW),
    ).toBeUndefined()
    expect(
      parseOp(
        agentOp({ f: { ...agentFields, face: { v: { shape: 99, hue: 0 }, s: stamp } } }),
        NOW,
      ),
    ).toBeUndefined()
  })

  test("it refuses a stamp from the far future, and a change that is both a change and a deletion", () => {
    expect(
      parseOp(agentOp({ f: { ...agentFields, name: { v: "Ada", s: [NOW * 3, 0, "x"] } } }), NOW),
    ).toBeUndefined()
    expect(parseOp({ k: "agent", i: "a", d: stamp, f: agentFields }, NOW)).toBeUndefined()
    expect(parseOp({ k: "agent", i: "a", d: stamp }, NOW)?.deleted).toEqual({
      l: NOW,
      c: 0,
      n: "dev-b",
    })
  })

  test("a file of a message must sit in the attachments folder and name no path", () => {
    const message = (parts: unknown) => ({
      k: "message",
      i: "m1",
      o: "dev-b",
      f: {
        agentId: { v: "agent-1", s: stamp },
        author: { v: "user", s: stamp },
        parts: { v: parts, s: stamp },
        status: { v: "done", s: stamp },
        error: { v: null, s: stamp },
        replyTo: { v: null, s: stamp },
        model: { v: null, s: stamp },
        createdAt: { v: NOW, s: stamp },
        finishedAt: { v: NOW, s: stamp },
        editedAt: { v: null, s: stamp },
        sender: { v: null, s: stamp },
        origin: { v: "dev-b", s: stamp },
      },
    })
    const file = (path: string, name = "a.txt") => [{ kind: "file", name, path, size: 3 }]
    expect(parseOp(message(file("attachments/a.txt")), NOW)).toBeDefined()
    for (const path of [
      "../../etc/passwd",
      "/etc/passwd",
      "attachments/../x",
      "attachments/a/b",
      "other/a.txt",
      "attachments/..",
      "C:\\x",
    ]) {
      expect(parseOp(message(file(path)), NOW)).toBeUndefined()
    }
    expect(parseOp(message(file("attachments/a.txt", "../a.txt")), NOW)).toBeUndefined()
    expect(parseOp(message([{ kind: "script", text: "x" }]), NOW)).toBeUndefined()
  })

  test("a push is limited in the number of changes, and bad changes do not stop good ones", () => {
    expect(
      parseBatch({ ops: new Array(MAX_OPS_PER_BATCH + 1).fill(agentOp()) }, NOW),
    ).toBeUndefined()
    const mixed = parseBatch({ ops: [agentOp(), { k: "nope" }, agentOp({ i: "agent-2" })] }, NOW)
    expect(mixed?.ops.map((o) => o.id)).toEqual(["agent-1", "agent-2"])
    expect(mixed?.refused).toBe(1)
    expect(parseBatch({ ops: [], extra: true }, NOW)).toBeUndefined()
    expect(parseBatch([], NOW)).toBeUndefined()
    expect(
      parseBatch({ ops: [], snap: { total: -1, done: true, cursor: "" } }, NOW),
    ).toBeUndefined()
  })
})
