import { beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import { hasReadOnlyMode, READ_ONLY_HELP } from "./readonly.ts"

let fake: FakeRuntimes
beforeAll(() => {
  fake = makeFakeRuntimes()
})

describe("the read-only mode of a program is found in its own help text", () => {
  test("a program whose help names the controls has the mode", async () => {
    // The four programs are separate scripts: the checks share nothing and run together.
    const [claude, codex, muse, pi] = await Promise.all([
      hasReadOnlyMode("claude_code", fake.claude),
      hasReadOnlyMode("codex", fake.codex),
      hasReadOnlyMode("muse", fake.muse),
      hasReadOnlyMode("pi", fake.pi),
    ])
    expect(claude).toBe(true)
    expect(codex).toBe(true)
    expect(muse).toBe(true)
    expect(pi).toBe(true)
  })

  test("a program whose help lacks the controls has no mode", async () => {
    fake.setClaude({ noReadOnly: true })
    fake.setCodex({ noReadOnly: true })
    fake.setMuse({ noReadOnly: true })
    fake.setPi({ noReadOnly: true })
    const [claude, codex, muse, pi] = await Promise.all([
      hasReadOnlyMode("claude_code", fake.claude),
      hasReadOnlyMode("codex", fake.codex),
      hasReadOnlyMode("muse", fake.muse),
      hasReadOnlyMode("pi", fake.pi),
    ])
    expect(claude).toBe(false)
    expect(codex).toBe(false)
    expect(muse).toBe(false)
    expect(pi).toBe(false)
  })

  test("opencode has no mode: its help names none, and rules in its settings are not a mode", async () => {
    expect(READ_ONLY_HELP.opencode).toEqual([])
    expect(await hasReadOnlyMode("opencode", fake.opencode)).toBe(false)
  })

  test("Muse Code has the mode only when both of its programs name both controls", () => {
    const checks = READ_ONLY_HELP.muse
    expect(checks.map((c) => c.args[0])).toEqual(["exec", "serve"])
    for (const check of checks) expect(check.needs).toHaveLength(2)
  })

  test("Codex has the mode only when its help names the sandbox and the value read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-readonly-"))
    const only = (text: string) => {
      const path = join(dir, `codex-${Math.random().toString(36).slice(2)}`)
      writeFileSync(path, `#!/bin/sh\necho '${text}'\n`)
      chmodSync(path, 0o755)
      return path
    }
    const [full, noReadOnly, bare] = await Promise.all([
      hasReadOnlyMode("codex", only("  --sandbox <MODE> read-only, workspace-write")),
      hasReadOnlyMode("codex", only("  --sandbox <MODE> workspace-write")),
      hasReadOnlyMode("codex", only("  read-only")),
    ])
    expect(full).toBe(true)
    expect(noReadOnly).toBe(false)
    expect(bare).toBe(false)
  })

  test("a program that does not start, or is not there, has no mode: the app does not guess", async () => {
    expect(await hasReadOnlyMode("claude_code", "/no/such/claude")).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), "robot-readonly-"))
    const broken = join(dir, "broken")
    writeFileSync(broken, "#!/bin/sh\nexit 3\n")
    chmodSync(broken, 0o755)
    expect(await hasReadOnlyMode("pi", broken)).toBe(false)
  })
})
