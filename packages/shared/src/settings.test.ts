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

  test("the step limit is a whole number from 20 to 2000, 300 by default (spec 013)", () => {
    expect(defaultSettings.stepLimit).toBe(300)
    const ok = (value: unknown) => Schema.is(SettingsPatch)({ stepLimit: value })
    expect(ok(20)).toBe(true)
    expect(ok(2000)).toBe(true)
    expect(ok(19)).toBe(false)
    expect(ok(2001)).toBe(false)
    expect(ok(99.5)).toBe(false)
    expect(ok("300")).toBe(false)
  })

  test("system language follows the system locale", () => {
    expect(resolveLocale("system", "ko-KR")).toBe("ko")
    expect(resolveLocale("system", "en-US")).toBe("en")
    expect(resolveLocale("system", "fr")).toBe("en")
    expect(resolveLocale("ko", "en-US")).toBe("ko")
  })
})
