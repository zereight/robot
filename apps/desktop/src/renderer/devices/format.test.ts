import { expect, test } from "bun:test"
import { countdown } from "./format.ts"

test("time left shows as minutes and seconds", () => {
  expect(countdown(300_000)).toBe("5:00")
  expect(countdown(61_000)).toBe("1:01")
  expect(countdown(999)).toBe("0:01")
  expect(countdown(-5)).toBe("0:00")
})
