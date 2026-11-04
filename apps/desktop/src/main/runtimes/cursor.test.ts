import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import {
  cursorArgs,
  cursorFailure,
  cursorLogin,
  cursorModeArgs,
  cursorProbe,
  cursorPrompt,
  mapCursorEvent,
  newCursorState,
  parseCursorModels,
  parseCursorStatus,
  runCursor,
} from "./cursor.ts"
import { hasReadOnlyMode } from "./readonly.ts"
import type { RuntimeRun } from "./types.ts"

const FAKE = `import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
const dir = dirname(fileURLToPath(import.meta.url))
const state = existsSync(join(dir, "state.json"))
  ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))
  : {}
const args = process.argv.slice(2)
appendFileSync(
  join(dir, "calls.jsonl"),
  JSON.stringify({
    args,
    hasCursorKey: Boolean(process.env.CURSOR_API_KEY),
    hasOpenaiKey: Boolean(process.env.OPENAI_API_KEY),
  }) + "\\n",
)
const has = (name) => args.includes(name)
if (has("--version") || has("-v")) {
  console.log(state.version ?? "2026.10.22-test")
  process.exit(0)
}
if (has("--help") || has("-h")) {
  console.log(state.help ?? "--mode <mode> choices: plan, ask. ask is read-only.")
  process.exit(0)
}
if (args[0] === "status") {
  console.log(JSON.stringify(state.status ?? { status: "unauthenticated", isAuthenticated: false }))
  process.exit(0)
}
if (args[0] === "models") {
  if (state.modelsError) {
    console.error(state.modelsError)
    process.exit(1)
  }
  console.log(state.modelsText ?? "Available models\\n\\ncomposer-2.5 - Composer 2.5 (default)\\ngpt-5.5 - GPT-5.5\\n")
  process.exit(0)
}
if (has("-p") || has("--print")) {
  if (state.stderr) console.error(state.stderr)
  const lines = state.lines ?? [
    { type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "Echo" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Echo" },
  ]
  for (const line of lines) console.log(JSON.stringify(line))
  process.exit(state.exitCode ?? 0)
}
console.error("unknown")
process.exit(2)
`

interface Fake {
  readonly bin: string
  readonly dir: string
  set(state: unknown): void
  calls(): unknown[]
}

function makeFake(): Fake {
  const dir = mkdtempSync(join(tmpdir(), "robot-cursor-"))
  const script = join(dir, "cursor-agent.mjs")
  const bin = join(dir, "cursor-agent")
  writeFileSync(script, FAKE)
  writeFileSync(bin, `#!/bin/sh\nexec node "${script}" "$@"\n`)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, "state.json"), "{}")
  return {
    bin,
    dir,
    set(state: unknown) {
      writeFileSync(join(dir, "state.json"), JSON.stringify(state))
    },
    calls() {
      try {
        return readFileSync(join(dir, "calls.jsonl"), "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
  }
}

const baseRun = (patch: Partial<RuntimeRun> = {}): RuntimeRun => ({
  bin: "cursor-agent",
  model: "composer-2.5",
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

const failureOf = async (stream: AsyncGenerator<AgentEvent>) => {
  try {
    await collect(stream)
    return null
  } catch (error) {
    return error
  }
}

describe("When Cursor prints its model list", () => {
  describe("with the text of agent models", () => {
    test("should keep the id and the name, and offer no effort", () => {
      const text = [
        "\u001b[2mAvailable models\u001b[22m",
        "",
        "\u001b[36mcomposer-2.5\u001b[39m \u001b[2m- Composer 2.5\u001b[22m \u001b[2m(default)\u001b[22m",
        "\u001b[32mgpt-5.5\u001b[39m \u001b[2m- GPT-5.5\u001b[22m \u001b[2m(current)\u001b[22m",
        "auto",
        "",
        "\u001b[2mTip: use --model <id> to switch.\u001b[22m",
      ].join("\n")
      expect(parseCursorModels(text)).toEqual([
        { id: "composer-2.5", label: "Composer 2.5", efforts: [] },
        { id: "gpt-5.5", label: "GPT-5.5", efforts: [] },
        { id: "auto", label: "auto", efforts: [] },
      ])
    })
  })

  describe("with no models", () => {
    test("should return an empty list", () => {
      expect(parseCursorModels("No models available for this account.")).toEqual([])
    })
  })
})

describe("When Cursor prints its status", () => {
  describe("with a signed-in account", () => {
    test("should report the email", () => {
      expect(
        parseCursorStatus(
          JSON.stringify({
            status: "authenticated",
            isAuthenticated: true,
            userInfo: { email: "a@b.c" },
          }),
        ),
      ).toEqual({ signedIn: true, user: "a@b.c" })
    })
  })

  describe("with no sign-in", () => {
    test("should report signed out", () => {
      expect(
        parseCursorStatus(
          JSON.stringify({
            status: "unauthenticated",
            isAuthenticated: false,
            message: "Not logged in",
          }),
        ),
      ).toEqual({ signedIn: false, user: null })
    })
  })

  describe("with text that is not the status", () => {
    test("should return nothing", () => {
      expect(parseCursorStatus("Not logged in")).toBeNull()
    })
  })
})

describe("When a turn starts", () => {
  describe("with a permission level", () => {
    test("should use ask mode when the program must not change files", () => {
      expect(cursorModeArgs(baseRun({ permission: "read_only" }))).toEqual(["--mode", "ask"])
      expect(cursorModeArgs(baseRun({ permission: "ask_all" }))).toEqual(["--mode", "ask"])
      expect(cursorModeArgs(baseRun({ permission: "full", useTools: false }))).toEqual([
        "--mode",
        "ask",
      ])
    })

    test("should apply changes in the sandbox at the default level", () => {
      expect(cursorModeArgs(baseRun({ permission: "ask_risky" }))).toEqual([
        "--force",
        "--sandbox",
        "enabled",
      ])
      expect(cursorModeArgs(baseRun({ permission: "ask_unsure" }))).toEqual([
        "--force",
        "--sandbox",
        "enabled",
      ])
    })

    test("should turn the sandbox off at full access", () => {
      expect(cursorModeArgs(baseRun({ permission: "full" }))).toEqual([
        "--force",
        "--sandbox",
        "disabled",
      ])
    })
  })

  describe("with a prompt", () => {
    test("should put the instructions in the prompt and pass that prompt after --", () => {
      const prompt = cursorPrompt(baseRun({ system: "Be brief.", useTools: false, prompt: "Hi" }))
      expect(prompt.startsWith("Answer in text only.")).toBe(true)
      expect(prompt).toContain("Be brief.")
      expect(prompt.endsWith("Hi")).toBe(true)
      const args = cursorArgs(baseRun({ model: "composer-2.5", workspace: "/work/bo" }))
      expect(args).toContain("--trust")
      expect(args).toContain("--workspace")
      expect(args).toContain("/work/bo")
      expect(args).toContain("--model")
      expect(args).toContain("composer-2.5")
      expect(args.at(-2)).toBe("--")
      expect(args.at(-1)).toBe("Hi")
      const dashed = cursorArgs(baseRun({ prompt: "--help" }))
      expect(dashed.at(-2)).toBe("--")
      expect(dashed.at(-1)).toBe("--help")
      expect(cursorArgs(baseRun({ model: "default" }))).not.toContain("--model")
    })
  })
})

describe("When a stream-json line arrives", () => {
  describe("with partial text and a repeated flush", () => {
    test("should append the new text once", () => {
      const state = newCursorState()
      const events = [
        ...mapCursorEvent(
          {
            type: "assistant",
            timestamp_ms: 1,
            message: { content: [{ type: "text", text: "Hi" }] },
          },
          state,
        ),
        ...mapCursorEvent(
          {
            type: "assistant",
            timestamp_ms: 2,
            model_call_id: "call-1",
            message: { content: [{ type: "text", text: "Hi" }] },
          },
          state,
        ),
        ...mapCursorEvent(
          { type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } },
          state,
        ),
        ...mapCursorEvent({ type: "result", is_error: false, result: "Hi" }, state),
      ]
      expect(events).toEqual([{ type: "text", text: "Hi" }])
    })
  })

  describe("with a tool call", () => {
    test("should show the step as it starts and as it ends", () => {
      const state = newCursorState()
      const started = mapCursorEvent(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "1",
          tool_call: { readToolCall: { args: { path: "a.txt" } } },
        },
        state,
      )
      const ended = mapCursorEvent(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "1",
          tool_call: {
            readToolCall: {
              args: { path: "a.txt" },
              result: { success: { content: "data" } },
            },
          },
        },
        state,
      )
      expect(started).toEqual([
        {
          type: "tool",
          state: "running",
          call: { id: "1", name: "read", input: '{"path":"a.txt"}' },
        },
      ])
      expect(ended).toEqual([
        {
          type: "tool",
          state: "done",
          call: { id: "1", name: "read", input: '{"path":"a.txt"}' },
          output: "data",
        },
      ])
    })
  })

  describe("with a result and no streamed text", () => {
    test("should use the result text", () => {
      const state = newCursorState()
      expect(mapCursorEvent({ type: "result", is_error: false, result: "Done" }, state)).toEqual([
        { type: "text", text: "Done" },
      ])
    })
  })
})

describe("When the program reports a failure", () => {
  describe("with a limit, a busy model, or a missing sign-in", () => {
    test("should name that failure", () => {
      expect(cursorFailure("You hit your usage limit").code).toBe("provider_limit")
      expect(cursorFailure("The model is overloaded").code).toBe("provider_busy")
      expect(cursorFailure("Authentication required").code).toBe("runtime_signed_out")
      expect(cursorFailure("boom").code).toBe("provider_error")
    })
  })
})

describe("When the program on disk answers", () => {
  describe("with a version and a sign-in", () => {
    test("should read the version", async () => {
      const fake = makeFake()
      expect(await cursorProbe(fake.bin)).toEqual({ version: "2026.10.22-test" })
      expect(await cursorProbe("/no/such/cursor-agent")).toEqual({ fail: "start" })
    })

    test("should connect when the status and the model list say so", async () => {
      const fake = makeFake()
      fake.set({
        status: {
          status: "authenticated",
          isAuthenticated: true,
          userInfo: { email: "a@b.c" },
        },
      })
      expect(await cursorLogin(fake.bin)).toMatchObject({
        signedIn: true,
        method: "subscription",
        user: "a@b.c",
        models: [
          { id: "composer-2.5", label: "Composer 2.5" },
          { id: "gpt-5.5", label: "GPT-5.5" },
        ],
      })
    })

    test("should stay signed out when nobody is signed in and the list is refused", async () => {
      const fake = makeFake()
      fake.set({
        status: { status: "unauthenticated", isAuthenticated: false },
        modelsError: "Authentication required",
      })
      expect(await cursorLogin(fake.bin)).toEqual({
        signedIn: false,
        method: null,
        user: null,
        plan: null,
      })
    })

    test("should connect from the model list when the status store is empty", async () => {
      const fake = makeFake()
      fake.set({
        status: { status: "unauthenticated", isAuthenticated: false },
        modelsText: "composer-2.5 - Composer 2.5\n",
      })
      expect(await cursorLogin(fake.bin)).toMatchObject({
        signedIn: true,
        user: null,
        models: [{ id: "composer-2.5" }],
      })
    })

    test("should need repair when the status is not readable and the list fails", async () => {
      const fake = makeFake()
      fake.set({ status: "not-json", modelsError: "nope" })
      expect(await cursorLogin(fake.bin)).toMatchObject({ signedIn: false, fail: "unreadable" })
      expect(await cursorLogin("/no/such/cursor-agent")).toMatchObject({ fail: "start" })
    })
  })

  describe("with a printed turn", () => {
    test("should stream the reply and pass the level, the model and the prompt", async () => {
      const fake = makeFake()
      const savedCursor = process.env.CURSOR_API_KEY
      const savedOpenai = process.env.OPENAI_API_KEY
      process.env.CURSOR_API_KEY = "cursor-key"
      process.env.OPENAI_API_KEY = "sk-test"
      let events: AgentEvent[]
      try {
        events = await collect(
          runCursor(
            baseRun({
              bin: fake.bin,
              workspace: fake.dir,
              system: "Be brief.",
              permission: "read_only",
              prompt: "Hello",
            }),
          ),
        )
      } finally {
        if (savedCursor === undefined) delete process.env.CURSOR_API_KEY
        else process.env.CURSOR_API_KEY = savedCursor
        if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = savedOpenai
      }
      expect(events).toEqual([{ type: "text", text: "Echo" }])
      const call = fake.calls().find((entry) => {
        if (entry === null || typeof entry !== "object" || !("args" in entry)) return false
        return Array.isArray(entry.args) && entry.args.includes("-p")
      })
      expect(call).toMatchObject({
        hasCursorKey: true,
        hasOpenaiKey: false,
      })
      expect(call).toMatchObject({
        args: expect.arrayContaining(["--mode", "ask", "--model", "composer-2.5", "--trust"]),
      })
      if (call !== null && typeof call === "object" && "args" in call && Array.isArray(call.args)) {
        const prompt = call.args.at(-1)
        expect(prompt).toContain("Be brief.")
        expect(prompt).toContain("Hello")
      }
    })

    test("should fail with the reason the program wrote", async () => {
      const fake = makeFake()
      fake.set({
        lines: [{ type: "result", is_error: true, result: "You hit your usage limit" }],
      })
      const error = await failureOf(runCursor(baseRun({ bin: fake.bin, workspace: fake.dir })))
      expect(error).toBeInstanceOf(ProviderFailure)
      if (error instanceof ProviderFailure) expect(error.code).toBe("provider_limit")
    })
  })

  describe("with a help text", () => {
    test("should have a read-only mode only when the help names ask mode", async () => {
      const fake = makeFake()
      expect(await hasReadOnlyMode("cursor", fake.bin)).toBe(true)
      fake.set({ help: "--mode plan is read-only" })
      expect(await hasReadOnlyMode("cursor", fake.bin)).toBe(false)
    })
  })
})
