import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../providers/agent.ts"
import {
  claudeArgs,
  claudeEnv,
  claudeFailure,
  describeRequest,
  type Mapped,
  mapClaudeMessage,
  newStreamState,
  parseClaudeStatus,
  parseUsageReport,
  parseUsageText,
  parseVersion,
} from "./claude.ts"
import type { RuntimeRun } from "./types.ts"

const run = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
  bin: "claude",
  model: "sonnet",
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

const events = (mapped: Mapped[]): AgentEvent[] =>
  mapped.flatMap((m) => (m.kind === "event" ? [m.event] : []))

describe("claude status", () => {
  test("a subscription sign-in is read from the status text", () => {
    const login = parseClaudeStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "a@b.c",
        subscriptionType: "max",
      }),
    )
    expect(login).toEqual({ signedIn: true, method: "subscription", user: "a@b.c", plan: "max" })
  })

  test("a sign-in with a console key or a cloud is not a subscription", () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"console"}').method).toBe("api_key")
    expect(
      parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"}')
        .method,
    ).toBe("api_key")
  })

  test("no sign-in, and text that is not JSON, both read as signed out", () => {
    expect(parseClaudeStatus('{"loggedIn":false}').signedIn).toBe(false)
    expect(parseClaudeStatus("Not logged in").signedIn).toBe(false)
    expect(parseClaudeStatus("").method).toBeNull()
  })

  test("the version is the first number with three parts", () => {
    expect(parseVersion("2.1.316 (Claude Code)")).toBe("2.1.316")
    expect(parseVersion("codex-cli 0.166.0")).toBe("0.166.0")
    expect(parseVersion("nothing")).toBeNull()
  })
})

describe("claude stream", () => {
  test("text and thinking come from the partial messages", () => {
    const state = newStreamState()
    const delta = (d: object) =>
      mapClaudeMessage(
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: d } },
        state,
      )
    expect(events(delta({ type: "text_delta", text: "po" }))).toEqual([
      { type: "text", text: "po" },
    ])
    expect(events(delta({ type: "thinking_delta", thinking: "hm" }))).toEqual([
      { type: "thinking", text: "hm" },
    ])
    expect(delta({ type: "input_json_delta", partial_json: "{" })).toEqual([])
  })

  test("the program tells when it begins to read a message on its input", () => {
    const state = newStreamState()
    const lifecycle = (state_: string) =>
      mapClaudeMessage(
        { type: "command_lifecycle", command_uuid: "m-1", state: state_, uuid: "x" },
        state,
      )
    expect(lifecycle("queued")).toEqual([])
    expect(lifecycle("started")).toEqual([{ kind: "started", id: "m-1" }])
    expect(lifecycle("completed")).toEqual([])
  })

  test("the complete message adds no text twice, but shows each tool call once", () => {
    const state = newStreamState()
    const assistant = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Working" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    }
    const first = events(mapClaudeMessage(assistant, state))
    expect(first).toEqual([
      {
        type: "tool",
        state: "running",
        call: { id: "t1", name: "Bash", input: '{"command":"ls"}' },
      },
    ])
    expect(mapClaudeMessage(assistant, state)).toEqual([])
  })

  test("the tool TodoWrite is the list of steps: its card shows, and the list is reported", () => {
    const state = newStreamState()
    const out = events(
      mapClaudeMessage(
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t2",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "Write the test", status: "completed", activeForm: "Writing" },
                    { content: "Fix the bug", status: "in_progress", activeForm: "Fixing" },
                    { content: "Run the suite", status: "pending", activeForm: "Running" },
                    { content: "  ", status: "pending", activeForm: "" },
                  ],
                },
              },
            ],
          },
        },
        state,
      ),
    )
    expect(out.map((e) => e.type)).toEqual(["tool", "plan"])
    expect(out[1]).toEqual({
      type: "plan",
      steps: [
        { label: "Write the test", done: true },
        { label: "Fix the bug", done: false },
        { label: "Run the suite", done: false },
      ],
    })
  })

  test("a list that was cleared is reported empty; a call with no list reports none", () => {
    const state = newStreamState()
    const call = (id: string, input: object) =>
      events(
        mapClaudeMessage(
          {
            type: "assistant",
            message: { content: [{ type: "tool_use", id, name: "TodoWrite", input }] },
          },
          state,
        ),
      )
    expect(call("a", { todos: [] })[1]).toEqual({ type: "plan", steps: [] })
    expect(call("b", {}).map((e) => e.type)).toEqual(["tool"])
  })

  test("a tool result finishes the card; an error result fails it", () => {
    const state = newStreamState()
    mapClaudeMessage(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      },
      state,
    )
    const done = events(
      mapClaudeMessage(
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "text" }] },
        },
        state,
      ),
    )
    expect(done[0]).toMatchObject({ type: "tool", state: "done", output: "text" })
    const failed = events(
      mapClaudeMessage(
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: true,
                content: [{ type: "text", text: "denied" }],
              },
            ],
          },
        },
        state,
      ),
    )
    expect(failed[0]).toMatchObject({ state: "failed", output: "denied" })
  })

  test("work of a helper agent is left out of the reply", () => {
    const state = newStreamState()
    expect(
      mapClaudeMessage(
        {
          type: "stream_event",
          parent_tool_use_id: "x",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hidden" } },
        },
        state,
      ),
    ).toEqual([])
  })

  test("a permission request names the call that asks", () => {
    const [m] = mapClaudeMessage(
      {
        type: "control_request",
        request_id: "r1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: "t1",
          input: { command: "touch a" },
        },
      },
      newStreamState(),
    )
    expect(m).toEqual({
      kind: "permission",
      requestId: "r1",
      toolUseId: "t1",
      tool: "Bash",
      input: { command: "touch a" },
    })
  })

  test("limits keep their windows, in ms, and tell when requests are refused", () => {
    const [m] = mapClaudeMessage(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_700_000_000,
          unifiedWindows: {
            five_hour: { utilization: 1, resetsAt: 1_700_000_000, status: "rejected" },
            seven_day: { utilization: 0.4, resetsAt: 1_700_500_000, status: "allowed" },
          },
        },
      },
      newStreamState(),
    )
    expect(m).toEqual({
      kind: "limits",
      rejected: true,
      resetsAt: 1_700_000_000_000,
      limits: [
        { window: "five_hour", used: 1, resetsAt: 1_700_000_000_000 },
        { window: "seven_day", used: 0.4, resetsAt: 1_700_500_000_000 },
      ],
    })
  })

  test("the result counts cached input too", () => {
    const [m] = mapClaudeMessage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "pong",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 3161,
          cache_read_input_tokens: 10,
          output_tokens: 4,
        },
      },
      newStreamState(),
    )
    expect(m).toEqual({
      kind: "result",
      ok: true,
      text: "pong",
      input: 3173,
      output: 4,
      cached: 10,
    })
  })
})

describe("claude cost", () => {
  const result = (extra: Record<string, unknown>) =>
    mapClaudeMessage(
      {
        type: "result",
        subtype: "success",
        result: "ok",
        usage: { input_tokens: 2, output_tokens: 4 },
        ...extra,
      },
      newStreamState(),
    )[0]

  test("the cost that the program reports is kept in millionths of a dollar", () => {
    expect(result({ total_cost_usd: 0.0123 })).toMatchObject({ kind: "result", costMicros: 12300 })
  })

  test("a result with no cost, and a result with no cache count, report neither", () => {
    const m = result({}) as Record<string, unknown>
    expect("costMicros" in m).toBe(false)
    expect("cached" in m).toBe(false)
  })
})

describe("claude permission rules", () => {
  const ws = "/work/bo"
  test("a command is risky by the rules of the app", () => {
    expect(describeRequest("c", "Bash", { command: "sudo ls" }, ws)).toMatchObject({
      risky: true,
      key: "run_command:sudo",
    })
    expect(describeRequest("c", "Bash", { command: "touch a.txt" }, ws)).toMatchObject({
      risky: false,
      key: "run_command:touch",
      summary: "touch a.txt",
    })
  })

  test("a file inside the workspace is not risky, outside it is", () => {
    expect(describeRequest("c", "Write", { file_path: "/work/bo/a.txt" }, ws).risky).toBe(false)
    expect(describeRequest("c", "Write", { file_path: "notes/a.txt" }, ws).risky).toBe(false)
    const out = describeRequest("c", "Read", { file_path: "/etc/hosts" }, ws)
    expect(out).toMatchObject({ risky: true, key: "read_file:outside" })
  })

  test("other tools are not risky and keep one key each", () => {
    expect(describeRequest("c", "WebFetch", { url: "https://a.b" }, ws)).toMatchObject({
      risky: false,
      key: "fetch_url",
    })
    expect(describeRequest("c", "mcp__x__y", { a: 1 }, ws).key).toBe("tool:mcp__x__y")
  })
})

describe("claude run", () => {
  test("the arguments keep the user's own settings and servers out", () => {
    const args = claudeArgs(run())
    expect(args).toContain("--strict-mcp-config")
    expect(
      args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2),
    ).toEqual(["--setting-sources", ""])
    expect(args).toContain("--no-session-persistence")
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "sonnet",
    ])
    expect(args).not.toContain("--effort")
  })

  test("the workflow feature of the program is off, so a workflow is a ROBot workflow (spec 010)", () => {
    const args = claudeArgs(run())
    const denied = (args[args.indexOf("--disallowedTools") + 1] ?? "").split(",")
    expect(denied).toContain("Workflow")
    expect(denied).toContain("AskUserQuestion")
  })

  test("effort and instructions are passed; a text-only turn has no tools", () => {
    const args = claudeArgs(run({ effort: "high", useTools: false }))
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ])
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual([
      "--tools",
      "",
    ])
    expect(args).toContain("Be brief.")
  })

  test("an error result becomes a failure that the user can act on", () => {
    expect(claudeFailure("You've hit your limit ∙ resets 3pm", 5000)).toMatchObject({
      code: "provider_limit",
      resetsAt: 5000,
    })
    expect(claudeFailure("Please run /login", null).code).toBe("runtime_signed_out")
    expect(claudeFailure("boom", null).code).toBe("provider_error")
  })
})

describe("claude usage windows", () => {
  test("the structured report gives the share used as 0 to 1 and the reset in ms", () => {
    expect(
      parseUsageReport({
        rate_limits: {
          five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00+00:00" },
          seven_day: { utilization: 75.5, resets_at: "2030-01-02T00:00:00Z" },
          seven_day_opus: null,
        },
      }),
    ).toEqual([
      { window: "five_hour", used: 0.12, resetsAt: Date.parse("2030-01-01T00:00:00Z") },
      { window: "seven_day", used: 0.755, resetsAt: Date.parse("2030-01-02T00:00:00Z") },
    ])
  })

  test("a window with no number is left out; a report with none is null", () => {
    expect(
      parseUsageReport({
        rate_limits: {
          five_hour: { utilization: null, resets_at: null },
          seven_day: { utilization: 5 },
        },
      }),
    ).toEqual([{ window: "seven_day", used: 0.05, resetsAt: null }])
    expect(parseUsageReport({ rate_limits: null })).toBeNull()
    expect(parseUsageReport("nothing")).toBeNull()
    expect(parseUsageReport(undefined)).toBeNull()
  })

  const at = (month: number, day: number, hour: number, minute = 0) =>
    new Date(2026, month, day, hour, minute).getTime()
  const now = at(10, 2, 15)

  test("the text of /usage gives the session and the week; other rows are left out", () => {
    const text = [
      "You are currently using your subscription to power your Claude Code usage",
      "",
      "Current session: 3% used · resets Nov 2 at 7:40pm (Asia/Seoul)",
      "Current week (all models): 75% used · resets Nov 3 at 7am (Asia/Seoul)",
      "Current week (Fable): 16% used · resets Nov 3 at 7am (Asia/Seoul)",
      "",
      "What's contributing to your usage?",
      "  85%  Turn off custom-tools when you don't need it",
    ].join("\n")
    expect(parseUsageText(text, now, "Asia/Seoul")).toEqual([
      { window: "five_hour", used: 0.03, resetsAt: at(10, 2, 19, 40) },
      { window: "seven_day", used: 0.75, resetsAt: at(10, 3, 7) },
    ])
  })

  test("a time with no date is today, or tomorrow when it is past", () => {
    const text = "Current session: 40% used · resets 7pm (Asia/Seoul)"
    expect(parseUsageText(text, now, "Asia/Seoul")?.[0]?.resetsAt).toBe(at(10, 2, 19))
    expect(parseUsageText(text, at(10, 2, 20), "Asia/Seoul")?.[0]?.resetsAt).toBe(at(10, 3, 19))
  })

  test("a date that is long past is next year", () => {
    const text = "Current week (all models): 10% used · resets Jan 5 at 9am (Asia/Seoul)"
    const december = at(11, 30, 12)
    expect(parseUsageText(text, december, "Asia/Seoul")?.[0]?.resetsAt).toBe(
      new Date(2027, 0, 5, 9).getTime(),
    )
  })

  test("a reset in another zone than ours is not placed, but the share is kept", () => {
    const text = "Current session: 3% used · resets Nov 2 at 7:40pm (America/Denver)"
    expect(parseUsageText(text, now, "Asia/Seoul")).toEqual([
      { window: "five_hour", used: 0.03, resetsAt: null },
    ])
  })

  test("a row with no reset, a share over 100, and text with no window", () => {
    expect(parseUsageText("Current session: 130% used", now, "Asia/Seoul")).toEqual([
      { window: "five_hour", used: 1, resetsAt: null },
    ])
    expect(
      parseUsageText("You are currently using your subscription.", now, "Asia/Seoul"),
    ).toBeNull()
    expect(parseUsageText("", now, "Asia/Seoul")).toBeNull()
  })
})

describe("claudeEnv", () => {
  const saved = { ...process.env }
  const restore = () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }

  test("a separate sign-in names its folder, and a key still does not reach the program", () => {
    process.env.ANTHROPIC_API_KEY = "k"
    process.env.CLAUDE_CONFIG_DIR = "/users/own/.claude-other"
    try {
      const env = claudeEnv("/data/sign-ins/claude_code/abc")
      expect(env.CLAUDE_CONFIG_DIR).toBe("/data/sign-ins/claude_code/abc")
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      restore()
    }
  })

  test("without a folder the program keeps whatever place the user set for it", () => {
    process.env.CLAUDE_CONFIG_DIR = "/users/own/.claude-other"
    try {
      expect(claudeEnv().CLAUDE_CONFIG_DIR).toBe("/users/own/.claude-other")
      delete process.env.CLAUDE_CONFIG_DIR
      expect(claudeEnv().CLAUDE_CONFIG_DIR).toBeUndefined()
    } finally {
      restore()
    }
  })
})
