import { beforeAll, describe, expect, test } from "bun:test"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import { claudeLogin, claudeVersion, runClaude } from "./claude.ts"
import { codexLogin, runCodex } from "./codex.ts"
import { runMuse } from "./muse.ts"
import { piLogin } from "./pi.ts"
import type { RuntimeRun } from "./types.ts"

let fake: FakeRuntimes
beforeAll(() => {
  fake = makeFakeRuntimes()
})

const base = (bin: string, patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
  bin,
  model: "sonnet",
  effort: null,
  system: "Be brief.",
  prompt: "Hello there",
  workspace: fake.dir,
  permission: "ask_risky",
  useTools: true,
  signal: new AbortController().signal,
  approve: async () => true,
  onLimits: () => {},
  ...patch,
})

const collect = async (stream: AsyncGenerator<AgentEvent>) => {
  const out: AgentEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

const text = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("")

describe("claude program", () => {
  test("version and sign-in come from the program", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "pro" })
    expect(await claudeVersion(fake.claude)).toBe("9.9.9")
    expect(await claudeLogin(fake.claude)).toMatchObject({
      signedIn: true,
      method: "subscription",
      user: "a@b.c",
      plan: "pro",
    })
    fake.setClaude({ loggedIn: false })
    expect((await claudeLogin(fake.claude)).signedIn).toBe(false)
  })

  test("a turn streams text, reports usage and limits", async () => {
    const seen: unknown[] = []
    const events = await collect(runClaude(base(fake.claude, { onLimits: (l) => seen.push(l) })))
    expect(text(events)).toBe("Echo: Hello there")
    expect(events.at(-1)).toEqual({ type: "usage", input: 15, output: 7 })
    expect(seen[0]).toEqual([
      { window: "five_hour", used: 0.19, resetsAt: 1_900_000_000_000 },
      { window: "seven_day", used: 0.4, resetsAt: 1_900_500_000_000 },
    ])
  })

  test("the program gets the prompt, the model and no key from the environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-reach-the-program"
    try {
      await collect(runClaude(base(fake.claude, { model: "opus", prompt: "Which key?" })))
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
    const call = fake.claudeCalls().at(-1) as {
      args: string[]
      prompt: string
      blocks: string[]
      hasApiKey: boolean
    }
    expect(call.prompt).toBe("Which key?")
    // Without blocks, the prompt is the one block.
    expect(call.blocks).toEqual(["Which key?"])
    expect(call.hasApiKey).toBe(false)
    expect(call.args[call.args.indexOf("--model") + 1]).toBe("opus")
  })

  test("the chat goes to the program as one text block for each message", async () => {
    await collect(runClaude(base(fake.claude, { blocks: ["first block", "second block"] })))
    const call = fake.claudeCalls().at(-1) as { blocks: string[] }
    expect(call.blocks).toEqual(["first block", "second block"])
  })

  test("a step that needs approval waits for the answer; yes lets it run", async () => {
    const asked: unknown[] = []
    const events = await collect(
      runClaude(
        base(fake.claude, {
          prompt: "RUN: touch a.txt",
          approve: async (request) => {
            asked.push(request)
            return true
          },
        }),
      ),
    )
    expect(asked).toEqual([
      { callId: "toolu_fake1", risky: false, key: "run_command:touch", summary: "touch a.txt" },
    ])
    const tool = events.filter((e) => e.type === "tool")
    expect(tool.map((e) => (e.type === "tool" ? e.state : ""))).toEqual(["running", "done"])
    expect(text(events)).toBe("It ran.")
  })

  test("a no from the user is passed on to the program", async () => {
    const events = await collect(
      runClaude(base(fake.claude, { prompt: "RUN: rm -rf /tmp/x", approve: async () => false })),
    )
    const last = events.filter((e) => e.type === "tool").at(-1)
    expect(last).toMatchObject({ state: "failed", output: "The user denied this step." })
    expect(text(events)).toBe("It was denied.")
  })

  test("a usage limit fails the turn with the time it resets", async () => {
    const error = await collect(runClaude(base(fake.claude, { prompt: "LIMIT" }))).catch((e) => e)
    expect(error).toBeInstanceOf(ProviderFailure)
    expect(error).toMatchObject({ code: "provider_limit", resetsAt: 1_900_000_000_000 })
  })

  test("stop ends the program at once and the stream ends without an error", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const events: AgentEvent[] = []
    const run = (async () => {
      for await (const e of runClaude(
        base(fake.claude, { prompt: "SLOW", signal: controller.signal }),
      )) {
        events.push(e)
        controller.abort()
      }
    })()
    await run
    expect(Date.now() - started).toBeLessThan(5000)
    expect(text(events)).toBe("Thinking slowly")
  })

  test("a program that cannot start fails with a reason", async () => {
    const error = await collect(runClaude(base("/no/such/program"))).catch((e) => e)
    expect(error).toBeInstanceOf(ProviderFailure)
    expect((error as ProviderFailure).code).toBe("provider_error")
  })
})

describe("codex program", () => {
  test("the sign-in method is read from the status text", async () => {
    fake.setCodex({ loggedIn: true, method: "chatgpt" })
    expect(await codexLogin(fake.codex)).toMatchObject({ signedIn: true, method: "subscription" })
    fake.setCodex({ loggedIn: true, method: "key" })
    expect((await codexLogin(fake.codex)).method).toBe("api_key")
    fake.setCodex({ loggedIn: false })
    expect((await codexLogin(fake.codex)).signedIn).toBe(false)
  })

  test("a turn gets the prompt on stdin and streams the answer", async () => {
    const events = await collect(
      runCodex(base(fake.codex, { model: "default", prompt: "RUN: ls" })),
    )
    expect(text(events)).toBe("Echo: RUN: ls")
    expect(events.filter((e) => e.type === "tool")).toHaveLength(2)
    expect(events.at(-1)).toEqual({ type: "usage", input: 20, output: 3 })
    const call = fake.codexCalls().at(-1) as { args: string[]; prompt: string }
    expect(call.prompt).toContain("Be brief.")
    expect(call.args).toContain("workspace-write")
  })

  test("a failed turn becomes a failure", async () => {
    const error = await collect(runCodex(base(fake.codex, { prompt: "FAIL" }))).catch((e) => e)
    expect(error).toMatchObject({ code: "provider_limit" })
  })
})

describe("pi program", () => {
  test("each model has the levels that pi tells for it", async () => {
    fake.setPi({ ready: true })
    const login = await piLogin(fake.pi)
    expect(login.signedIn).toBe(true)
    const efforts = Object.fromEntries((login.models ?? []).map((m) => [m.id, m.efforts]))
    // A model that does not think has none. The other one has "xhigh", which the fixed list lacks.
    expect(efforts).toEqual({
      "claude-bridge/fake-small": [],
      "anthropic/fake-large": ["low", "medium", "high", "xhigh"],
    })
  })

  test("when pi cannot tell the levels, a model that thinks keeps the usual three", async () => {
    fake.setPi({ ready: true, noRpc: true })
    const login = await piLogin(fake.pi)
    const large = login.models?.find((m) => m.id === "anthropic/fake-large")
    expect(large?.efforts).toEqual(["low", "medium", "high"])
    fake.setPi({ ready: true })
  })
})

describe("muse program", () => {
  const ask = (patch: Partial<RuntimeRun> = {}) => base(fake.muse, { model: "default", ...patch })

  test("a turn goes through the session host and streams the reply", async () => {
    const events = await collect(runMuse(ask({ effort: "high" })))
    expect(text(events)).toBe("Echo: Hello there")
    expect(events.at(-1)).toEqual({ type: "usage", input: 20, output: 5 })
    const call = fake.museCalls().at(-1) as Record<string, unknown>
    expect((call.args as string[])[0]).toBe("serve")
    expect(call.effort).toBe("high")
    // Files of other agent tools stay out, and the program does not update itself.
    expect(call.foreignKill).toBe("1")
    expect(call.autoUpdate).toBe("1")
    expect(call.session).toMatchObject({ approvalMode: "onRequest" })
  })

  test("the reply is done when the host says so, not when its reminder agents end", async () => {
    // The stand-in host keeps running after the reply, like the real one with a reminder agent.
    const started = Date.now()
    await collect(runMuse(ask()))
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("a step that needs approval shows as a card, and Allow lets it run", async () => {
    const asked: unknown[] = []
    const events = await collect(
      runMuse(
        ask({
          prompt: "do it [ask]",
          approve: async (request) => {
            asked.push(request)
            return true
          },
        }),
      ),
    )
    expect(asked).toEqual([
      {
        callId: "tool-1",
        risky: true,
        key: "run_command:rm /etc/robot-test",
        summary: "rm /etc/robot-test",
      },
    ])
    expect(text(events)).toBe("Ran it.")
    const decision = fake.museCalls().findLast((c) => c.kind === "decide") as {
      params: Record<string, unknown>
    }
    expect(decision.params).toMatchObject({
      approvalId: "approval-1",
      choiceId: "allow-once",
      requirementId: { approvalId: "approval-1", sourceIndex: 0 },
    })
    expect(decision.params.feedback).toBeUndefined()
  })

  test("Deny tells the program, and the turn goes on", async () => {
    const events = await collect(
      runMuse(ask({ prompt: "do it [ask]", approve: async () => false })),
    )
    expect(text(events)).toBe("Not allowed.")
    const decision = fake.museCalls().findLast((c) => c.kind === "decide") as {
      params: Record<string, unknown>
    }
    expect(decision.params).toMatchObject({
      choiceId: "deny",
      feedback: "The user denied this step.",
    })
  })

  test("Stop while the card waits ends the turn and the program", async () => {
    const controller = new AbortController()
    const events = collect(
      runMuse(
        ask({
          prompt: "do it [ask]",
          signal: controller.signal,
          approve: () =>
            new Promise<boolean>((_, reject) => {
              controller.signal.addEventListener("abort", () => reject(new Error("stopped")))
              setTimeout(() => controller.abort(), 100)
            }),
        }),
      ),
    )
    // The call shows, but nothing of the reply does: the step never ran.
    expect(text(await events)).toBe("")
  })

  test("a failed turn becomes a failure of the provider", async () => {
    await expect(collect(runMuse(ask({ prompt: "[fail]" })))).rejects.toMatchObject({
      code: "provider_error",
      message: "boom",
    })
  })

  test("a run that cannot ask stays headless", async () => {
    const before = fake.museCalls().length
    const events = await collect(runMuse(ask({ permission: "full" })))
    expect(text(events)).toBe("Echo: Hello there")
    const call = fake.museCalls().at(-1) as { args: string[] }
    expect(fake.museCalls().length).toBe(before + 1)
    expect(call.args[0]).toBe("exec")
    expect(call.args).toContain("--disable-approval")
  })
})
