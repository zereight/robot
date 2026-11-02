import { describe, expect, test } from "bun:test"
import type { LoggedStep, MessagePart } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import { stepWatch } from "./stepWatch.ts"

const call = (id: string, name: string, input: object = {}) => ({
  id,
  name,
  input: JSON.stringify(input),
})
const running = (c: ReturnType<typeof call>): AgentEvent => ({
  type: "tool",
  state: "running",
  call: c,
})
const done = (c: ReturnType<typeof call>, over: { failed?: boolean; refused?: boolean } = {}) =>
  ({
    type: "tool",
    state: over.failed ? "failed" : "done",
    call: c,
    output: "",
    ...(over.refused ? { notRun: true } : {}),
  }) as AgentEvent

const make = (limit = 20, before = 0) => {
  const logged: (Omit<LoggedStep, "at"> & { callId: string })[] = []
  let stops = 0
  const watch = stepWatch({
    limit,
    before,
    stop: () => stops++,
    record: (step) => logged.push(step),
  })
  return { watch, logged, stops: () => stops }
}

describe("step watch", () => {
  test("it stops the turn when the count of ended steps reaches the limit, once", () => {
    const { watch, stops } = make(3)
    for (let i = 1; i <= 2; i++) {
      watch.see(done(call(`c${i}`, "list_files")))
      expect(watch.hit).toBe(false)
    }
    watch.see(done(call("c3", "list_files")))
    expect(watch.hit).toBe(true)
    watch.see(done(call("c4", "list_files")))
    expect(stops()).toBe(1)
  })

  test("a step that only started does not count, and steps of an earlier part do", () => {
    const { watch } = make(3, 2)
    watch.see(running(call("a", "list_files")))
    expect(watch.hit).toBe(false)
    watch.see(done(call("a", "list_files")))
    expect(watch.hit).toBe(true)
  })

  test("it logs files, shell commands, web pages and connection tools, and skips the other tools", () => {
    const { watch, logged } = make()
    watch.see(done(call("1", "write_file", { path: "a.txt", content: "x" })))
    watch.see(done(call("2", "read_file", { path: "a.txt" })))
    watch.see(done(call("3", "run_command", { command: "make" }), { failed: true }))
    watch.see(done(call("4", "fetch_url", { url: "https://example.com" })))
    watch.see(done(call("5", "mcp__github__create_issue", { title: "t" })))
    watch.see(done(call("6", "browser_open", { url: "https://example.com" })))
    watch.see(done(call("7", "save_memory", { text: "x" })))
    expect(logged).toEqual([
      { callId: "1", kind: "file", access: "write", target: "a.txt", result: "ran" },
      { callId: "2", kind: "file", access: "read", target: "a.txt", result: "ran" },
      { callId: "3", kind: "shell", access: null, target: "make", result: "failed" },
      { callId: "4", kind: "web", access: null, target: "https://example.com", result: "ran" },
      {
        callId: "5",
        kind: "connection",
        access: null,
        target: "mcp__github__create_issue",
        result: "ran",
      },
    ])
  })

  test("a step that the user or the level refused is logged as Refused", () => {
    const { watch, logged } = make()
    watch.see(done(call("1", "run_command", { command: "rm x" }), { failed: true, refused: true }))
    expect(logged[0]?.result).toBe("refused")
  })

  test("a call is logged once", () => {
    const { watch, logged } = make()
    watch.see(done(call("1", "write_file", { path: "a" })))
    watch.see(done(call("1", "write_file", { path: "a" })))
    expect(logged).toHaveLength(1)
  })

  test("at the end, a step that still runs is logged as Stopped; one that waits is not", () => {
    const { watch, logged } = make()
    const tool = (id: string, name: string, state: "running" | "waiting"): MessagePart => ({
      kind: "tool",
      id,
      name,
      label: name,
      state,
      input: JSON.stringify({ command: "sleep 100" }),
      output: "",
    })
    watch.end([tool("1", "run_command", "running"), tool("2", "run_command", "waiting")])
    expect(logged).toEqual([
      { callId: "1", kind: "shell", access: null, target: "sleep 100", result: "stopped" },
    ])
  })

  test("a step that the level refused for a program is logged as Refused, by the mark in the parts", () => {
    const { watch, logged } = make()
    const mark = (id: string): MessagePart => ({
      kind: "tool",
      id,
      name: "run_command",
      label: "run_command",
      state: "failed",
      input: "{}",
      output: "",
      refused: "read_only",
    })
    watch.see(done(call("1", "run_command", { command: "rm x" }), { failed: true }), [mark("1")])
    expect(logged[0]?.result).toBe("refused")
  })
  test("a step that Read only refuses is logged as Refused for every kind of the log, and the browser has none (spec 007)", () => {
    const { watch, logged } = make()
    const refused = (id: string, name: string, input: object) =>
      ({
        type: "tool",
        state: "failed",
        call: call(id, name, input),
        output: "Refused",
        refused: "read_only",
      }) as AgentEvent
    watch.see(refused("1", "write_file", { path: "a.txt", content: "x" }))
    watch.see(refused("2", "run_command", { command: "rm -rf x" }))
    // The tool of a connection: the target is the name, never the arguments.
    watch.see(refused("3", "mcp__files__remove", { path: "secret-argument.txt" }))
    // The browser is no kind of the action log.
    watch.see(refused("4", "browser_open", { url: "https://example.com" }))
    expect(logged.map((l) => [l.kind, l.access, l.target, l.result])).toEqual([
      ["file", "write", "a.txt", "refused"],
      ["shell", null, "rm -rf x", "refused"],
      ["connection", null, "mcp__files__remove", "refused"],
    ])
  })
})
