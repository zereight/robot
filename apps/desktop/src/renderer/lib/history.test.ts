import { describe, expect, test } from "bun:test"
import { createHistory } from "./history.ts"

describe("history of the window", () => {
  test("starts with nothing to go back or forward to", () => {
    const h = createHistory<string>()
    h.visit("a")
    expect(h.canBack()).toBe(false)
    expect(h.canForward()).toBe(false)
  })

  test("back and forward walk the steps", () => {
    const h = createHistory<string>()
    for (const x of ["a", "b", "c"]) h.visit(x)
    expect(h.back()).toBe("b")
    expect(h.back()).toBe("a")
    expect(h.back()).toBeUndefined()
    expect(h.forward()).toBe("b")
    expect(h.canForward()).toBe(true)
  })

  test("the same place twice adds one step", () => {
    const h = createHistory<string>()
    for (const x of ["a", "a", "b", "b"]) h.visit(x)
    expect(h.back()).toBe("a")
    expect(h.canBack()).toBe(false)
  })

  test("a new visit after back removes the forward steps", () => {
    const h = createHistory<string>()
    for (const x of ["a", "b", "c"]) h.visit(x)
    h.back()
    h.visit("d")
    expect(h.canForward()).toBe(false)
    expect(h.back()).toBe("b")
  })

  test("keeps the last steps only", () => {
    const h = createHistory<number>(3)
    for (const x of [1, 2, 3, 4]) h.visit(x)
    expect(h.back()).toBe(3)
    expect(h.back()).toBe(2)
    expect(h.back()).toBeUndefined()
  })

  test("a visit made by back or forward is not a new step", () => {
    const h = createHistory<string>()
    for (const x of ["a", "b"]) h.visit(x)
    h.visit(h.back() as string)
    expect(h.canForward()).toBe(true)
  })
})
