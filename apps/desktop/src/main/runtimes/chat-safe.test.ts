import { beforeAll, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RUNTIME_KINDS, type RuntimeKind } from "@robot/shared"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import { chatDir } from "../services/chatDir.ts"
import { chatMayUse, drivers } from "./driver.ts"
import type { RuntimeRun } from "./types.ts"

// The chat of a workflow answers in text only (spec 007, 003). A program may serve it only when
// its launcher switches off shell, file reads, tool servers (MCP) and the web with flags that the
// program enforces. Each test starts the real launcher against the stand-in program, as the chat
// does (`useTools: false`, no bridge), and reads the arguments that the program got.

let fake: FakeRuntimes
beforeAll(() => {
  fake = makeFakeRuntimes()
})

const run = (bin: string): RuntimeRun => ({
  bin,
  model: "default",
  effort: null,
  system: "Be brief.",
  prompt: "Hello",
  workspace: chatDir(),
  permission: "read_only",
  useTools: false,
  signal: new AbortController().signal,
  approve: async () => false,
  onLimits: () => {},
})

const drain = async (gen: AsyncGenerator<unknown>) => {
  try {
    for await (const _ of gen) {
      // The events do not matter here; only the start of the program does.
    }
  } catch {
    // A stand-in that answers little may end the turn with an error. The call is still noted.
  }
}

interface Call {
  args: string[]
  env?: Record<string, string>
  config?: { permission?: Record<string, string> }
}

/** What each program got for a turn of the chat, from its stand-in. */
const turnOf = async (kind: RuntimeKind): Promise<Call> => {
  const bins: Record<RuntimeKind, [string, () => Record<string, unknown>[]]> = {
    claude_code: [fake.claude, fake.claudeCalls],
    codex: [fake.codex, fake.codexCalls],
    muse: [fake.muse, fake.museCalls],
    pi: [fake.pi, fake.piCalls],
    opencode: [fake.opencode, fake.opencodeCalls],
    cursor: [fake.cursor, fake.cursorCalls],
  }
  const [bin, calls] = bins[kind]
  const before = calls().length
  await drain(drivers[kind].run({ ...run(bin) }))
  const made = calls().slice(before)
  const turn = made.find((c) => Array.isArray((c as Call).args))
  if (!turn) throw new Error(`${kind}: the stand-in noted no turn`)
  return turn as unknown as Call
}

const has = (args: string[], flag: string, value?: string) => {
  const at = args.indexOf(flag)
  return at >= 0 && (value === undefined || args[at + 1] === value)
}

/**
 * For each program: the flags that switch off its tools and that the program enforces, or `null`
 * when the launcher has none that closes every way (shell, file reads, tool servers, web). The
 * reason for each `null` is the way that stays open.
 */
const LOCKS: Record<RuntimeKind, ((call: Call) => boolean) | null> = {
  // `--tools ""` removes every built-in tool; `--strict-mcp-config` with no `--mcp-config` removes
  // the servers of the user; `--setting-sources ""` removes its settings and hooks.
  claude_code: ({ args }) =>
    has(args, "--tools", "") &&
    has(args, "--setting-sources", "") &&
    args.includes("--strict-mcp-config") &&
    !args.includes("--mcp-config") &&
    !args.includes("--allowedTools"),
  // `--no-tools`, `--no-mcp`, and no extension.
  pi: ({ args }) =>
    args.includes("--no-tools") &&
    args.includes("--no-mcp") &&
    !args.includes("--extension") &&
    !args.includes("--tools"),
  // The rules `{"*": "deny"}` are the last word on every tool, MCP tools too, and `--auto` is off.
  opencode: ({ config, args }) =>
    config?.permission?.["*"] === "deny" &&
    Object.keys(config.permission).length === 1 &&
    !args.includes("--auto"),
  // `-s read-only` still runs shell and reads any file; the servers of the user stay on.
  codex: null,
  // `--mode ask` can read and search files.
  cursor: null,
  // `--disable-write --disable-shell --disable-web-tools` leave the tools that read on.
  muse: null,
}

describe("the chat uses only a program that can be locked to text only", () => {
  for (const kind of RUNTIME_KINDS) {
    test(`${kind}: chatSafe matches the flags that the launcher sets`, async () => {
      const call = await turnOf(kind)
      const lock = LOCKS[kind]
      if (lock === null) {
        // No flag closes every way, so the chat does not use the program.
        expect(drivers[kind].chatSafe).toBe(false)
        expect(chatMayUse(kind)).toBe(false)
      } else {
        // A safe program keeps every flag; a missing one makes this fail.
        expect(lock(call)).toBe(true)
        expect(drivers[kind].chatSafe).toBe(true)
        expect(chatMayUse(kind)).toBe(true)
      }
    })
  }

  test("an API account is always allowed", () => {
    expect(chatMayUse(null)).toBe(true)
  })

  test("the table lists every program", () => {
    expect(Object.keys(LOCKS).sort()).toEqual([...RUNTIME_KINDS].sort())
    expect(Object.keys(drivers).sort()).toEqual([...RUNTIME_KINDS].sort())
  })
})

describe("the folder of the chat", () => {
  test("it is empty, private, under the temporary folder, and made again when it is gone", async () => {
    const { existsSync, readdirSync, rmSync, realpathSync } = await import("node:fs")
    const dir = chatDir()
    expect(realpathSync(dir).startsWith(realpathSync(tmpdir()))).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir)).toEqual([])
    rmSync(dir, { recursive: true })
    const again = chatDir()
    expect(existsSync(again)).toBe(true)
    expect(statSync(again).mode & 0o777).toBe(0o700)
    expect(join(again, "..")).toBe(join(dir, ".."))
  })
})
