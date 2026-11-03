import { describe, expect, test } from "bun:test"
import {
  BROWSER_PROFILE_NAME_MAX,
  BROWSER_PROFILES_MAX,
  browserProfilesFull,
  checkBrowserProfileName,
} from "./browserProfiles.ts"

describe("browser profile names", () => {
  test("a name has 1 to 40 characters after the spaces at both ends are removed", () => {
    expect(checkBrowserProfileName("", [])).toBe("empty")
    expect(checkBrowserProfileName("   ", [])).toBe("empty")
    expect(checkBrowserProfileName("W", [])).toBeNull()
    expect(checkBrowserProfileName("a".repeat(BROWSER_PROFILE_NAME_MAX), [])).toBeNull()
    expect(checkBrowserProfileName("a".repeat(BROWSER_PROFILE_NAME_MAX + 1), [])).toBe("long")
    expect(checkBrowserProfileName(`  ${"a".repeat(BROWSER_PROFILE_NAME_MAX)}  `, [])).toBeNull()
  })

  test("it counts characters that the user sees, not code units", () => {
    expect(checkBrowserProfileName("🙂".repeat(BROWSER_PROFILE_NAME_MAX), [])).toBeNull()
    expect(checkBrowserProfileName("🙂".repeat(BROWSER_PROFILE_NAME_MAX + 1), [])).toBe("long")
    expect(checkBrowserProfileName("회사 계정", [])).toBeNull()
  })

  test("no two names are the same, ignoring case and the spaces at the ends", () => {
    expect(checkBrowserProfileName("Work", ["Home"])).toBeNull()
    expect(checkBrowserProfileName("work", ["Work"])).toBe("taken")
    expect(checkBrowserProfileName("  WORK ", ["work"])).toBe("taken")
  })
})

describe("the limit", () => {
  test("a computer holds at most 20 profiles", () => {
    expect(BROWSER_PROFILES_MAX).toBe(20)
    expect(browserProfilesFull(19)).toBe(false)
    expect(browserProfilesFull(20)).toBe(true)
  })
})
