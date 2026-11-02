import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  defaultSettings,
  resolveLocale,
  Settings,
  SettingsPatch,
  SILENT_LIMITS,
} from "./settings.ts"

describe("settings", () => {
  test("defaults are valid", () => {
    expect(Schema.is(Settings)(defaultSettings)).toBe(true)
  })

  test("a patch may hold any subset of fields", () => {
    expect(Schema.is(SettingsPatch)({ theme: "light" })).toBe(true)
    expect(Schema.is(SettingsPatch)({})).toBe(true)
    expect(Schema.is(SettingsPatch)({ theme: "blue" })).toBe(false)
  })

  test("the silent limit is 10 minutes at first, and takes only the listed choices", () => {
    expect(defaultSettings.silentLimit).toBe(10)
    expect([...SILENT_LIMITS].sort((a, b) => a - b)).toEqual([0, 1, 5, 10, 30, 60])
    for (const silentLimit of SILENT_LIMITS)
      expect(Schema.is(SettingsPatch)({ silentLimit })).toBe(true)
    expect(Schema.is(SettingsPatch)({ silentLimit: 7 })).toBe(false)
    expect(Schema.is(SettingsPatch)({ silentLimit: "never" })).toBe(false)
  })

  test("system language follows the system locale", () => {
    expect(resolveLocale("system", "ko-KR")).toBe("ko")
    expect(resolveLocale("system", "en-US")).toBe("en")
    expect(resolveLocale("system", "fr")).toBe("en")
    expect(resolveLocale("ko", "en-US")).toBe("ko")
  })
})
