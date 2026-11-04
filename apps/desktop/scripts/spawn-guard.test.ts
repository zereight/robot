import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChildStalled, DEFAULT_LIMIT_SECONDS, spawnGuarded } from "./spawn-guard.ts"

// The children are small: the same Bun as the one that runs the tests, or the shell. A child that
// must stall waits on a pipe that nobody writes to, so it uses no processor time.
const never = [process.execPath, "-e", "await new Promise(() => {})"]

/** True while a process with this pid exists. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until the process is gone. A process that was not a child of ours ends a little after the kill. */
const goneWithin = async (pid: number, ms: number) => {
  const end = Date.now() + ms
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return !alive(pid)
}

const stalled = async (...args: Parameters<typeof spawnGuarded>) => {
  const started = performance.now()
  const error = await spawnGuarded(...args).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ChildStalled)
  return { error: error as ChildStalled, tookMs: performance.now() - started }
}

describe("a child that ends", () => {
  test("gives the code and the text of both outputs", async () => {
    const result = await spawnGuarded([
      process.execPath,
      "-e",
      "console.log('héllo'); console.error('warn')",
    ])
    expect(result).toEqual({ code: 0, out: "héllo\n", err: "warn\n" })
  })

  test("a code that is not zero is a result, not an error", async () => {
    const result = await spawnGuarded([
      process.execPath,
      "-e",
      "console.log('some'); console.error('bad'); process.exit(3)",
    ])
    expect(result).toEqual({ code: 3, out: "some\n", err: "bad\n" })
  })

  test("the child gets the working folder and the whole environment that were given", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "spawn-guard-")))
    try {
      const probe = [
        process.execPath,
        "-e",
        "console.log(JSON.stringify([process.cwd(), process.env.GUARD_A ?? null, process.env.PATH ?? null]))",
      ]
      const given = await spawnGuarded(probe, { cwd: dir, env: { GUARD_A: "one" } })
      expect(JSON.parse(given.out)).toEqual([dir, "one", null])
      // With no options the child gets the folder and the environment of this process.
      const plain = await spawnGuarded(probe)
      const [cwd, a, path] = JSON.parse(plain.out) as [string, string | null, string | null]
      expect(cwd).toBe(process.cwd())
      expect(a).toBe(process.env.GUARD_A ?? null)
      expect(path).toBe(process.env.PATH ?? null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a long output is read whole", async () => {
    const result = await spawnGuarded([
      process.execPath,
      "-e",
      "process.stdout.write('x'.repeat(300000)); process.stderr.write('y'.repeat(100000))",
    ])
    expect(result.out).toBe("x".repeat(300000))
    expect(result.err).toBe("y".repeat(100000))
  })
})

// The tests of a stall wait for a guard, so they run side by side: the file takes as long as its
// slowest test, not the sum.
describe.concurrent("a child that does not end", () => {
  test("fails after the limit; the message holds what is known; the child is gone", async () => {
    // The shell prints one marker on each output and then becomes `sleep`, so the pid stays.
    const command = ["sh", "-c", "echo OUT-MARK; echo ERR-MARK >&2; exec sleep 60"]
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "spawn-guard-")))
    try {
      const { error, tookMs } = await stalled(command, {
        cwd: dir,
        env: { PATH: process.env.PATH, SECRET_FOR_TEST: "sk-do-not-print" },
        limitSeconds: 1,
        sample: false,
      })
      expect(tookMs).toBeGreaterThanOrEqual(900)
      expect(tookMs).toBeLessThan(15_000)
      const message = error.message
      expect(message).toContain(`pid: ${error.pid}`)
      expect(message).toMatch(/waited: 1\.\d s \(limit 1 s\)/)
      expect(error.waitedSeconds).toBeGreaterThanOrEqual(0.9)
      expect(message).toContain(JSON.stringify(command))
      expect(message).toContain(`working folder: ${dir}`)
      expect(message).toContain("load average")
      expect(message).toContain("the child was still running")
      expect(message).toMatch(/stdout so far \(\d+ characters\):\nOUT-MARK/)
      expect(message).toMatch(/stderr so far \(\d+ characters\):\nERR-MARK/)
      // The environment of the child can hold keys, so it is never printed.
      expect(message).not.toContain("sk-do-not-print")
      // The process line shows the pid, and the sample is switched off.
      expect(message).toContain(`${error.pid} `)
      expect(message).toContain("sample was not asked for")
      expect(alive(error.pid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a child of Bun that waits for ever fails the same way", async () => {
    const { error } = await stalled(never, { limitSeconds: 0.5, sample: false })
    expect(error.message).toContain(`pid: ${error.pid}`)
    expect(() => process.kill(error.pid, 0)).toThrow()
  })

  test("a process that the child started is killed too", async () => {
    const command = ["sh", "-c", "sleep 60 & echo GRAND $!; wait"]
    const { error } = await stalled(command, { limitSeconds: 1, sample: false })
    const grand = Number(/GRAND (\d+)/.exec(error.message)?.[1])
    expect(grand).toBeGreaterThan(0)
    expect(error.message).toContain(`${grand} `)
    expect(alive(error.pid)).toBe(false)
    expect(await goneWithin(grand, 5_000)).toBe(true)
  })

  test("a child that ended but left its pipes open is a stall too, and the call does not hang", async () => {
    // `sleep 3` has the pipes of the shell, so the output never ends while it runs.
    const command = ["sh", "-c", "sleep 3 & echo LEFT; exit 7"]
    const { error, tookMs } = await stalled(command, { limitSeconds: 0.4, sample: true })
    expect(error.message).toContain("the child had ended (code 7")
    expect(error.message).toContain("output pipes were still open")
    expect(error.message).toMatch(/stdout so far \(\d+ characters\):\nLEFT/)
    expect(error.message).toContain("sample skipped: the child had already ended")
    expect(tookMs).toBeLessThan(10_000)
  })

  test("the sample step runs on macOS and says that it is skipped elsewhere", async () => {
    const { error } = await stalled(["sh", "-c", "exec sleep 60"], { limitSeconds: 0.3 })
    expect(error.message).toContain(`--- sample of pid ${error.pid}`)
    if (process.platform === "darwin") {
      expect(error.message).not.toContain("sample skipped")
      expect(error.message).toMatch(/Call graph:|could not run|was killed after|ended with code/)
    } else {
      expect(error.message).toContain("sample skipped: this is not macOS")
    }
    expect(alive(error.pid)).toBe(false)
  })

  test("the default limit is 15 seconds", () => {
    expect(DEFAULT_LIMIT_SECONDS).toBe(15)
  })
})
