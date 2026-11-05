import { describe, expect, test } from "bun:test"
import { limitFieldValid, limitPatch, limitText, parseLimit } from "./limit.ts"

// The box of the field "Daily token limit" of an organization (spec 030).

describe("the box of the field", () => {
  test("it takes a whole number, with commas and spaces", () => {
    expect(parseLimit("50000")).toBe(50_000)
    expect(parseLimit("50,000")).toBe(50_000)
    expect(parseLimit(" 100 000 000 ")).toBe(100_000_000)
  })

  test("it takes nothing else: no point, no sign, no letters, no empty box", () => {
    for (const text of ["", "  ", "12.5", "-5", "+5", "5e4", "ten", "1,0,0,0 0 a"])
      expect(parseLimit(text)).toBeNull()
  })

  test("the field is valid when it is off, or when the number is from 10,000 to 100,000,000", () => {
    expect(limitFieldValid(false, "")).toBe(true)
    expect(limitFieldValid(false, "garbage")).toBe(true)
    expect(limitFieldValid(true, "10,000")).toBe(true)
    expect(limitFieldValid(true, "100,000,000")).toBe(true)
    for (const text of ["9,999", "100,000,001", "0", "12.5", "", "99999999999999999999"])
      expect(limitFieldValid(true, text)).toBe(false)
  })

  test("the box shows a stored limit, and is empty while the limit is off", () => {
    expect(limitText(null)).toBe("")
    expect(limitText(50_000)).toBe("50000")
  })
})

describe("what the form sends", () => {
  test("nothing, when the user did not change the limit", () => {
    expect(limitPatch(null, false, "")).toEqual({})
    expect(limitPatch(50_000, true, "50000")).toEqual({})
    expect(limitPatch(50_000, true, "50,000")).toEqual({})
  })

  test("the new number, or null when the user turns the field off", () => {
    expect(limitPatch(null, true, "20,000")).toEqual({ dailyTokenLimit: 20_000 })
    expect(limitPatch(50_000, true, "100,000")).toEqual({ dailyTokenLimit: 100_000 })
    expect(limitPatch(50_000, false, "50000")).toEqual({ dailyTokenLimit: null })
  })
})
