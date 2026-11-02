import { describe, expect, test } from "bun:test"
import { nextMessageTime } from "./messageTime.ts"

describe("time of a new message", () => {
  test("the clock time when the last message is older", () => {
    expect(nextMessageTime(900, 1000)).toBe(1000)
    expect(nextMessageTime(null, 1000)).toBe(1000)
    expect(nextMessageTime(undefined, 1000)).toBe(1000)
  })

  test("1 ms after the last message when it has the same time or is a little ahead", () => {
    expect(nextMessageTime(1000, 1000)).toBe(1001)
    expect(nextMessageTime(1003, 1000)).toBe(1004)
  })

  test("the clock time when the last message is far ahead, as from a computer with a wrong clock", () => {
    expect(nextMessageTime(1000 + 12 * 60_000, 1000)).toBe(1000)
  })
})
