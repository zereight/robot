import { describe, expect, test } from "bun:test"
import {
  CLAIM_NOTE_PATHS,
  promptStart,
  refusalText,
  refusedLine,
  sharedFolderNote,
  sharesFolder,
} from "./claims.ts"

describe("sharesFolder (spec 025)", () => {
  test("the same folder, a folder inside and a folder that holds it", () => {
    expect(sharesFolder("/p/a", "/p/a", false)).toBe(true)
    expect(sharesFolder("/p/a", "/p/a/b", false)).toBe(true)
    expect(sharesFolder("/p/a/b", "/p/a", false)).toBe(true)
  })
  test("a neighbour whose name starts the same is not shared", () => {
    expect(sharesFolder("/p/a", "/p/ab", false)).toBe(false)
    expect(sharesFolder("/p/a", "/q/a", false)).toBe(false)
  })
  test("case counts only where the file system ignores it", () => {
    expect(sharesFolder("/p/Notes", "/p/notes", false)).toBe(false)
    expect(sharesFolder("/p/Notes", "/p/notes", true)).toBe(true)
  })
})

describe("the words of a refusal (spec 025, flow 3)", () => {
  test("the card line names the holder", () => {
    expect(refusedLine("Weekly report")).toBe("Refused: in use by Weekly report")
  })
  test("the node reads the holder, its node and the first words of the prompt", () => {
    const text = refusalText({
      workflow: "A",
      nodeNumber: 2,
      node: "Write plan",
      prompt: "one two three four five six seven eight nine ten",
    })
    expect(text).toContain("Refused: in use by A.")
    expect(text).toContain('Node 2, "Write plan"')
    expect(text).toContain('"one two three four five six seven eight…"')
    expect(text).not.toContain("nine")
    expect(text).toContain('"Blocked:"')
  })
  test("a node that is gone leaves out its name and prompt", () => {
    const text = refusalText({ workflow: "A", nodeNumber: null, node: null, prompt: "" })
    expect(text).toContain("Refused: in use by A.")
    expect(text).not.toContain("Node")
    expect(text).not.toContain("prompt")
  })
  test("a long word list is cut on one line", () => {
    expect(promptStart("a\nb\n\nc")).toBe("a b c")
    expect(promptStart("x".repeat(200))).toHaveLength(80)
    expect(promptStart("")).toBe("")
  })
})

describe("the shared folder note (spec 025)", () => {
  const claim = (i: number) => ({ path: `/p/f${i}`, workflow: "A", nodeNumber: 1, node: "N" })
  test("it lists at most 50 paths and then 'and N more'", () => {
    const note = sharedFolderNote({
      others: ["A", "B"],
      claims: Array.from({ length: CLAIM_NOTE_PATHS + 3 }, (_, i) => claim(i)),
    })
    expect(note).toContain("use your folder too: A, B.")
    expect(note.match(/^- \/p\/f/gm)).toHaveLength(CLAIM_NOTE_PATHS)
    expect(note).toContain("and 3 more")
  })
  test("exactly 50 paths show no 'and N more'", () => {
    const note = sharedFolderNote({
      others: ["A"],
      claims: Array.from({ length: CLAIM_NOTE_PATHS }, (_, i) => claim(i)),
    })
    expect(note).not.toContain("more")
  })
  test("it tells the node the two rules, and says so when nothing is held", () => {
    const note = sharedFolderNote({ others: ["A"], claims: [] })
    expect(note).toContain("No task of them holds a file now.")
    expect(note).toContain("with a shell command either")
    expect(note).toContain('"Blocked:"')
  })
})
