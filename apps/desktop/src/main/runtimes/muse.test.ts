import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../providers/agent.ts"
import {
  commandId,
  describeMuseApproval,
  mapMuseLine,
  mapMuseNotification,
  museArgs,
  museAsks,
  museFailure,
  museHostArgs,
  musePrompt,
  museSafety,
  newMuseHostState,
  newMuseState,
  parseMuseUsage,
  parseSignInPrompt,
  pickMuseChoice,
} from "./muse.ts"
import type { RuntimeRun } from "./types.ts"

const run = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
  bin: "muse",
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

describe("muse usage", () => {
  test("an account gives its plan and its usage windows", () => {
    const login = parseMuseUsage(
      JSON.stringify({
        schemaVersion: 1,
        allowance: {
          tier: "Muse Code Power Usage",
          window: { usedPercent: 12.5, resetsAtMs: 1793554546000 },
          weekly: { usedPercent: 40, resetsAtMs: 1793900000000 },
        },
        reason: null,
      }),
      0,
    )
    expect(login).toMatchObject({
      signedIn: true,
      method: "subscription",
      plan: "Muse Code Power Usage",
    })
    expect(login.limits).toEqual([
      { window: "window", used: 0.125, resetsAt: 1793554546000 },
      { window: "weekly", used: 0.4, resetsAt: 1793900000000 },
    ])
  })
  test("a key in the environment is not a subscription", () => {
    expect(
      parseMuseUsage(JSON.stringify({ schemaVersion: 1, allowance: null, reason: "api_key" }), 0),
    ).toMatchObject({ signedIn: true, method: "api_key" })
  })
  test("an account that has no usage data yet is still signed in", () => {
    expect(
      parseMuseUsage(
        JSON.stringify({ schemaVersion: 1, allowance: null, reason: "server_sent_no_usage" }),
        0,
      ),
    ).toMatchObject({ signedIn: true, method: "subscription", plan: null })
  })
  test("a failing command, or text that is not JSON, reads as signed out", () => {
    expect(parseMuseUsage("", 1).signedIn).toBe(false)
    expect(parseMuseUsage("not json", 0).signedIn).toBe(false)
    expect(parseMuseUsage(JSON.stringify({ allowance: null, reason: null }), 0).signedIn).toBe(
      false,
    )
  })
})

describe("muse sign-in prompt", () => {
  test("takes the page and the code from the text of the program", () => {
    const text =
      "\nOpen this page to sign in:\n  https://auth.meta.com/device?code=AB12\nConfirm this code matches:\n  \u001b[1mQXZK-7M2P\u001b[0m\n\n"
    expect(parseSignInPrompt(text)).toEqual({
      url: "https://auth.meta.com/device?code=AB12",
      code: "QXZK-7M2P",
    })
  })
  test("waits for the code when only the page is printed", () => {
    expect(
      parseSignInPrompt("Open this page to sign in:\n  https://auth.meta.com/device\n"),
    ).toEqual({
      url: "https://auth.meta.com/device",
      code: null,
    })
  })
})

describe("muse stream", () => {
  const feed = (lines: unknown[]) => {
    const state = newMuseState()
    const out: ReturnType<typeof mapMuseLine> = []
    for (const line of lines) out.push(...mapMuseLine(line, state))
    return { state, out }
  }
  const events = (out: ReturnType<typeof mapMuseLine>): AgentEvent[] =>
    out.flatMap((o) => (o.kind === "event" ? [o.event] : []))

  test("text, tool results, usage and the end", () => {
    const { state, out } = feed([
      { payload_type: "run.lifecycle.started", payload: {} },
      {
        payload_type: "tool.result",
        payload: {
          call_id: "c1",
          text: "wrote 2 bytes to /work/made.txt",
          edit_facts: { tool_name: "write_file", path: "made.txt", added: 1 },
          correlation_facts: { tool_name: "write_file", outcome: "success" },
        },
      },
      {
        payload_type: "tool.result",
        payload: {
          call_id: "c2",
          text: JSON.stringify({ command: "ls -la", exit_code: 0, output: "x" }),
          correlation_facts: { tool_name: "exec_command", outcome: "success" },
        },
      },
      { payload_type: "run.output.delta", payload: { text: "done" } },
      {
        payload_type: "run.usage",
        payload: {
          models: [{ model: "m", input_tokens: 100, output_tokens: 7 }],
          allowance: {
            window: { used_percent: 5, resets_at_ms: 1793554546000 },
            weekly: { used_percent: 10, resets_at_ms: 1793900000000 },
          },
        },
      },
      { payload_type: "run.terminal.completed", payload: { terminal: "completed", text: "done" } },
    ])
    expect(events(out)).toEqual([
      {
        type: "tool",
        state: "done",
        call: { id: "c1", name: "write_file", input: JSON.stringify({ path: "made.txt" }) },
        output: "wrote 2 bytes to /work/made.txt",
      },
      {
        type: "tool",
        state: "done",
        call: { id: "c2", name: "exec_command", input: JSON.stringify({ command: "ls -la" }) },
        output: JSON.stringify({ command: "ls -la", exit_code: 0, output: "x" }),
      },
      { type: "text", text: "done" },
      { type: "usage", input: 100, output: 7 },
    ])
    expect(out.find((o) => o.kind === "limits")).toEqual({
      kind: "limits",
      limits: [
        { window: "window", used: 0.05, resetsAt: 1793554546000 },
        { window: "weekly", used: 0.1, resetsAt: 1793900000000 },
      ],
    })
    expect(state).toMatchObject({ done: true, failed: null, hasText: true })
  })
  test("an answer that came only at the end is still shown, once", () => {
    const { out } = feed([
      { payload_type: "run.terminal.completed", payload: { terminal: "completed", text: "Hello" } },
    ])
    expect(events(out)).toEqual([{ type: "text", text: "Hello" }])
  })
  test("a run that ended without completing is a failure", () => {
    const { state } = feed([
      {
        payload_type: "run.terminal.failed",
        payload: { terminal: "failed", reason: "usage limit reached" },
      },
    ])
    expect(state.done).toBe(false)
    expect(state.failed).toBe("usage limit reached")
  })
  test("a failed tool result is marked failed", () => {
    const { out } = feed([
      {
        payload_type: "tool.result",
        payload: {
          call_id: "c",
          text: "no",
          correlation_facts: { tool_name: "x", outcome: "error" },
        },
      },
    ])
    expect(events(out)[0]).toMatchObject({ type: "tool", state: "failed" })
  })
  test("other lines say nothing", () => {
    const { out } = feed([{ payload_type: "task.lifecycle.started", payload: {} }, "x", null])
    expect(out).toEqual([])
  })
})

describe("muse command", () => {
  test("a headless run keeps the user's files and sessions out", () => {
    const args = museArgs(run(), "/tmp/p.txt")
    expect(args.slice(0, 2)).toEqual(["exec", "--json"])
    for (const flag of ["--no-session-log", "--no-foreign-personal-context", "--disable-reminders"])
      expect(args).toContain(flag)
    expect(args).toContain("--prompt-file")
    expect(args[args.indexOf("--workspace") + 1]).toBe("/work/bo")
    expect(args).not.toContain("--model")
  })
  test("a chosen model and effort are passed", () => {
    const args = museArgs(run({ model: "muse-spark-1.3", effort: "high" }), "/tmp/p.txt")
    expect(args[args.indexOf("--model") + 1]).toBe("muse-spark-1.3")
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high")
  })
  test("the permission level limits the tools, because the run cannot ask", () => {
    expect(museSafety(run({ permission: "ask_all" }))).toEqual([
      "--disable-write",
      "--disable-shell",
    ])
    expect(museSafety(run({ permission: "ask_risky" }))).toEqual([])
    expect(museSafety(run({ permission: "full" }))).toEqual([
      "--disable-approval",
      "--disable-sandbox",
    ])
    expect(museSafety(run({ useTools: false }))).toContain("--disable-shell")
  })
  test("the system text comes before the prompt", () => {
    expect(musePrompt(run())).toBe("Be brief.\n\n---\n\nHi")
    expect(musePrompt(run({ system: " " }))).toBe("Hi")
  })
  test("failures are sorted by what the user can do about them", () => {
    expect(museFailure("muse usage: not logged in: run `muse login` first").code).toBe(
      "runtime_signed_out",
    )
    expect(museFailure("Allowance used up for this window").code).toBe("provider_limit")
    expect(museFailure("boom").code).toBe("provider_error")
  })
})

describe("muse session host", () => {
  test("only a run that can ask the user goes through the host", () => {
    expect(museAsks(run())).toBe(true)
    expect(museAsks(run({ permission: "ask_all" }))).toBe(true)
    // These cannot ask: the level lets them do all, or they have no tools.
    expect(museAsks(run({ permission: "full" }))).toBe(false)
    expect(museAsks(run({ useTools: false }))).toBe(false)
  })
  test("the host keeps sessions out of the store and takes no question", () => {
    const args = museHostArgs(run())
    expect(args[0]).toBe("serve")
    expect(args).toContain("--no-session-log")
    expect(args).toContain("--disable-request-user-input")
    expect(args).not.toContain("--disable-shell")
    expect(museHostArgs(run({ permission: "ask_all" }))).toEqual(
      expect.arrayContaining(["--disable-write", "--disable-shell"]),
    )
  })
  test("a command id is a time-ordered UUID", () => {
    const id = commandId(1_900_000_000_000)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id.replaceAll("-", "").slice(0, 12)).toBe(
      (1_900_000_000_000).toString(16).padStart(12, "0"),
    )
    expect(commandId()).not.toBe(commandId())
  })

  test("every step of the host shows its card, and its rule key is the command itself", () => {
    const shell = (command: string) =>
      describeMuseApproval({ toolCallId: "c1", subject: { kind: "shell", command } })
    // The host asked, so the user decides, also for a plain command.
    expect(shell("touch /Users/me/a.txt")).toEqual({
      callId: "c1",
      risky: true,
      key: "run_command:touch /Users/me/a.txt",
      summary: "touch /Users/me/a.txt",
    })
    // A yes for one command is not a yes for the next command of the same program.
    expect(shell("touch /Users/me/a.txt").key).not.toBe(shell("touch /etc/hosts").key)
    expect(shell("rm /etc/hosts").key).not.toBe(shell("rm /etc/other").key)
    expect(shell("  ls -la \n").key).toBe("run_command:ls -la")
  })
  test("the card sits on the item that waits, which the tool call of the reply shares", () => {
    const both = {
      itemId: "item-1",
      toolCallId: "call_1",
      subject: { kind: "shell", command: "ls" },
    }
    expect(describeMuseApproval(both).callId).toBe("item-1")
  })
  test("a file step keeps its path in the rule key", () => {
    const file = (path: string, access: string) =>
      describeMuseApproval({
        itemId: "i1",
        toolName: "write_file",
        subject: { kind: "fileAccess", path, access },
      })
    expect(file("notes.md", "write")).toEqual({
      callId: "i1",
      risky: true,
      key: "write_file:notes.md",
      summary: "write_file: notes.md",
    })
    expect(file("/etc/hosts", "write").key).toBe("write_file:/etc/hosts")
    expect(file("/etc/hosts", "read").key).toBe("read_file:/etc/hosts")
    expect(file("/etc/hosts", "write").key).not.toBe(file("/etc/other", "write").key)
  })
  test("a network step keeps its host, and an unknown step keeps its arguments", () => {
    expect(
      describeMuseApproval({
        toolName: "bash",
        subject: { kind: "network", host: "example.com", port: 443, protocol: "https" },
      }),
    ).toMatchObject({ risky: true, key: "network:example.com", summary: "https://example.com:443" })
    const unknown = (rawArgs: string) =>
      describeMuseApproval({ toolName: "x", rawArgs, subject: { kind: "future" } })
    expect(unknown("{}")).toMatchObject({ risky: true, key: "future:x:{}", summary: "x: {}" })
    expect(unknown('{"a":1}').key).not.toBe(unknown("{}").key)
  })

  test("the answer of the user picks a choice of the host", () => {
    const choices = [
      { choiceId: "s", decision: "approvedForSession", scope: "session" },
      { choiceId: "o", decision: "approved", scope: "once" },
      { choiceId: "d", decision: "denied", scope: "once", acceptsFeedback: true },
    ]
    expect(pickMuseChoice(choices, true)).toEqual({ choiceId: "o", acceptsFeedback: false })
    expect(pickMuseChoice(choices, false)).toEqual({ choiceId: "d", acceptsFeedback: true })
    // Without a plain "allow once", the wider choice is the only way to say yes.
    expect(pickMuseChoice(choices.slice(0, 1), true)?.choiceId).toBe("s")
    expect(pickMuseChoice([{ choiceId: "x", decision: "abort" }], false)?.choiceId).toBe("x")
    expect(pickMuseChoice([], true)).toBeNull()
    expect(pickMuseChoice(undefined, false)).toBeNull()
  })

  const feed = (notes: [string, unknown][]) => {
    const state = newMuseHostState()
    const mapped = notes.flatMap(([method, params]) => mapMuseNotification(method, params, state))
    const events = mapped.flatMap((m) => (m.kind === "event" ? [m.event] : []))
    return { state, mapped, events }
  }
  test("a reply streams as text, and a tool call shows its input and output", () => {
    const { events, state } = feed([
      ["item/completed", { item: { itemId: "u", kind: "userMessage", text: "Hi" } }],
      [
        "item/started",
        { item: { itemId: "t", kind: "toolCall", tool: "bash", args: '{"command":"ls"}' } },
      ],
      [
        "item/completed",
        {
          item: {
            itemId: "t",
            kind: "toolCall",
            tool: "bash",
            args: '{"command":"ls"}',
            status: "completed",
            visibleOutput: "a.txt",
          },
        },
      ],
      ["item/started", { item: { itemId: "m", kind: "agentMessage", text: "" } }],
      ["item/delta", { itemId: "m", field: "text", delta: "Hel" }],
      ["item/delta", { itemId: "m", field: "text", delta: "lo" }],
      ["item/completed", { item: { itemId: "m", kind: "agentMessage", text: "Hello" } }],
      ["session/tokenUsage", { usage: { inputTokens: 10, outputTokens: 2 } }],
      ["session/tokenUsage", { usage: { inputTokens: 5, outputTokens: 1 } }],
      ["turn/foregroundCompleted", { turnId: "x" }],
    ])
    expect(events).toEqual([
      {
        type: "tool",
        state: "running",
        call: { id: "t", name: "bash", input: '{"command":"ls"}' },
      },
      {
        type: "tool",
        state: "done",
        call: { id: "t", name: "bash", input: '{"command":"ls"}' },
        output: "a.txt",
      },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "usage", input: 15, output: 3 },
    ])
    expect(state.done).toBe(true)
  })
  test("a reply that comes whole still shows, and a second message starts after a break", () => {
    const { events } = feed([
      ["item/completed", { item: { itemId: "a", kind: "agentMessage", text: "One" } }],
      ["item/started", { item: { itemId: "b", kind: "agentMessage", text: "" } }],
      ["item/delta", { itemId: "b", delta: "Two" }],
      ["item/delta", { itemId: "b", field: "summary.0", delta: "hidden" }],
    ])
    expect(events).toEqual([
      { type: "text", text: "One" },
      { type: "text", text: "\n\nTwo" },
    ])
  })
  test("a failed tool call shows as failed, with the reason", () => {
    const { events } = feed([
      [
        "item/completed",
        {
          item: {
            itemId: "t",
            kind: "toolCall",
            tool: "bash",
            status: "rejected",
            failureReason: "no",
          },
        },
      ],
    ])
    expect(events[0]).toMatchObject({ type: "tool", state: "failed", output: "no" })
  })
  test("the usage windows of the plan come as limits", () => {
    const { mapped } = feed([
      [
        "usage/changed",
        { window: { usedPercent: 12, resetsAtMs: 5 }, weekly: { usedPercent: 40, resetsAtMs: 9 } },
      ],
    ])
    expect(mapped).toEqual([
      {
        kind: "limits",
        limits: [
          { window: "window", used: 0.12, resetsAt: 5 },
          { window: "weekly", used: 0.4, resetsAt: 9 },
        ],
      },
    ])
  })
  test("a failed turn keeps its reason, and an end after the reply changes nothing", () => {
    const failed = feed([["turn/completed", { terminal: "failed", error: { message: "boom" } }]])
    expect(failed.state.failed).toBe("boom")
    expect(failed.state.done).toBe(false)
    const late = feed([
      ["turn/foregroundCompleted", {}],
      ["turn/completed", { terminal: "failed", error: { message: "reminder failed" } }],
    ])
    expect(late.state).toMatchObject({ done: true, failed: null })
  })
})
