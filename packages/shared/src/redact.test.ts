import { describe, expect, test } from "bun:test"
import { REDACTED, redactSecrets } from "./redact.ts"

describe("redactSecrets", () => {
  test("hides common key and token shapes", () => {
    const samples = [
      "sk-abcdefghijklmnop1234",
      "sk-ant-api03-abcdefghijklmnop",
      "Bearer abcdefghijklmnopqrstuv",
      `ghp_${"a".repeat(30)}`,
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl",
    ]
    for (const secret of samples) {
      const out = redactSecrets(`my key is ${secret} ok`)
      expect(out).not.toContain(secret)
      expect(out).toContain(REDACTED)
    }
  })

  test("hides a known value of any shape, but not short ones", () => {
    expect(redactSecrets("pass: hunter2-hunter2", ["hunter2-hunter2"])).toBe(`pass: ${REDACTED}`)
    expect(redactSecrets("a cat sat", ["cat"])).toBe("a cat sat")
  })

  test("leaves ordinary text alone", () => {
    const text = "Use the task-runner: sk is short, skip it. Bearer of news."
    expect(redactSecrets(text)).toBe(text)
  })
})
