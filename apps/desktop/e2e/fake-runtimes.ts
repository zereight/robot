import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"

const here = import.meta.dirname

export interface FakeRuntimes {
  readonly dir: string
  /** Full paths of the stand-in programs. */
  readonly claude: string
  readonly codex: string
  readonly muse: string
  readonly pi: string
  readonly opencode: string
  /** Changes what `auth status` or `login status` says. */
  setClaude(state: Record<string, unknown>): void
  setCodex(state: Record<string, unknown>): void
  setMuse(state: Record<string, unknown>): void
  setPi(state: Record<string, unknown>): void
  setOpencode(state: Record<string, unknown>): void
  /** What each program was asked to do, one entry per call, oldest first. */
  claudeCalls(): Record<string, unknown>[]
  /** The looks of Claude at the usage of the plan, oldest first. They are not turns. */
  claudeUsageCalls(): Record<string, unknown>[]
  codexCalls(): Record<string, unknown>[]
  museCalls(): Record<string, unknown>[]
  piCalls(): Record<string, unknown>[]
  opencodeCalls(): Record<string, unknown>[]
  /**
   * Every call that a program got, oldest first, as its first three arguments. A check shows
   * here as a version or a sign-in question; a turn shows as `exec` or the like.
   */
  asks(program: "claude" | "codex" | "muse" | "pi" | "opencode"): string[][]
}

const calls = (file: string) => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

/** Puts the stand-in programs in a new folder. They need `node` on the PATH. */
export const makeFakeRuntimes = (): FakeRuntimes => {
  const dir = mkdtempSync(join(tmpdir(), "robot-fake-runtimes-"))
  mkdirSync(dir, { recursive: true })
  for (const name of ["claude", "codex", "muse", "pi", "opencode"]) {
    // The file name of the program has no extension, like the real one.
    copyFileSync(resolve(here, "fakes", `${name}.mjs`), join(dir, `${name}.mjs`))
    writeFileSync(join(dir, name), `#!/bin/sh\nexec node "${join(dir, `${name}.mjs`)}" "$@"\n`)
    chmodSync(join(dir, name), 0o755)
  }
  return {
    dir,
    claude: join(dir, "claude"),
    codex: join(dir, "codex"),
    muse: join(dir, "muse"),
    pi: join(dir, "pi"),
    opencode: join(dir, "opencode"),
    setMuse: (state) => writeFileSync(join(dir, "muse-state.json"), JSON.stringify(state)),
    setPi: (state) => writeFileSync(join(dir, "pi-state.json"), JSON.stringify(state)),
    museCalls: () => calls(join(dir, "muse-calls.jsonl")),
    piCalls: () => calls(join(dir, "pi-calls.jsonl")),
    setOpencode: (state) => writeFileSync(join(dir, "opencode-state.json"), JSON.stringify(state)),
    opencodeCalls: () => calls(join(dir, "opencode-calls.jsonl")),
    setClaude: (state) => writeFileSync(join(dir, "claude-state.json"), JSON.stringify(state)),
    setCodex: (state) => writeFileSync(join(dir, "codex-state.json"), JSON.stringify(state)),
    claudeCalls: () => calls(join(dir, "claude-calls.jsonl")),
    claudeUsageCalls: () => calls(join(dir, "claude-usage-calls.jsonl")),
    codexCalls: () => calls(join(dir, "codex-calls.jsonl")),
    asks: (program) => calls(join(dir, `${program}-asks.jsonl`)) as unknown as string[][],
  }
}

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

/** A `.tar.gz` with one file, like the release files of Codex. */
export const tarGzOf = (name: string, content: string | Buffer) => {
  const body = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124)
  header.write("0", 156)
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]))
}
