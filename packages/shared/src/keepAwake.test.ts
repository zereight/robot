import { describe, expect, test } from "bun:test"
import {
  KEEP_AWAKE_DEFAULT,
  KEEP_AWAKE_MODES,
  type KeepAwakeInput,
  keepAwakeReason,
  keepAwakeState,
} from "./keepAwake.ts"

const input = (patch: Partial<KeepAwakeInput> = {}): KeepAwakeInput => ({
  mode: "routines",
  working: 0,
  routines: 0,
  onBattery: false,
  ...patch,
})

describe("keepAwakeReason", () => {
  test("the default is to keep awake while an agent works", () => {
    expect(KEEP_AWAKE_DEFAULT).toBe("working")
    expect(KEEP_AWAKE_MODES).toContain(KEEP_AWAKE_DEFAULT)
  })

  test("off never holds, whatever runs", () => {
    for (const onBattery of [false, true])
      expect(keepAwakeReason(input({ mode: "off", working: 3, routines: 2, onBattery }))).toBeNull()
  })

  test("working holds while an agent works, on power and on battery", () => {
    for (const onBattery of [false, true])
      expect(keepAwakeReason(input({ mode: "working", working: 1, onBattery }))).toBe("working")
  })

  test("working does not hold for a routine that waits for its time", () => {
    expect(keepAwakeReason(input({ mode: "working", routines: 4 }))).toBeNull()
  })

  test("nothing runs and no routine is on: nothing holds", () => {
    expect(keepAwakeReason(input({ mode: "working" }))).toBeNull()
    expect(keepAwakeReason(input({ mode: "routines" }))).toBeNull()
  })

  test("routines holds while a routine is on, on power", () => {
    expect(keepAwakeReason(input({ routines: 1 }))).toBe("routines")
  })

  test("routines lets go of a waiting routine on battery", () => {
    expect(keepAwakeReason(input({ routines: 2, onBattery: true }))).toBeNull()
  })

  test("work that runs holds on battery in the mode routines too, and the reason is the work", () => {
    expect(keepAwakeReason(input({ working: 1, routines: 2, onBattery: true }))).toBe("working")
    expect(keepAwakeReason(input({ working: 1, routines: 2, onBattery: false }))).toBe("working")
  })

  test("a negative or zero count holds nothing", () => {
    expect(keepAwakeReason(input({ working: 0, routines: 0 }))).toBeNull()
  })
})

describe("keepAwakeState", () => {
  test("carries the numbers that the settings show", () => {
    expect(keepAwakeState(input({ working: 2, routines: 5, onBattery: true }))).toEqual({
      reason: "working",
      mode: "routines",
      working: 2,
      routines: 5,
      onBattery: true,
    })
  })
})
