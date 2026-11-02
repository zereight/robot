import { describe, expect, test } from "bun:test"
import { isForView } from "./events.ts"

describe("events of a view", () => {
  test("a view of this computer takes the events of this computer only", () => {
    expect(isForView(undefined, undefined)).toBe(true)
    expect(isForView(undefined, "server-b")).toBe(false)
  })

  test("a view of a linked server takes the events of that server only", () => {
    expect(isForView("server-b", "server-b")).toBe(true)
    expect(isForView("server-b", undefined)).toBe(false)
    expect(isForView("server-b", "server-c")).toBe(false)
  })
})
