import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { defaultSettings, resolveLocale, Settings, SettingsPatch } from "./settings.ts"

describe("settings", () => {
  test("defaults are valid", () => {
    expect(Schema.is(Settings)(defaultSettings)).toBe(true)
  })

  test("a patch may hold any subset of fields", () => {
    expect(Schema.is(SettingsPatch)({ theme: "light" })).toBe(true)
    expect(Schema.is(SettingsPatch)({})).toBe(true)
    expect(Schema.is(SettingsPatch)({ theme: "blue" })).toBe(false)
  })

  test("system language follows the system locale", () => {
    expect(resolveLocale("system", "ko-KR")).toBe("ko")
    expect(resolveLocale("system", "en-US")).toBe("en")
    expect(resolveLocale("system", "fr")).toBe("en")
    expect(resolveLocale("ko", "en-US")).toBe("ko")
  })
})
