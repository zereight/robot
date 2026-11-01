import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../providers/agent.ts"
import {
  codexArgs,
  codexFailure,
  codexPrompt,
  mapCodexEvent,
  newCodexState,
  parseCodexStatus,
  sandboxFor,
} from "./codex.ts"
import type { RuntimeRun } from "./types.ts"

const run = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
  bin: "codex",
  model: "default",
  effort: null,
  system: "Be brief.",
  prompt: "Hi",
  workspace: "/work/bo",
  permission: "ask_risky",
  useTools: true,
  signal: new AbortController().signal,
  approve: async () => true,
  onLimits: () => {},
  ...patch,
})

const feed = (lines: object[]) => {
  const state = newCodexState()
  const out: AgentEvent[] = []
  for (const line of lines) out.push(...mapCodexEvent(line, state))
  return { state, out }
}

describe("codex status", () => {
  test("a ChatGPT sign-in is a subscription", () => {
    expect(parseCodexStatus("Logged in using ChatGPT\n", 0)).toMatchObject({
      signedIn: true,
      method: "subscription",
    })
  })
  test("a sign-in with an API key is not", () => {
    expect(parseCodexStatus("Logged in using an API key - sk-***", 0).method).toBe("api_key")
  })
  test("no sign-in, or a failing command, reads as signed out", () => {
    expect(parseCodexStatus("Not logged in", 1).signedIn).toBe(false)
    expect(parseCodexStatus("Not logged in", 0).signedIn).toBe(false)
    expect(parseCodexStatus("", 0).signedIn).toBe(false)
  })
})

describe("codex events", () => {
  test("messages join with a blank line; usage ends the turn", () => {
    const { state, out } = feed([
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "1", type: "agent_message", text: "One" } },
      { type: "item.completed", item: { id: "2", type: "agent_message", text: "Two" } },
      {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 7 },
      },
    ])
    expect(out).toEqual([
      { type: "text", text: "One" },
      { type: "text", text: "\n\nTwo" },
      { type: "usage", input: 100, output: 7 },
    ])
    expect(state.done).toBe(true)
  })

  test("a command shows as running, then done or failed", () => {
    const started = {
      type: "item.started",
      item: { id: "c", type: "command_execution", command: "ls", status: "in_progress" },
    }
    const ok = {
      type: "item.completed",
      item: {
        id: "c",
        type: "command_execution",
        command: "ls",
        aggregated_output: "a",
        exit_code: 0,
      },
    }
    const bad = { type: "item.completed", item: { ...ok.item, exit_code: 2 } }
    expect(feed([started, ok]).out).toEqual([
      {
        type: "tool",
        state: "running",
        call: { id: "c", name: "shell", input: '{"command":"ls"}' },
      },
      {
        type: "tool",
        state: "done",
        call: { id: "c", name: "shell", input: '{"command":"ls"}' },
        output: "a",
      },
    ])
    expect(feed([bad]).out[0]).toMatchObject({ state: "failed" })
  })

  test("file changes, web searches and reasoning get a line each", () => {
    const { out } = feed([
      { type: "item.completed", item: { id: "r", type: "reasoning", text: "think" } },
      {
        type: "item.completed",
        item: {
          id: "f",
          type: "file_change",
          status: "completed",
          changes: [{ path: "a.ts", kind: "add" }],
        },
      },
      { type: "item.completed", item: { id: "w", type: "web_search", query: "q" } },
    ])
    expect(out.map((e) => e.type)).toEqual(["thinking", "tool", "tool"])
    expect(out[1]).toMatchObject({ output: "add a.ts" })
  })

  test("a retry error does not fail the turn; a failed turn does", () => {
    const retry = feed([{ type: "error", message: "Reconnecting… 1/5" }])
    expect(retry.state.failed).toBeNull()
    const failed = feed([
      { type: "error", message: "Reconnecting… 1/5" },
      { type: "turn.failed", error: { message: "You've hit your usage limit" } },
    ])
    expect(failed.state.failed).toBe("You've hit your usage limit")
  })

  test("unknown lines are ignored", () => {
    expect(
      feed([{ type: "something.new" }, { type: "item.completed", item: { type: "todo_list" } }])
        .out,
    ).toEqual([])
  })
})

describe("codex run", () => {
  test("the permission level becomes the sandbox", () => {
    expect(sandboxFor("ask_all", true)).toBe("read-only")
    expect(sandboxFor("ask_risky", true)).toBe("workspace-write")
    expect(sandboxFor("full", true)).toBe("danger-full-access")
    expect(sandboxFor("full", false)).toBe("read-only")
  })

  test("the default model is not named, and the prompt comes from stdin", () => {
    const args = codexArgs(run())
    expect(args).not.toContain("-m")
    expect(args.at(-1)).toBe("-")
    expect(args).toContain("--ephemeral")
    expect(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2)).toEqual(["-C", "/work/bo"])
  })

  test("a named model and an effort are passed", () => {
    const args = codexArgs(run({ model: "gpt-x", effort: "high" }))
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-x"])
    expect(args).toContain('model_reasoning_effort="high"')
  })

  test("the instructions go before the conversation", () => {
    expect(codexPrompt(run())).toBe("Be brief.\n\n---\n\nHi")
    expect(codexPrompt(run({ useTools: false }))).toContain("Do not run commands")
    expect(codexPrompt(run({ system: "" }))).toBe("Hi")
  })

  test("failures are told apart", () => {
    expect(codexFailure("You've hit your usage limit").code).toBe("provider_limit")
    expect(codexFailure("401 Unauthorized").code).toBe("runtime_signed_out")
    expect(codexFailure("boom").code).toBe("provider_error")
  })
})
