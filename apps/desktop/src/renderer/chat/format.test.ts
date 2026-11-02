import { expect, test } from "bun:test"
import { formatDay, formatElapsed, formatHitTime } from "./format.ts"

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

test("a hit of message search shows the time today, and the day on other days", () => {
  const now = new Date(2026, 10, 2, 15, 0).getTime()
  const today = formatHitTime("en", new Date(2026, 10, 2, 9, 5).getTime(), now)
  expect(today).toMatch(/9:05/)
  expect(today).not.toMatch(/Nov/)
  const earlier = formatHitTime("en", new Date(2026, 9, 30, 9, 5).getTime(), now)
  expect(earlier).toMatch(/Oct/)
  expect(earlier).toMatch(/30/)
  expect(earlier).not.toMatch(/2026/)
  expect(formatHitTime("en", new Date(2025, 11, 31, 9, 5).getTime(), now)).toMatch(/2025/)
})
