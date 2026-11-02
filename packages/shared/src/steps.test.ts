import { describe, expect, test } from "bun:test"
import {
  CHAIN_LIMIT,
  CHAIN_LIMIT_TEXT,
  chainAtLimit,
  createReadGuard,
  fileAccess,
  isStepLimit,
  type LoggedStep,
  loggedKind,
  mayChange,
  RETRY_NOTE_STEPS,
  remoteRetryNote,
  retryNote,
  STEP_LIMIT_DEFAULT,
  STEP_LIMIT_MAX,
  STEP_LIMIT_MIN,
  stepTarget,
  TARGET_MAX,
  taskDepth,
} from "./steps.ts"

const step = (over: Partial<LoggedStep> = {}): LoggedStep => ({
  kind: "file",
  access: "write",
  target: "a.txt",
  result: "ran",
  at: 1,
  ...over,
})

describe("depth of a task", () => {
  test("a task that the user starts has depth 0", () => {
    expect(taskDepth({ kind: "none" })).toBe(0)
  })
  test("a message, and the reply to a message, make a task one deeper than the task that caused it", () => {
    expect(taskDepth({ kind: "message", depth: 0 })).toBe(1)
    expect(taskDepth({ kind: "message", depth: 8 })).toBe(9)
  })
  test("a part, a nudge and a retry keep the depth", () => {
    expect(taskDepth({ kind: "same", depth: 5 })).toBe(5)
  })
  test("a task at depth 8 or more cannot send; the reason text names the limit", () => {
    expect(chainAtLimit(CHAIN_LIMIT - 1)).toBe(false)
    expect(chainAtLimit(CHAIN_LIMIT)).toBe(true)
    expect(chainAtLimit(9)).toBe(true)
    expect(CHAIN_LIMIT_TEXT).toBe("The chain of agent messages is at its limit (8).")
  })
})

describe("step limit", () => {
  test("the setting is a whole number from 20 to 2000, default 300", () => {
    expect(STEP_LIMIT_DEFAULT).toBe(300)
    expect(isStepLimit(STEP_LIMIT_MIN)).toBe(true)
    expect(isStepLimit(STEP_LIMIT_MAX)).toBe(true)
    expect(isStepLimit(19)).toBe(false)
    expect(isStepLimit(2001)).toBe(false)
    expect(isStepLimit(20.5)).toBe(false)
    expect(isStepLimit(Number.NaN)).toBe(false)
    expect(isStepLimit("300")).toBe(false)
  })
})

describe("which steps may change things", () => {
  test("a file write, a shell command and a tool of a connection do; reads, fetches and refused steps do not", () => {
    expect(mayChange(step())).toBe(true)
    expect(mayChange(step({ kind: "shell", access: null }))).toBe(true)
    expect(mayChange(step({ kind: "connection", access: null }))).toBe(true)
    expect(mayChange(step({ access: "read" }))).toBe(false)
    expect(mayChange(step({ kind: "web", access: null }))).toBe(false)
    expect(mayChange(step({ result: "refused" }))).toBe(false)
    expect(mayChange(step({ kind: "shell", access: null, result: "refused" }))).toBe(false)
  })
  test("a step that failed or stopped may have run in part", () => {
    expect(mayChange(step({ result: "failed" }))).toBe(true)
    expect(mayChange(step({ result: "stopped" }))).toBe(true)
  })
  test("the tools of the app and of vendor programs get a kind and a read-or-write mark", () => {
    expect(loggedKind("read_file")).toBe("file")
    expect(loggedKind("write_file")).toBe("file")
    expect(loggedKind("run_command")).toBe("shell")
    expect(loggedKind("Bash")).toBe("shell")
    expect(loggedKind("fetch_url")).toBe("web")
    expect(loggedKind("mcp__github__create_issue")).toBe("connection")
    expect(loggedKind("browser_open")).toBeNull()
    expect(loggedKind("save_memory")).toBeNull()
    for (const name of ["list_files", "read_file", "search_files", "Read", "Glob", "Grep"])
      expect(fileAccess(name)).toBe("read")
    for (const name of ["write_file", "Write", "Edit", "MultiEdit", "apply_patch", "file_change"])
      expect(fileAccess(name)).toBe("write")
    // A file tool that is not known counts as a write.
    expect(fileAccess("rename_file")).toBe("write")
  })
})

describe("target of a step", () => {
  test("a path, a command or an address, cut at 200 characters", () => {
    expect(stepTarget("write_file", JSON.stringify({ path: "notes/a.txt", content: "x" }))).toBe(
      "notes/a.txt",
    )
    expect(stepTarget("run_command", JSON.stringify({ command: "ls   -la" }))).toBe("ls -la")
    expect(stepTarget("fetch_url", JSON.stringify({ url: "https://example.com" }))).toBe(
      "https://example.com",
    )
    const long = stepTarget("run_command", JSON.stringify({ command: "x".repeat(500) }))
    expect([...long]).toHaveLength(TARGET_MAX)
  })
  test("a tool of a connection holds its name and never its arguments", () => {
    const target = stepTarget("mcp__github__create_issue", JSON.stringify({ title: "secret plan" }))
    expect(target).toBe("mcp__github__create_issue")
  })
  test("text that looks like a secret is hidden", () => {
    const target = stepTarget(
      "run_command",
      JSON.stringify({
        command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' x",
      }),
    )
    expect(target).not.toContain("abcdefghijklmnopqrstuvwxyz0123")
    expect(target).toContain("[redacted]")
  })
  test("an input that is not JSON gives an empty target", () => {
    expect(stepTarget("run_command", "not json")).toBe("")
  })
})

describe("retry note", () => {
  test("no step that may change things: no note, the retry starts at once", () => {
    expect(retryNote([])).toBeNull()
    expect(retryNote([step({ access: "read" }), step({ kind: "web", access: null })])).toBeNull()
    expect(retryNote([step({ result: "refused" })])).toBeNull()
  })
  test("it lists the steps that may change things, newest first, with the kind, target and result", () => {
    const note = retryNote([
      step({ target: "old.txt", at: 1 }),
      step({ access: "read", target: "read.txt", at: 2 }),
      step({ kind: "shell", access: null, target: "make", result: "failed", at: 3 }),
    ])
    expect(note?.computer).toBeNull()
    expect(note?.more).toBe(0)
    expect(note?.steps.map((x) => [x.kind, x.target, x.result])).toEqual([
      ["shell", "make", "failed"],
      ["file", "old.txt", "ran"],
    ])
  })
  test("it lists at most 5 and counts the rest", () => {
    const steps = Array.from({ length: 8 }, (_, i) => step({ target: `f${i}`, at: i }))
    const note = retryNote(steps)
    expect(RETRY_NOTE_STEPS).toBe(5)
    expect(note?.steps.map((x) => x.target)).toEqual(["f7", "f6", "f5", "f4", "f3"])
    expect(note?.more).toBe(3)
    expect(retryNote(steps.slice(0, 5))?.more).toBe(0)
  })
  test("when the steps are on another computer, the note has no list and names it", () => {
    expect(remoteRetryNote("MacBook 2")).toEqual({ computer: "MacBook 2", steps: [], more: 0 })
  })
})

describe("repeated reads", () => {
  test("the third read of one target with one result is refused", () => {
    const guard = createReadGuard()
    expect(guard.refuse("read_file", "/w/a.txt", "one")).toBe(false)
    expect(guard.refuse("read_file", "/w/a.txt", "one")).toBe(false)
    expect(guard.refuse("read_file", "/w/a.txt", "one")).toBe(true)
  })
  test("a read that gives a new result is not refused, and the count starts again", () => {
    const guard = createReadGuard()
    for (let i = 0; i < 3; i++) guard.refuse("read_file", "/w/a.txt", "one")
    expect(guard.refuse("read_file", "/w/a.txt", "two")).toBe(false)
    expect(guard.refuse("read_file", "/w/a.txt", "two")).toBe(false)
    expect(guard.refuse("read_file", "/w/a.txt", "two")).toBe(true)
  })
  test("another target, another tool, or a different result in between is not a repeat", () => {
    const guard = createReadGuard()
    expect(guard.refuse("read_file", "/w/a.txt", "one")).toBe(false)
    expect(guard.refuse("read_file", "/w/b.txt", "one")).toBe(false)
    expect(guard.refuse("fetch_url", "/w/a.txt", "one")).toBe(false)
    expect(guard.refuse("read_file", "/w/a.txt", "one")).toBe(false)
    expect(guard.refuse("read_file", "/w/a.txt", "other")).toBe(false)
    expect(guard.refuse("read_file", "/w/a.txt", "one")).toBe(false)
  })
  test("a refused read still counts, so the next unchanged read is refused too", () => {
    const guard = createReadGuard()
    for (let i = 0; i < 3; i++) guard.refuse("fetch_url", "https://x", "page")
    expect(guard.refuse("fetch_url", "https://x", "page")).toBe(true)
  })
  test("a turn has its own guard", () => {
    const one = createReadGuard()
    const two = createReadGuard()
    for (let i = 0; i < 3; i++) one.refuse("read_file", "a", "x")
    expect(two.refuse("read_file", "a", "x")).toBe(false)
  })
})
