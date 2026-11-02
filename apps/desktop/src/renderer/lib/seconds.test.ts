import { describe, expect, test } from "bun:test"
import { formatSeconds } from "./seconds.ts"

describe("formatSeconds", () => {
  test("shows seconds with one decimal", () => {
    expect(formatSeconds(2049, "en")).toBe("2.0")
    expect(formatSeconds(2051, "en")).toBe("2.1")
    expect(formatSeconds(0, "en")).toBe("0.0")
    expect(formatSeconds(125_300, "ko")).toBe("125.3")
  })
})
