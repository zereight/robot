import { beforeAll, describe, expect, test } from "bun:test"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import {
  mapOpencodeEvent,
  newOpencodeState,
  opencodeArgs,
  opencodeConfig,
  opencodeFailure,
  opencodeLogin,
  opencodePermission,
  opencodeProbe,
  opencodeTurnEnv,
  parseOpencodeModels,
  runOpencode,
} from "./opencode.ts"
import type { RuntimeRun } from "./types.ts"

let fake: FakeRuntimes
beforeAll(() => {
  fake = makeFakeRuntimes()
})

const run = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
  bin: "opencode",
  model: "anthropic/fake-large",
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

const collect = async (stream: AsyncGenerator<AgentEvent>) => {
  const out: AgentEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

describe("opencode models", () => {
  test("reads one model on each line and offers no thinking levels", () => {
    expect(parseOpencodeModels("opencode/big-pickle\nanthropic/claude-opus-4-5\n")).toEqual([
      { id: "opencode/big-pickle", label: "opencode/big-pickle", efforts: [] },
      { id: "anthropic/claude-opus-4-5", label: "anthropic/claude-opus-4-5", efforts: [] },
    ])
  })
  test("a model name may hold more slashes, and a model is listed once", () => {
    expect(parseOpencodeModels("openrouter/meta/llama-4\nopenrouter/meta/llama-4\n")).toEqual([
      { id: "openrouter/meta/llama-4", label: "openrouter/meta/llama-4", efforts: [] },
    ])
  })
  test("a notice or an error is not a model", () => {
    expect(parseOpencodeModels("")).toEqual([])
    expect(parseOpencodeModels("Error: Server process exited with code 1\n")).toEqual([])
    expect(parseOpencodeModels("No models available.\n")).toEqual([])
  })
})

describe("opencode permission level", () => {
  test("the level becomes rules that take the tools away", () => {
    expect(opencodePermission("ask_all", true)).toEqual({
      bash: "deny",
      edit: "deny",
      task: "deny",
      question: "deny",
    })
    expect(opencodePermission("read_only", true)).toEqual(opencodePermission("ask_all", true))
    expect(opencodePermission("ask_risky", true)).toEqual({
      bash: "deny",
      task: "deny",
      question: "deny",
    })
    expect(opencodePermission("full", true)).toEqual({ question: "deny" })
  })
  test("a run that may only answer has no tool", () => {
    for (const level of ["read_only", "ask_all", "ask_risky", "full"] as const)
      expect(opencodePermission(level, false)).toEqual({ "*": "deny" })
  })
  test("the rules and the instruction file are one setting, and nothing else", () => {
    const config = JSON.parse(opencodeConfig(run({ permission: "ask_all" }), "/tmp/system.md"))
    expect(config).toEqual({
      permission: opencodePermission("ask_all", true),
      instructions: ["/tmp/system.md"],
    })
    expect(JSON.parse(opencodeConfig(run(), null))).not.toHaveProperty("instructions")
  })
})

describe("opencode command", () => {
  test("a run does not use the background server, and has no title call", () => {
    const args = opencodeArgs(run())
    expect(args.slice(0, 4)).toEqual(["run", "--standalone", "--format", "json"])
    expect(args).toContain("--title")
    expect(args[args.indexOf("--model") + 1]).toBe("anthropic/fake-large")
  })
  test("the prompt is not an argument", () => {
    expect(opencodeArgs(run({ prompt: "x".repeat(50_000) })).join(" ")).not.toContain("xxxx")
  })
  test("only full access tells the program to approve for itself", () => {
    expect(opencodeArgs(run({ permission: "full" }))).toContain("--auto")
    expect(opencodeArgs(run({ permission: "ask_risky" }))).not.toContain("--auto")
    expect(opencodeArgs(run({ permission: "full", useTools: false }))).not.toContain("--auto")
  })
  test("a model with no provider in its name is the default of the program", () => {
    expect(opencodeArgs(run({ model: "default" }))).not.toContain("--model")
  })
  test("a turn keeps its sessions apart and the files of the user out", () => {
    const env = opencodeTurnEnv(run(), "/tmp/scratch", null)
    expect(env.OPENCODE_DB).toBe("/tmp/scratch/opencode.db")
    for (const name of [
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_CLAUDE_CODE",
      "OPENCODE_DISABLE_EXTERNAL_SKILLS",
      "OPENCODE_DISABLE_AUTOUPDATE",
    ])
      expect(env[name]).toBe("1")
  })
})

describe("opencode stream", () => {
  const feed = (lines: unknown[]) => {
    const state = newOpencodeState()
    const out: AgentEvent[] = []
    for (const line of lines) out.push(...mapOpencodeEvent(line, state))
    return { state, out }
  }
  test("text, thinking, a step, and the tokens", () => {
    const { state, out } = feed([
      { type: "step_start", part: { type: "step-start" } },
      { type: "reasoning", part: { type: "reasoning", text: "hmm" } },
      {
        type: "tool_use",
        part: {
          id: "call_1",
          type: "tool",
          tool: "shell",
          state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" },
        },
      },
      { type: "text", part: { type: "text", text: "Done." } },
      {
        type: "step_finish",
        part: {
          reason: "stop",
          tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 5, write: 1 } },
        },
      },
    ])
    const call = { id: "call_1", name: "shell", input: '{"command":"echo hi"}' }
    expect(out).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "tool", state: "running", call },
      { type: "tool", state: "done", call, output: "hi\n" },
      { type: "text", text: "Done." },
    ])
    expect(state).toMatchObject({ input: 16, output: 3, error: null })
  })
  test("the tool todowrite is the list of steps; a cancelled step is not open", () => {
    const { out } = feed([
      {
        type: "tool_use",
        part: {
          id: "call_2",
          tool: "todowrite",
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Plan", status: "completed", priority: "high" },
                { content: "Build", status: "in_progress", priority: "high" },
                { content: "Old idea", status: "cancelled", priority: "low" },
              ],
            },
            output: "ok",
          },
        },
      },
    ])
    expect(out.map((e) => e.type)).toEqual(["tool", "plan", "tool"])
    expect(out[1]).toEqual({
      type: "plan",
      steps: [
        { label: "Plan", done: true },
        { label: "Build", done: false },
        { label: "Old idea", done: true },
      ],
    })
  })
  test("the tokens of every step add up", () => {
    const step = { type: "step_finish", part: { tokens: { input: 4, output: 1, cache: {} } } }
    expect(feed([step, step]).state).toMatchObject({ input: 8, output: 2 })
  })
  test("a step that failed or was refused is marked failed, with its reason", () => {
    const { out } = feed([
      {
        type: "tool_use",
        part: {
          id: "c",
          tool: "shell",
          state: { status: "error", input: {}, error: "The request was rejected." },
        },
      },
    ])
    expect(out[1]).toMatchObject({ state: "failed", output: "The request was rejected." })
  })
  test("an error is kept with its kind and its status", () => {
    const { state } = feed([
      {
        type: "error",
        error: { type: "provider.rate-limit", message: "Rate limit reached", status: 429 },
      },
    ])
    expect(state.error).toEqual({
      type: "provider.rate-limit",
      status: 429,
      message: "Rate limit reached",
    })
  })
  test("an event of a kind that the app does not know is left out", () => {
    expect(feed([{ type: "something_new", part: {} }, "text", null]).out).toEqual([])
  })
  test("failures are sorted by what the user can do about them", () => {
    expect(opencodeFailure({ type: "provider.rate-limit", status: 429, message: "x" }).code).toBe(
      "provider_limit",
    )
    expect(opencodeFailure({ type: "provider.auth", status: 401, message: "Bad key" }).code).toBe(
      "runtime_signed_out",
    )
    expect(opencodeFailure({ message: "You exceeded your current quota" }).code).toBe(
      "provider_limit",
    )
    expect(opencodeFailure({ type: "unknown", status: 500, message: "boom" }).code).toBe(
      "provider_error",
    )
  })
})

describe("opencode program", () => {
  test("the version comes from the program", async () => {
    fake.setOpencode({ ready: true })
    expect(await opencodeProbe(fake.opencode)).toEqual({ version: "2.9.9" })
    expect(await opencodeProbe("/no/such/opencode")).toEqual({ fail: "start" })
  })
  test("the models are the sign-in state: the program is ready when it lists one", async () => {
    fake.setOpencode({ ready: true })
    expect(await opencodeLogin(fake.opencode)).toMatchObject({
      signedIn: true,
      method: "subscription",
      models: [{ id: "opencode/fake-free" }, { id: "anthropic/fake-large" }],
    })
    fake.setOpencode({ ready: false })
    expect(await opencodeLogin(fake.opencode)).toMatchObject({
      signedIn: false,
      method: null,
      models: [],
    })
  })
  test("a program that does not start is not a program that nobody signed in to", async () => {
    expect(await opencodeLogin("/no/such/opencode")).toMatchObject({
      signedIn: false,
      fail: "start",
    })
  })

  test("a turn answers, and the app tells the program the level, the text and the prompt", async () => {
    fake.setOpencode({ ready: true })
    const before = fake.opencodeCalls().length
    const events = await collect(
      runOpencode(
        run({
          bin: fake.opencode,
          workspace: fake.dir,
          system: "Be brief.",
          prompt: "Hello\nsecond line",
          permission: "ask_all",
        }),
      ),
    )
    expect(events.filter((e) => e.type === "text")).toEqual([
      { type: "text", text: "Echo: second line" },
    ])
    expect(events).toContainEqual({ type: "thinking", text: "Thinking it over." })
    expect(events.at(-1)).toEqual({ type: "usage", input: 23, output: 5, cached: 2 })
    const call = fake.opencodeCalls().slice(before)[0] as {
      args: string[]
      prompt: string
      instructions: string
      config: { permission: Record<string, string> }
      env: Record<string, string>
    }
    expect(call.prompt).toBe("Hello\nsecond line")
    expect(call.args).toContain("--standalone")
    expect(call.config.permission).toEqual(opencodePermission("ask_all", true))
    expect(call.instructions).toBe("Be brief.")
    // The sessions of the turn are in a folder that is gone when the turn ends.
    expect(call.env.OPENCODE_DB).toMatch(/robot-opencode-.*opencode\.db$/)
    expect(call.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
  })

  test("a key in the environment stays, because the user set up the program with it", async () => {
    fake.setOpencode({ ready: true })
    const before = fake.opencodeCalls().length
    const saved = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test"
    try {
      await collect(runOpencode(run({ bin: fake.opencode, workspace: fake.dir })))
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved
    }
    const call = fake.opencodeCalls().slice(before)[0] as { env: Record<string, string> }
    expect(call.env.OPENAI_API_KEY).toBe("sk-test")
  })

  test("a step that the program ran shows as it runs and as it ends", async () => {
    fake.setOpencode({
      tool: {
        name: "read",
        state: { status: "completed", input: { path: "a.txt" }, output: "file text" },
      },
    })
    const events = await collect(runOpencode(run({ bin: fake.opencode, workspace: fake.dir })))
    const tools = events.filter((e) => e.type === "tool")
    expect(tools.map((e) => e.type === "tool" && e.state)).toEqual(["running", "done"])
    expect(tools[1]).toMatchObject({ output: "file text", call: { name: "read" } })
  })

  test("an error of the program ends the turn with the failure that fits", async () => {
    fake.setOpencode({
      error: { type: "provider.auth", message: "Incorrect API key provided", status: 401 },
    })
    const failure = await collect(
      runOpencode(run({ bin: fake.opencode, workspace: fake.dir })),
    ).catch((error) => error)
    expect(failure).toBeInstanceOf(ProviderFailure)
    expect((failure as ProviderFailure).code).toBe("runtime_signed_out")
    fake.setOpencode({
      error: { type: "provider.rate-limit", message: "Rate limit reached", status: 429 },
    })
    const limited = await collect(
      runOpencode(run({ bin: fake.opencode, workspace: fake.dir })),
    ).catch((error) => error)
    expect((limited as ProviderFailure).code).toBe("provider_limit")
  })

  test("a program that is not there is a program that does not start", async () => {
    const failure = await collect(
      runOpencode(run({ bin: "/no/such/opencode", workspace: fake.dir })),
    ).catch((error) => error)
    expect(failure).toBeInstanceOf(ProviderFailure)
    expect((failure as ProviderFailure).code).toBe("runtime_start")
  })

  test("a stop ends the turn without an error", async () => {
    fake.setOpencode({ ready: true })
    const stop = new AbortController()
    stop.abort()
    await expect(
      collect(runOpencode(run({ bin: fake.opencode, workspace: fake.dir, signal: stop.signal }))),
    ).resolves.toBeDefined()
  })
})
