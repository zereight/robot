import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import { type BridgeHandler, grantBridge, MUSE_AUTH_VARIABLE } from "./bridge.ts"
import { claudeLogin, claudeUsage, claudeVersion, runClaude } from "./claude.ts"
import { codexLogin, runCodex } from "./codex.ts"
import { runMuse } from "./muse.ts"
import { piLogin } from "./pi.ts"
import type { RuntimeRun } from "./types.ts"

let fake: FakeRuntimes
let grant: Awaited<ReturnType<typeof grantBridge>>
beforeAll(() => {
  fake = makeFakeRuntimes()
})

/** Waits until a state is there. A wait that ends with no result fails with a message. */
const until = async (check: () => boolean, what: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`Gave up waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

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

/** The browser of the app, as a program sees it. */
const browser: BridgeHandler & { calls: string[] } = {
  calls: [],
  tools: [{ name: "browser_read", description: "Read the page.", schema: { type: "object" } }],
  call: async (name) => {
    browser.calls.push(name)
    return { output: "Text of the page", failed: false }
  },
}

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

  test("the usage windows are asked without a turn, in a folder of their own", async () => {
    fake.setClaude({
      loggedIn: true,
      authMethod: "claude.ai",
      plan: "max",
      usage: {
        five_hour: { utilization: 12, resets_at: "2030-01-01T00:00:00Z" },
        seven_day: { utilization: 40, resets_at: "2030-01-02T00:00:00Z" },
      },
    })
    expect(await claudeUsage(fake.claude)).toEqual([
      { window: "five_hour", used: 0.12, resetsAt: Date.parse("2030-01-01T00:00:00Z") },
      { window: "seven_day", used: 0.4, resetsAt: Date.parse("2030-01-02T00:00:00Z") },
    ])
    const call = fake.claudeUsageCalls().findLast((c) => c.kind === "usage") as {
      args: string[]
      cwd: string
    }
    // No saved session, no servers of the user, no hooks of the user, no tools.
    expect(call.args).toEqual(
      expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config", "--settings"]),
    )
    expect(call.args[call.args.indexOf("--settings") + 1]).toContain('"disableAllHooks":true')
    expect(call.args.at(-2)).toBe("--tools")
    expect(call.args.at(-1)).toBe("")
    expect(call.cwd).not.toBe(process.cwd())
    expect(call.cwd).toContain("robot-claude-probe")
    // The folder is for this look only. Nothing of it stays in the temporary folder.
    expect(existsSync(call.cwd)).toBe(false)
  })

  test("the text of /usage is the second try, and a program that tells nothing gives null", async () => {
    fake.setClaude({
      loggedIn: true,
      authMethod: "claude.ai",
      usageText: "Current session: 7% used\nCurrent week (all models): 21% used\n",
    })
    expect(await claudeUsage(fake.claude)).toEqual([
      { window: "five_hour", used: 0.07, resetsAt: null },
      { window: "seven_day", used: 0.21, resetsAt: null },
    ])
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai" })
    expect(await claudeUsage(fake.claude)).toBeNull()
    // A program that is not there tells nothing, and does not throw.
    expect(await claudeUsage("/no/such/claude")).toBeNull()
    // The look at the text of /usage has its own folder too, and removes it.
    const folders = fake.claudeUsageCalls().map((c) => (c as { cwd: string }).cwd)
    expect(folders.length).toBeGreaterThan(0)
    for (const folder of folders) expect(existsSync(folder)).toBe(false)
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

  test("a message during the turn goes to the program, and the turn ends after it is read", async () => {
    const waiting: { id: string; text: string }[] = []
    const watchers = new Set<() => void>()
    const inbox = {
      take: () => waiting.splice(0),
      watch: (ready: () => void) => {
        watchers.add(ready)
        return () => watchers.delete(ready)
      },
    }
    const events: AgentEvent[] = []
    for await (const event of runClaude(base(fake.claude, { prompt: "WAIT 300", inbox }))) {
      events.push(event)
      // The user writes while the program works.
      if (event.type === "text" && event.text === "Working. ") {
        waiting.push({ id: "8c0b1b8e-0000-4000-8000-000000000001", text: "Use b.txt instead" })
        for (const ready of watchers) ready()
      }
    }
    const call = fake.claudeCalls().find((c) => "prompt" in c && c.prompt === "WAIT 300") as {
      args: string[]
    }
    expect(call.args).toContain("--replay-user-messages")
    expect(fake.claudeCalls().at(-1)).toEqual({
      joined: "Use b.txt instead",
      uuid: "8c0b1b8e-0000-4000-8000-000000000001",
    })
    // The program read the message, and its answer belongs to the same turn.
    const joined = events.findIndex((e) => e.type === "joined")
    expect(events[joined]).toEqual({ type: "joined", id: "8c0b1b8e-0000-4000-8000-000000000001" })
    expect(text(events.slice(joined))).toBe("Joined: Use b.txt instead")
    // The usage of both results counts.
    expect(events.at(-1)).toEqual({ type: "usage", input: 18, output: 9 })
    expect(watchers.size).toBe(0)
  })

  test("without an inbox the program gets no flag for messages during a turn", async () => {
    await collect(runClaude(base(fake.claude, { prompt: "plain" })))
    const call = fake.claudeCalls().at(-1) as { args: string[] }
    expect(call.args).not.toContain("--replay-user-messages")
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
      {
        callId: "toolu_fake1",
        risky: false,
        key: "run_command:touch",
        summary: "touch a.txt",
        // The step as the permission rules see it (spec 007).
        step: { kind: "shell", command: "touch a.txt" },
      },
    ])
    const tool = events.filter((e) => e.type === "tool")
    expect(tool.map((e) => (e.type === "tool" ? e.state : ""))).toEqual(["running", "done"])
    expect(text(events)).toBe("It ran.")
  })

  test("the program reaches the browser of the app, and the app asks the user by itself", async () => {
    browser.calls.length = 0
    const grant = await grantBridge(browser)
    const asked: string[] = []
    try {
      const events = await collect(
        runClaude(
          base(fake.claude, {
            prompt: "BROWSER:browser_read",
            bridge: grant,
            approve: async (r) => {
              asked.push(r.summary)
              return true
            },
          }),
        ),
      )
      expect(browser.calls).toEqual(["browser_read"])
      // The step of the app is allowed at once. Its own card follows the permission level.
      expect(asked).toEqual([])
      expect(
        events.flatMap((e) => (e.type === "tool" ? [`${e.state} ${e.call.name}`] : [])),
      ).toEqual(["running mcp__robot__browser_read", "done mcp__robot__browser_read"])
      expect(text(events)).toBe("Page: Text of the page")
      // The token is in a file that is gone with the run, never in an argument.
      const call = fake.claudeCalls().at(-1) as { args: string[] }
      const file = call.args[call.args.indexOf("--mcp-config") + 1] ?? ""
      expect(call.args.join(" ")).not.toContain(grant.token)
      expect(call.args).toContain("--strict-mcp-config")
      expect(existsSync(file)).toBe(false)
    } finally {
      grant.release()
    }
  })

  test("a run without the access gets no server", async () => {
    await collect(runClaude(base(fake.claude)))
    const call = fake.claudeCalls().at(-1) as { args: string[] }
    expect(call.args).not.toContain("--mcp-config")
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

  test("a Stop removes the files of the run when the program ends, though nobody reads the stream again", async () => {
    grant = await grantBridge(browser)
    const controller = new AbortController()
    const stream = runClaude(
      base(fake.claude, { prompt: "SLOW", bridge: grant, signal: controller.signal }),
    )
    try {
      // The program says its first words and then works for a minute.
      expect((await stream.next()).done).toBe(false)
      const call = fake.claudeCalls().at(-1) as { args: string[] }
      const file = call.args[call.args.indexOf("--mcp-config") + 1] ?? ""
      expect(existsSync(file)).toBe(true)
      controller.abort()
      // The turn is marked stopped by the app and the stream is not read again. Only the end of
      // the program can remove the files: the token must not wait for a step of the stream.
      await until(() => !existsSync(file), "the files of the run to go after the Stop")
      expect(existsSync(dirname(file))).toBe(false)
    } finally {
      await stream.return(undefined)
      grant.release()
    }
  })

  test("a program that cannot start fails with a reason", async () => {
    const error = await collect(runClaude(base("/no/such/program"))).catch((e) => e)
    expect(error).toBeInstanceOf(ProviderFailure)
    // A program that cannot start is told apart from a model error: the state of the program
    // turns to Needs repair at once (spec 006).
    expect((error as ProviderFailure).code).toBe("runtime_start")
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

  test("the program is told how to start the app's server, with no token in the arguments", async () => {
    const grant = await grantBridge(browser)
    try {
      await collect(runCodex(base(fake.codex, { model: "default", bridge: grant })))
      const call = fake.codexCalls().at(-1) as { args: string[] }
      const settings = call.args.filter((a) => a.startsWith("mcp_servers.robot."))
      expect(settings.map((a) => a.split("=")[0])).toEqual([
        "mcp_servers.robot.command",
        "mcp_servers.robot.args",
        "mcp_servers.robot.env.ELECTRON_RUN_AS_NODE",
      ])
      expect(call.args.join(" ")).not.toContain(grant.token)
      // The last argument of the script is the file with the address and the token.
      const args = JSON.parse(settings[1]?.slice("mcp_servers.robot.args=".length) ?? "[]")
      expect(existsSync(args.at(-1))).toBe(false)
    } finally {
      grant.release()
    }
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
        // The step as the permission rules see it (spec 007).
        step: { kind: "shell", command: "rm /etc/robot-test" },
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

  test("the host gets the server of the app, and the token only in its environment", async () => {
    const grant = await grantBridge(browser)
    try {
      await collect(runMuse(ask({ bridge: grant })))
      const call = fake.museCalls().at(-1) as { args: string[]; bridgeAuth: string | null }
      const setting = call.args.find((a) => a.startsWith("mcpServers.robot=")) ?? ""
      expect(JSON.parse(setting.slice("mcpServers.robot=".length))).toEqual({
        url: grant.url,
        headers: { Authorization: `\${${MUSE_AUTH_VARIABLE}}` },
      })
      expect(call.args.join(" ")).not.toContain(grant.token)
      expect(call.bridgeAuth).toBe(`Bearer ${grant.token}`)
    } finally {
      grant.release()
    }
  })
})
