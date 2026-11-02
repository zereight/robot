import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseResult, WATCH_OUTPUT_MAX } from "@robot/shared"
import { runCheck } from "./watchCheck.ts"

const root = mkdtempSync(join(tmpdir(), "robot-watch-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const result = async (outcome: Promise<Awaited<ReturnType<typeof runCheck>>>) => {
  const o = await outcome
  if (!o.ok) throw new Error(`failed: ${o.reason.code}`)
  return o.result
}

describe("a check of a file or a folder", () => {
  test("a folder lists its files, also in its folders; a new file changes the result", async () => {
    const dir = join(root, "inbox")
    mkdirSync(join(dir, "sub"), { recursive: true })
    writeFileSync(join(dir, "a.txt"), "one")
    writeFileSync(join(dir, "sub", "b.txt"), "two")
    const first = await result(runCheck({ kind: "path", path: "inbox" }, { workspace: root }))
    const parsed = parseResult(first)
    expect(parsed?.type).toBe("folder")
    expect(Object.keys(parsed?.type === "folder" ? parsed.files : {})).toEqual([
      "a.txt",
      "sub/b.txt",
    ])
    expect(await result(runCheck({ kind: "path", path: dir }, { workspace: "/" }))).toBe(first)
    writeFileSync(join(dir, "new.txt"), "three")
    expect(await result(runCheck({ kind: "path", path: "inbox" }, { workspace: root }))).not.toBe(
      first,
    )
  })

  test("a file compares its content: the same size and time with other bytes is a change", async () => {
    const file = join(root, "note.txt")
    writeFileSync(file, "aaaa")
    utimesSync(file, 1000, 1000)
    const first = await result(runCheck({ kind: "path", path: file }, { workspace: root }))
    writeFileSync(file, "bbbb")
    utimesSync(file, 1000, 1000)
    const second = await result(runCheck({ kind: "path", path: file }, { workspace: root }))
    expect(second).not.toBe(first)
  })

  test("a path that does not exist fails the check", async () => {
    const outcome = await runCheck({ kind: "path", path: "nowhere" }, { workspace: root })
    expect(outcome).toEqual({ ok: false, reason: { code: "watch_missing", detail: "nowhere" } })
  })
})

describe("a check of a command", () => {
  test("it runs in the workspace; an exit code that is not 0 is part of the result", async () => {
    const outcome = await runCheck(
      { kind: "command", command: "cat missing.txt" },
      { workspace: root },
    )
    expect(outcome.ok).toBe(true)
    const parsed = parseResult(outcome.ok ? outcome.result : "")
    expect(parsed?.type === "output" && parsed.code).not.toBe(0)
    expect(parsed?.type === "output" && parsed.text).toContain("missing.txt")
    writeFileSync(join(root, "here.txt"), "hello")
    const here = await result(
      runCheck({ kind: "command", command: "cat here.txt" }, { workspace: root }),
    )
    expect(parseResult(here)).toEqual({ type: "output", text: "hello", code: 0 })
  })

  test("it keeps at most 1 MB of output", async () => {
    const out = await result(
      runCheck(
        { kind: "command", command: "head -c 3000000 /dev/zero | tr '\\0' 'a'" },
        { workspace: root },
      ),
    )
    const parsed = parseResult(out)
    expect(parsed?.type === "output" && parsed.text.length).toBe(WATCH_OUTPUT_MAX)
  })

  test("a command over the time limit fails the check", async () => {
    const outcome = await runCheck(
      { kind: "command", command: "sleep 5" },
      { workspace: root, limitMs: 200 },
    )
    expect(outcome).toEqual({ ok: false, reason: { code: "watch_timeout", detail: "" } })
  })
})

describe("refusals and tools", () => {
  test("a Deny rule that matches refuses the check, and nothing runs", async () => {
    const marker = join(root, "ran.txt")
    const outcome = await runCheck(
      { kind: "command", command: `echo x > ${marker}` },
      { workspace: root, denied: true },
    )
    expect(outcome).toEqual({ ok: false, reason: { code: "watch_denied", detail: "" } })
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("a tool is called with its arguments; a failed call and a missing connection fail", async () => {
    const calls: unknown[] = []
    const ok = await runCheck(
      { kind: "tool", connection: "Mail", tool: "count", args: '{"folder":"inbox"}' },
      {
        workspace: root,
        callTool: async (connection, tool, args) => {
          calls.push({ connection, tool, args })
          return "3 new"
        },
      },
    )
    expect(calls).toEqual([{ connection: "Mail", tool: "count", args: { folder: "inbox" } }])
    expect(ok.ok && parseResult(ok.result)).toEqual({ type: "output", text: "3 new", code: null })
    const failed = await runCheck(
      { kind: "tool", connection: "Mail", tool: "count", args: "{}" },
      {
        workspace: root,
        callTool: async () => {
          throw new Error("server down")
        },
      },
    )
    expect(failed).toEqual({
      ok: false,
      reason: { code: "watch_tool_failed", detail: "server down" },
    })
    const none = await runCheck(
      { kind: "tool", connection: "Mail", tool: "count", args: "{}" },
      { workspace: root },
    )
    expect(none).toEqual({ ok: false, reason: { code: "watch_no_connection", detail: "Mail" } })
  })

  test("a tool over the time limit fails the check", async () => {
    const outcome = await runCheck(
      { kind: "tool", connection: "Mail", tool: "count", args: "{}" },
      { workspace: root, limitMs: 100, callTool: () => new Promise(() => {}) },
    )
    expect(outcome).toEqual({ ok: false, reason: { code: "watch_timeout", detail: "" } })
  })
})
