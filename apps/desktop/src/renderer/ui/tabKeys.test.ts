import { describe, expect, test } from "bun:test"
import { tabKeyDown } from "./tabKeys.ts"

const names = ["a", "b", "c"] as const

/** A strip of three tabs as far as the handler reads it: the focus goes to the tab it chooses. */
const press = (key: string, current: (typeof names)[number]) => {
  const focused: number[] = []
  const selected: string[] = []
  let prevented = false
  const tabs = names.map((_, i) => ({ focus: () => focused.push(i) }))
  tabKeyDown(
    {
      key,
      preventDefault: () => {
        prevented = true
      },
      currentTarget: { parentElement: { querySelectorAll: () => tabs } },
    } as never,
    names,
    current,
    (n) => selected.push(n),
  )
  return { focused, selected, prevented }
}

describe("the arrow keys of a strip of tabs", () => {
  test("Right and Left move, and wrap", () => {
    expect(press("ArrowRight", "a")).toEqual({ focused: [1], selected: ["b"], prevented: true })
    expect(press("ArrowRight", "c")).toEqual({ focused: [0], selected: ["a"], prevented: true })
    expect(press("ArrowLeft", "a")).toEqual({ focused: [2], selected: ["c"], prevented: true })
  })
  test("Home and End go to the first and the last", () => {
    expect(press("Home", "b").selected).toEqual(["a"])
    expect(press("End", "b").selected).toEqual(["c"])
  })
  test("another key does nothing", () => {
    expect(press("Enter", "a")).toEqual({ focused: [], selected: [], prevented: false })
  })
})
