import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runClaude } from "./claude.ts"
import { codexArgs, runCodex } from "./codex.ts"
import { runCursor } from "./cursor.ts"
import { runMuse } from "./muse.ts"
import { runOpencode } from "./opencode.ts"
import { runPi } from "./pi.ts"
import type { RuntimeRun } from "./types.ts"

/**
 * Stop on a vendor program ends the program and the processes that it started (spec 007, 005).
 * The stand-in is a shell script, as the brief says: it starts a grandchild and waits.
 */
const standIn = () => {
  const dir = mkdtempSync(join(tmpdir(), "robot-stop-"))
  const pids = join(dir, "pids.txt")
  const bin = join(dir, "program.sh")
  writeFileSync(bin, `#!/bin/sh\nsleep 60 &\necho "$$ $!" > ${pids}\nwait\n`)
  chmodSync(bin, 0o755)
  return { dir, bin, pids }
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

const launchers = {
  claude_code: runClaude,
  codex: runCodex,
  cursor: runCursor,
  muse: runMuse,
  pi: runPi,
  opencode: runOpencode,
} as const

describe("Stop kills the process group of a vendor program", () => {
  for (const [name, launch] of Object.entries(launchers)) {
    test(`${name}: the grandchild is gone after Stop`, async () => {
      const program = standIn()
      const controller = new AbortController()
      const run: RuntimeRun = {
        bin: program.bin,
        model: "default",
        effort: null,
        system: "",
        prompt: "go",
        workspace: program.dir,
        permission: "ask_risky",
        useTools: true,
        signal: controller.signal,
        approve: async () => true,
        onLimits: () => {},
      }
      const events = launch(run)
      const reading = (async () => {
        try {
          for await (const _ of events) {
            // The stand-in says nothing.
          }
        } catch {
          // The turn ends without a result: the error does not matter here.
        }
      })()
      const until = Date.now() + 5000
      while (!existsSync(program.pids) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20))
      const [child, grandchild] = readFileSync(program.pids, "utf8").trim().split(" ").map(Number)
      expect(grandchild).toBeGreaterThan(1)
      expect(gone(grandchild as number)).toBe(false)
      controller.abort()
      await reading
      const end = Date.now() + 5000
      while (!(gone(child as number) && gone(grandchild as number)) && Date.now() < end)
        await new Promise((r) => setTimeout(r, 20))
      expect(gone(child as number)).toBe(true)
      expect(gone(grandchild as number)).toBe(true)
    })
  }
})

describe("Codex at Read only", () => {
  const run = (permission: RuntimeRun["permission"]): RuntimeRun => ({
    bin: "codex",
    model: "default",
    effort: null,
    system: "",
    prompt: "go",
    workspace: "/tmp/w",
    permission,
    useTools: true,
    signal: new AbortController().signal,
    approve: async () => true,
    onLimits: () => {},
  })

  test("the MCP servers of the user are replaced by none, and the sandbox is read-only", () => {
    const args = codexArgs(run("read_only"))
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "read-only"])
    const at = args.indexOf("mcp_servers={}")
    expect(at).toBeGreaterThan(0)
    expect(args[at - 1]).toBe("-c")
  })

  test("the other levels leave the servers of the user alone", () => {
    for (const level of ["ask_all", "ask_risky", "full"] as const)
      expect(codexArgs(run(level))).not.toContain("mcp_servers={}")
  })
})
