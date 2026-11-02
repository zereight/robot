import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../providers/agent.ts"
import {
  mapMuseLine,
  museArgs,
  museFailure,
  musePrompt,
  museSafety,
  newMuseState,
  parseMuseUsage,
  parseSignInPrompt,
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
