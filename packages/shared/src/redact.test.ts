import { describe, expect, test } from "bun:test"
import { looksLikeSecret, REDACTED, redactSecrets } from "./redact.ts"

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

describe("looksLikeSecret", () => {
  test("is true for a key of a known form and for a stored value", () => {
    expect(looksLikeSecret("my key is sk-abcdefghijklmnop1234")).toBe(true)
    expect(looksLikeSecret("pass: hunter2-hunter2", ["hunter2-hunter2"])).toBe(true)
    expect(looksLikeSecret("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(
      true,
    )
  })

  test("is false for ordinary text, and for the mark itself", () => {
    expect(looksLikeSecret("Likes green tea")).toBe(false)
    expect(looksLikeSecret("a cat sat", ["cat"])).toBe(false)
    expect(looksLikeSecret(REDACTED)).toBe(false)
  })
})
