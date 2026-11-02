import { describe, expect, test } from "bun:test"
import {
  changeText,
  checksPerDay,
  lateRunNote,
  resultText,
  runText,
  validWatch,
  WATCH_CHANGE_LINES,
  WATCH_RESULT_CHARS,
  watchArgs,
  watchNeedsConfirm,
  watchRunText,
} from "./watch.ts"

const folder = (files: Record<string, [number, number]>) => resultText({ type: "folder", files })
const output = (text: string, code: number | null = null) =>
  resultText({ type: "output", text, code })

describe("watch: the form", () => {
  test("only the intervals of the spec are valid", () => {
    const watch = (minutes: number) => ({
      minutes,
      target: { kind: "path" as const, path: "notes" },
      postUnchanged: false,
    })
    for (const m of [5, 15, 30, 60, 360, 720, 1440]) expect(validWatch(watch(m))).toBe(true)
    for (const m of [1, 10, 120, 0]) expect(validWatch(watch(m))).toBe(false)
  })

  test("a tool watch needs arguments that are a JSON object", () => {
    const tool = (args: string) => ({
      minutes: 60,
      target: { kind: "tool" as const, connection: "Mail", tool: "count", args },
      postUnchanged: false,
    })
    expect(validWatch(tool('{"folder":"inbox"}'))).toBe(true)
    expect(validWatch(tool(""))).toBe(true)
    expect(validWatch(tool("[1]"))).toBe(false)
    expect(validWatch(tool("{nope"))).toBe(false)
    expect(watchArgs("")).toEqual({})
  })

  test("a watch on a command or a tool needs the confirm; a path does not", () => {
    const of = (target: Parameters<typeof watchNeedsConfirm>[0]["target"]) =>
      watchNeedsConfirm({ minutes: 5, target, postUnchanged: false })
    expect(of({ kind: "path", path: "a" })).toBe(false)
    expect(of({ kind: "command", command: "ls" })).toBe(true)
    expect(of({ kind: "tool", connection: "c", tool: "t", args: "{}" })).toBe(true)
  })

  test("5 minutes is about 288 checks a day", () => {
    expect(checksPerDay(5)).toBe(288)
    expect(checksPerDay(15)).toBe(96)
  })
})

describe("watch: the comparison and the change text", () => {
  test("a folder result does not depend on the order of its files", () => {
    expect(folder({ b: [1, 2], a: [3, 4] })).toBe(folder({ a: [3, 4], b: [1, 2] }))
  })

  test("a folder lists the files that were added, removed and changed", () => {
    const before = folder({ "a.txt": [1, 10], "b.txt": [2, 20], "sub/c.txt": [3, 30] })
    const after = folder({ "a.txt": [1, 10], "b.txt": [5, 21], "sub/d.txt": [4, 40] })
    expect(changeText(before, after, "inbox")).toBe(
      ["Added: sub/d.txt", "Removed: sub/c.txt", "Changed: b.txt"].join("\n"),
    )
  })

  test("a folder change has at most 200 lines", () => {
    const files: Record<string, [number, number]> = {}
    for (let i = 0; i < 500; i++) files[`f${String(i).padStart(3, "0")}.txt`] = [1, 1]
    const text = changeText(folder({}), folder(files), "x")
    const lines = text.split("\n")
    expect(lines).toHaveLength(WATCH_CHANGE_LINES)
    expect(lines.at(-1)).toBe("… and 301 more")
  })

  test("a file names its path", () => {
    const a = resultText({ type: "file", size: 1, mtime: 1, hash: "a" })
    const b = resultText({ type: "file", size: 2, mtime: 2, hash: "b" })
    expect(changeText(a, b, "notes.md")).toBe("Changed: notes.md")
  })

  test("a command gives the old and the new result with the exit code, each cut to 20000", () => {
    const text = changeText(output("one", 0), output("two", 1))
    expect(text).toBe(
      ["Old result:", "one\n[exit code 0]", "", "New result:", "two\n[exit code 1]"].join("\n"),
    )
    const long = changeText(output("x".repeat(30_000)), output("y"))
    expect(long).toContain(`${"x".repeat(WATCH_RESULT_CHARS)}\n[cut]`)
    expect(long).not.toContain("x".repeat(WATCH_RESULT_CHARS + 1))
  })

  test("the text of a run marks the change as outside content", () => {
    const text = watchRunText("Sort the new mail.", "Added: a.eml")
    expect(text.startsWith("Sort the new mail.")).toBe(true)
    expect(text).toContain("comes from outside")
    expect(text.endsWith("Added: a.eml")).toBe(true)
  })
})

describe("late runs", () => {
  const planned = Date.UTC(2026, 10, 2, 7, 0)

  test("a run that starts more than 15 minutes late gets both times in the time zone", () => {
    const note = lateRunNote(planned, planned + 40 * 60_000, "Asia/Seoul")
    expect(note).toContain("Mon 2026-11-02 16:00")
    expect(note).toContain("Mon 2026-11-02 16:40")
    expect(note).toContain("Asia/Seoul")
    expect(runText("Say good morning.", planned, planned + 40 * 60_000, "UTC")).toContain(
      "planned for Mon 2026-11-02 07:00 and started at Mon 2026-11-02 07:40",
    )
  })

  test("a run up to 15 minutes late, and a run now, get the prompt only", () => {
    expect(lateRunNote(planned, planned + 15 * 60_000, "UTC")).toBeNull()
    expect(runText("Hi", planned, planned + 60_000, "UTC")).toBe("Hi")
    expect(runText("Hi", null, planned, "UTC")).toBe("Hi")
  })
})
