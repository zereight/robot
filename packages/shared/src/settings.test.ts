import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  defaultSettings,
  isAgentsAtOnce,
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

  test("tool steps show at first, and the switch takes true or false", () => {
    expect(defaultSettings.showToolSteps).toBe(true)
    expect(Schema.is(SettingsPatch)({ showToolSteps: false })).toBe(true)
    expect(Schema.is(SettingsPatch)({ showToolSteps: "no" })).toBe(false)
  })

  test("agents working at once: a whole number from 1 to 8, 4 at first", () => {
    expect(defaultSettings.agentsAtOnce).toBe(4)
    for (const agentsAtOnce of [1, 8]) {
      expect(isAgentsAtOnce(agentsAtOnce)).toBe(true)
      expect(Schema.is(SettingsPatch)({ agentsAtOnce })).toBe(true)
    }
    for (const agentsAtOnce of [0, 9, 2.5]) {
      expect(isAgentsAtOnce(agentsAtOnce)).toBe(false)
      expect(Schema.is(SettingsPatch)({ agentsAtOnce })).toBe(false)
    }
  })
})
