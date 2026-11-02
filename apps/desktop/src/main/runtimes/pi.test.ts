import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../providers/agent.ts"
import {
  mapPiEvent,
  newPiState,
  parsePiModels,
  piArgs,
  pickEfforts,
  piFailure,
  piTools,
} from "./pi.ts"
import type { RuntimeRun } from "./types.ts"

const run = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
  bin: "pi",
  model: "claude-bridge/claude-haiku-4-5",
  effort: null,
  system: "",
  prompt: "Hi",
  workspace: "/work/bo",
  permission: "ask_risky",
  useTools: true,
  signal: new AbortController().signal,
  approve: async () => true,
  onLimits: () => {},
  ...patch,
})

const TABLE = `provider       model              context  max-out  thinking  images
anthropic      claude-opus-4-5    200K     64K      yes       yes
claude-bridge  claude-haiku-4-5   200K     64K      no        yes
`

describe("pi models", () => {
  test("reads the table of models that the program can use", () => {
    expect(parsePiModels(TABLE)).toEqual([
      {
        id: "anthropic/claude-opus-4-5",
        label: "anthropic/claude-opus-4-5",
        efforts: ["low", "medium", "high"],
      },
      {
        id: "claude-bridge/claude-haiku-4-5",
        label: "claude-bridge/claude-haiku-4-5",
        efforts: [],
      },
    ])
  })
  test("a header only, or a message, has no models", () => {
    expect(parsePiModels("provider model context max-out thinking images\n")).toEqual([])
    expect(parsePiModels("No models available.\n")).toEqual([])
    expect(parsePiModels("")).toEqual([])
  })
})

describe("pi levels", () => {
  test("a model keeps the levels it takes, in order, without off", () => {
    expect(pickEfforts(["off", "minimal", "low", "medium", "high", "max"])).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ])
    expect(pickEfforts(["low", "medium", "high", "xhigh", "max"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })
  test("a model without thinking has no level, and a level of the future is left out", () => {
    expect(pickEfforts(["off"])).toEqual([])
    expect(pickEfforts(["low", "ultra"])).toEqual(["low"])
    expect(pickEfforts(null)).toEqual([])
  })
})

describe("pi command", () => {
  test("a run has no session, and none of the user's files", () => {
    const args = piArgs(run(), null)
    expect(args.slice(0, 3)).toEqual(["-p", "--mode", "json"])
    for (const flag of ["--no-session", "--no-context-files", "--no-skills", "--no-mcp"])
      expect(args).toContain(flag)
    expect(args[args.indexOf("--model") + 1]).toBe("claude-bridge/claude-haiku-4-5")
  })
  test("effort and the system text are passed", () => {
    const args = piArgs(run({ effort: "high" }), "/tmp/system.md")
    expect(args[args.indexOf("--thinking") + 1]).toBe("high")
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/tmp/system.md")
  })
  test("the permission level becomes the list of tools", () => {
    expect(piTools("ask_all", true)).toEqual(["--tools", "read,grep,find,ls"])
    expect(piTools("ask_risky", true)).toEqual(["--tools", "read,grep,find,ls,edit,write"])
    expect(piTools("full", true)).toEqual([])
    expect(piTools("full", false)).toEqual(["--no-tools"])
  })
  test("the browser of the app stays in a list of tools, which would hold back an extension", () => {
    const browser = ["browser_open", "browser_read"]
    expect(piTools("ask_all", true, browser)).toEqual([
      "--tools",
      "read,grep,find,ls,browser_open,browser_read",
    ])
    expect(piTools("ask_risky", true, browser)).toEqual([
      "--tools",
      "read,grep,find,ls,edit,write,browser_open,browser_read",
    ])
    // Full access has no list, and a run that may not use tools has none of them.
    expect(piTools("full", true, browser)).toEqual([])
    expect(piTools("full", false, browser)).toEqual(["--no-tools"])
  })
  test("a run with the access loads the extension, and keeps the user's servers out", () => {
    const access = {
      url: "http://127.0.0.1:1/mcp",
      token: "t0k3n",
      tools: [{ name: "browser_open", description: "d", schema: { type: "object" } }],
    }
    const args = piArgs(run({ bridge: access }), null, "/tmp/robot-bridge-x/pi.mjs")
    expect(args[args.indexOf("--extension") + 1]).toBe("/tmp/robot-bridge-x/pi.mjs")
    expect(args).toContain("--no-mcp")
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,edit,write,browser_open")
    expect(args.join(" ")).not.toContain("t0k3n")
    expect(piArgs(run(), null)).not.toContain("--extension")
  })
})

describe("pi stream", () => {
  const feed = (lines: unknown[]) => {
    const state = newPiState()
    const out: AgentEvent[] = []
    for (const line of lines) out.push(...mapPiEvent(line, state))
    return { state, out }
  }
  test("text, thinking and tools", () => {
    const { state, out } = feed([
      { type: "agent_start" },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "po" } },
      { type: "message_update", assistantMessageEvent: { type: "text_start" } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: { path: "." } },
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "ls",
        isError: false,
        result: { content: [{ type: "text", text: "a\nb" }] },
      },
      {
        type: "turn_end",
        message: {
          stopReason: "stop",
          usage: { input: 10, cacheRead: 5, cacheWrite: 1, output: 3 },
        },
      },
      { type: "agent_settled" },
    ])
    expect(out).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "po" },
      { type: "tool", state: "running", call: { id: "t1", name: "ls", input: '{"path":"."}' } },
      { type: "tool", state: "done", call: { id: "t1", name: "ls", input: "{}" }, output: "a\nb" },
    ])
    expect(state).toMatchObject({ input: 16, output: 3, error: null, done: true })
  })
  test("an error inside a turn is kept, because the program still exits well", () => {
    const { state } = feed([
      {
        type: "turn_end",
        message: { stopReason: "error", errorMessage: "400 extra usage", content: [] },
      },
      { type: "agent_settled" },
    ])
    expect(state.error).toBe("400 extra usage")
  })
  test("a tool error is marked failed", () => {
    const { out } = feed([
      { type: "tool_execution_end", toolCallId: "t", toolName: "x", isError: true, result: {} },
    ])
    expect(out[0]).toMatchObject({ state: "failed" })
  })
  test("failures are sorted by what the user can do about them", () => {
    expect(piFailure("400 Third-party apps now draw from your extra usage").code).toBe(
      "provider_limit",
    )
    expect(piFailure("401 unauthorized").code).toBe("runtime_signed_out")
    expect(piFailure("boom").code).toBe("provider_error")
  })
})
