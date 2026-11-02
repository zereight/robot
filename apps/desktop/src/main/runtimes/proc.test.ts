import { describe, expect, test } from "bun:test"
import { execute } from "./proc.ts"

describe.skipIf(process.platform === "win32")("running a program to its end", () => {
  test("a program that answers gives its output and its code", async () => {
    const done = await execute("sh", ["-c", "echo hello; exit 3"], {
      env: process.env,
      timeoutMs: 5000,
    })
    expect(done.code).toBe(3)
    expect(done.stdout.trim()).toBe("hello")
    expect(done.failure).toBeUndefined()
  })

  test("a program that does not answer is ended at the time limit", async () => {
    const started = Date.now()
    const done = await execute("sh", ["-c", "exec sleep 20"], { env: process.env, timeoutMs: 200 })
    expect(done.failure).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("a program that leaves a child with the pipes open does not hold the caller after the kill", async () => {
    // The shell ends at the kill, but its child keeps the pipes open for 4 seconds.
    const started = Date.now()
    const done = await execute("sh", ["-c", "sleep 4 & wait"], {
      env: process.env,
      timeoutMs: 200,
    })
    expect(done.failure).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
