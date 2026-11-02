import { describe, expect, test } from "bun:test"
import { type MessageKey, type TodayRow, translate } from "@robot/shared"
import { reasonText, rowLine, rowSource, whenText } from "./format.ts"

const NOW = Date.UTC(2036, 5, 15, 12, 0, 0)
const HOUR = 3_600_000

const en = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("en", key, params)
const ko = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("ko", key, params)

const row = (extra: Partial<TodayRow>): TodayRow => ({
  id: "x",
  kind: "approval",
  agentId: "a1",
  text: "Run step",
  where: null,
  computer: null,
  reason: null,
  count: 0,
  at: NOW,
  resetsAt: null,
  open: { kind: "task", id: "t1" },
  ...extra,
})

describe("Today row text", () => {
  test("a card or a task shows its own text", () => {
    expect(rowLine(en, "en", row({ text: "Delete the build folder" }), NOW)).toBe(
      "Delete the build folder",
    )
  })

  test("a line has at most 90 characters and ends with an ellipsis when it is cut", () => {
    const line = rowLine(en, "en", row({ text: "a".repeat(300) }), NOW)
    expect([...line]).toHaveLength(90)
    expect(line.endsWith("…")).toBe(true)
    // The composed lines are cut too, for a long routine name.
    const routine = rowLine(
      en,
      "en",
      row({ kind: "routine_paused", text: "r".repeat(200), count: 3 }),
      NOW,
    )
    expect([...routine]).toHaveLength(90)
  })

  test("a paused routine says Paused after the failed runs, with the last failure", () => {
    const line = rowLine(
      en,
      "en",
      row({
        kind: "routine_paused",
        text: "Morning check",
        count: 3,
        reason: { code: "provider_not_connected", detail: "" },
      }),
      NOW,
    )
    expect(line).toBe("Morning check: Paused after 3 failed runs. This account is not connected.")
  })

  test("an account says what is wrong, and a plan limit gives the reset time", () => {
    expect(rowLine(en, "en", row({ kind: "account_signin", text: "Work" }), NOW)).toBe(
      "Work: sign-in lost",
    )
    const limit = rowLine(
      en,
      "en",
      row({ kind: "account_limit", text: "Work", resetsAt: NOW + 2 * HOUR }),
      NOW,
    )
    expect(limit).toStartWith("Work: plan limit reached, resets at ")
    expect(limit).toContain(whenText("en", NOW + 2 * HOUR, NOW))
    expect(rowLine(en, "en", row({ kind: "account_limit", text: "Work" }), NOW)).toBe(
      "Work: plan limit reached",
    )
  })

  test("a routine that is due names its due time", () => {
    const due = rowLine(
      en,
      "en",
      row({ kind: "routine_next", text: "Report", at: NOW + 3 * HOUR }),
      NOW,
    )
    expect(due).toBe(`Report, due at ${whenText("en", NOW + 3 * HOUR, NOW)}`)
  })

  test("the source names the place, the other computer, or the count of runs", () => {
    expect(rowSource(en, "en", row({ where: { kind: "direct", name: "" } }), NOW)).toBe(
      "Direct chat",
    )
    expect(rowSource(en, "en", row({ where: { kind: "channel", name: "Launch" } }), NOW)).toBe(
      "#Launch",
    )
    expect(rowSource(en, "en", row({ computer: "Studio Mac" }), NOW)).toBe("From Studio Mac")
    expect(rowSource(en, "en", row({ computer: "" }), NOW)).toBe("From another computer")
    expect(rowSource(en, "en", row({ kind: "routine_done", count: 2, at: NOW }), NOW)).toContain(
      "2 runs, last at",
    )
    expect(rowSource(en, "en", row({ kind: "routine_done", count: 1, at: NOW }), NOW)).toContain(
      "1 run, at",
    )
  })

  test("a reason with no text of its own gets the general text", () => {
    expect(reasonText(en, { code: "no_such_reason", detail: "" })).toBe(en("error.unknown"))
    expect(reasonText(en, null)).toBe("")
  })

  test("the Korean page has no English words except names", () => {
    const lines = [
      rowLine(
        ko,
        "ko",
        row({
          kind: "routine_paused",
          text: "Morning check",
          count: 3,
          reason: { code: "provider_limit", detail: "" },
        }),
        NOW,
      ),
      rowLine(ko, "ko", row({ kind: "account_signin", text: "Work" }), NOW),
      rowLine(ko, "ko", row({ kind: "account_limit", text: "Work", resetsAt: NOW + HOUR }), NOW),
      rowSource(
        ko,
        "ko",
        row({ computer: "Studio Mac", where: { kind: "direct", name: "" } }),
        NOW,
      ),
      rowSource(ko, "ko", row({ kind: "routine_done", count: 2 }), NOW),
      ko("today.empty"),
      ko("today.unreadable"),
      ko("today.more"),
    ]
    for (const line of lines) {
      // Remove the names that the test gave, and the time, then look for latin words.
      const rest = line
        .replaceAll("Morning check", "")
        .replaceAll("Work", "")
        .replaceAll("Studio Mac", "")
      expect(rest).not.toMatch(/[A-Za-z]{3,}/)
    }
  })
})
