import { describe, expect, test } from "bun:test"
import { Cause, Effect, Fiber } from "effect"
import { AppError } from "./errors.ts"
import {
  ASK_REPLY_LINE,
  askPrompt,
  canAnswerPlainPrompt,
  readVerdict,
  withTries,
} from "./workflowAsk.ts"

/** A call that fails with these codes, one after the other, and then gives "answer". */
const calls = (codes: readonly string[]) => {
  const log: number[] = []
  const attempt = Effect.suspend(() => {
    const code = codes[log.length]
    log.push(Date.now())
    return code === undefined
      ? Effect.succeed("answer")
      : Effect.fail(new AppError({ code, detail: "boom" }))
  })
  return { attempt, log }
}

describe("withTries", () => {
  test("a call that works needs one try", async () => {
    const c = calls([])
    expect(await Effect.runPromise(withTries(c.attempt, { delayMs: 0 }))).toEqual({
      ok: true,
      value: "answer",
      tries: 1,
    })
  })

  test("a plain failure is tried again, up to 3 tries in all", async () => {
    const works = calls(["provider_error", "provider_unreachable"])
    expect(await Effect.runPromise(withTries(works.attempt, { delayMs: 0 }))).toMatchObject({
      ok: true,
      tries: 3,
    })
    const fails = calls(["provider_error", "provider_error", "provider_error", "provider_error"])
    const result = await Effect.runPromise(withTries(fails.attempt, { delayMs: 0 }))
    expect(result).toMatchObject({ ok: false, tries: 3 })
    expect(fails.log).toHaveLength(3)
  })

  test("the tries are 2 seconds apart", async () => {
    const c = calls(["provider_error"])
    await Effect.runPromise(withTries(c.attempt))
    expect(c.log).toHaveLength(2)
    expect((c.log[1] ?? 0) - (c.log[0] ?? 0)).toBeGreaterThanOrEqual(1950)
  }, 10_000)

  for (const code of [
    "provider_limit",
    "provider_busy",
    "provider_auth",
    "runtime_signed_out",
    "provider_not_connected",
  ]) {
    test(`${code} ends the step at once`, async () => {
      const c = calls([code, code])
      const result = await Effect.runPromise(withTries(c.attempt, { delayMs: 0 }))
      expect(result).toMatchObject({ ok: false, tries: 1 })
      expect(c.log).toHaveLength(1)
      if (!result.ok) expect(result.error.code).toBe(code)
    })
  }

  test("a stop or a shutdown interrupts the call and does not start another try", async () => {
    let started = 0
    const attempt = Effect.suspend(() => {
      started++
      return Effect.never
    })
    const fiber = Effect.runFork(withTries(attempt, { delayMs: 0 }))
    await Bun.sleep(20)
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(started).toBe(1)
  })

  test("a defect is not a plain failure of the call and ends the step", async () => {
    let n = 0
    const attempt = Effect.suspend(() => (++n < 2 ? Effect.die("odd") : Effect.succeed("ok")))
    // A defect is not a failure of the call: it ends the step and does not hide in a retry.
    await expect(Effect.runPromise(withTries(attempt, { delayMs: 0 }))).resolves.toMatchObject({
      ok: false,
      tries: 1,
    })
  })
})

describe("readVerdict", () => {
  test("yes and no pick a branch", () => {
    expect(readVerdict("Yes.")).toEqual({ branch: "yes" })
    expect(readVerdict("no")).toEqual({ branch: "no" })
  })
  test("another answer is an error that holds its start", () => {
    expect(readVerdict("It might be\nso")).toEqual({
      error: "answer_not_yes_no: It might be so",
    })
    const long = readVerdict("z".repeat(1000))
    expect("error" in long && long.error.length).toBe("answer_not_yes_no: ".length + 240)
  })
})

test("the message ends with the form of the answer, and holds the question and the text", () => {
  const message = askPrompt("Is it a greeting?", "Hello there")
  expect(message).toContain("Is it a greeting?")
  expect(message).toContain("Hello there")
  expect(message.endsWith(ASK_REPLY_LINE)).toBe(true)
})

test("Muse Code cannot answer a prompt with no tools and no chat", () => {
  expect(canAnswerPlainPrompt("muse")).toBe(false)
  for (const kind of ["openai", "anthropic", "custom", "claude_code", "codex", "pi"])
    expect(canAnswerPlainPrompt(kind)).toBe(true)
})
