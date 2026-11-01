import { expect, test } from "bun:test"
import { formatDay, formatElapsed } from "./format.ts"

test("elapsed time reads as m:ss", () => {
  expect(formatElapsed(0)).toBe("0:00")
  expect(formatElapsed(12_400)).toBe("0:12")
  expect(formatElapsed(125_000)).toBe("2:05")
})

test("day lines say today and yesterday", () => {
  const now = new Date(2026, 10, 1, 10, 0).getTime()
  expect(formatDay("en", now - 3_600_000, "Today", "Yesterday", now)).toBe("Today")
  expect(formatDay("en", now - 86_400_000, "Today", "Yesterday", now)).toBe("Yesterday")
  expect(formatDay("en", new Date(2026, 9, 3).getTime(), "Today", "Yesterday", now)).toBe(
    "October 3, 2026",
  )
})
