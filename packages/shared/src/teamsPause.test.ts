import { describe, expect, test } from "bun:test"
import { catalogues, translate } from "./i18n/index.ts"
import { TEAMS_STATES, teamsStateTextKey, teamsStateWordKey } from "./teamsLink.ts"
import {
  afterOffline,
  countRead,
  countSend,
  isTeamsPauseReason,
  noFailures,
  TEAMS_PAUSE_READS,
  TEAMS_PAUSE_SENDS,
  type TeamsFailCounts,
  type TeamsNeed,
  teamsNeed,
  teamsNoticeBodyKey,
  teamsNoticeStep,
  teamsNoticeTitleKey,
  teamsPauseReasonKey,
} from "./teamsPause.ts"
import { dayBounds, teamsProblem, wrongRows } from "./today.ts"

// The pure rules of the pause, of the notification and of the row in Today (spec 028, 015, 021).

/** Feeds a list of results to a counter and gives the counts and the first pause. */
const feed = (
  count: typeof countRead,
  results: readonly ("good" | "failed" | "neutral")[],
  from: TeamsFailCounts = noFailures,
) => {
  let counts = from
  const pauses: (string | null)[] = []
  for (const result of results) {
    const counted = count(counts, result)
    counts = counted.counts
    pauses.push(counted.pause)
  }
  return { counts, pauses }
}
const failed = (n: number) => Array.from({ length: n }, () => "failed" as const)

describe("the limits", () => {
  test("20 failed reads in a row, or 6 failed tries to send in a row, are the limits of the spec", () => {
    expect(TEAMS_PAUSE_READS).toBe(20)
    expect(TEAMS_PAUSE_SENDS).toBe(6)
  })
})

describe("the count of failed reads", () => {
  test("19 failed reads do not pause the link; the 20th does", () => {
    const nineteen = feed(countRead, failed(19))
    expect(nineteen.counts.reads).toBe(19)
    expect(nineteen.pauses.every((p) => p === null)).toBe(true)
    const twenty = feed(countRead, failed(20))
    expect(twenty.pauses.slice(0, 19).every((p) => p === null)).toBe(true)
    expect(twenty.pauses[19]).toBe("read")
  })

  test("a good read sets the count to 0", () => {
    const { counts, pauses } = feed(countRead, [...failed(19), "good", ...failed(19)])
    expect(pauses.every((p) => p === null)).toBe(true)
    expect(counts.reads).toBe(19)
    expect(feed(countRead, [...failed(19), "good"]).counts.reads).toBe(0)
  })

  test("a result that says nothing about the page keeps the count: it neither adds nor resets", () => {
    const { counts, pauses } = feed(countRead, [...failed(10), "neutral", "neutral", ...failed(9)])
    expect(counts.reads).toBe(19)
    expect(pauses.every((p) => p === null)).toBe(true)
    expect(feed(countRead, [...failed(10), "neutral", ...failed(10)]).pauses.at(-1)).toBe("read")
  })

  test("a pause sets both counts to 0, so that a resume starts clean", () => {
    const start: TeamsFailCounts = { reads: 19, sends: 4 }
    const counted = countRead(start, "failed")
    expect(counted.pause).toBe("read")
    expect(counted.counts).toEqual(noFailures)
  })

  test("a good read does not touch the count of sends, and a good send does not touch the reads", () => {
    const mixed: TeamsFailCounts = { reads: 7, sends: 3 }
    expect(countRead(mixed, "good").counts).toEqual({ reads: 0, sends: 3 })
    expect(countSend(mixed, "good").counts).toEqual({ reads: 7, sends: 0 })
  })
})

describe("the count of failed tries to send", () => {
  test("5 failed tries do not pause the link; the 6th does", () => {
    expect(feed(countSend, failed(5)).pauses.every((p) => p === null)).toBe(true)
    const six = feed(countSend, failed(6))
    expect(six.pauses.slice(0, 5).every((p) => p === null)).toBe(true)
    expect(six.pauses[5]).toBe("send")
  })

  test("a good send sets the count to 0", () => {
    const run = feed(countSend, [...failed(5), "good", ...failed(5)])
    expect(run.pauses.every((p) => p === null)).toBe(true)
    expect(run.counts.sends).toBe(5)
  })

  test("a try that says nothing about the page keeps the count", () => {
    expect(feed(countSend, [...failed(3), "neutral", ...failed(2)]).counts.sends).toBe(5)
    expect(feed(countSend, [...failed(3), "neutral", ...failed(3)]).pauses.at(-1)).toBe("send")
  })

  test("the network that drops ends the row of failed tries, and not the row of failed reads", () => {
    expect(afterOffline({ reads: 12, sends: 5 })).toEqual({ reads: 12, sends: 0 })
  })
})

describe("the reasons of a pause", () => {
  test("two reasons, with the texts of the spec, in both languages", () => {
    expect(isTeamsPauseReason("read")).toBe(true)
    expect(isTeamsPauseReason("send")).toBe(true)
    expect(isTeamsPauseReason("other")).toBe(false)
    expect(translate("en", teamsPauseReasonKey("read"))).toBe("The app cannot read the Teams page")
    expect(translate("en", teamsPauseReasonKey("send"))).toBe("Teams does not take the messages")
    for (const reason of ["read", "send"] as const) {
      expect(translate("ko", teamsPauseReasonKey(reason))).not.toBe(
        translate("en", teamsPauseReasonKey(reason)),
      )
    }
  })

  test("the state Paused is one of the eight states, with its text and its word", () => {
    expect(TEAMS_STATES).toHaveLength(8)
    expect(TEAMS_STATES).toContain("paused")
    expect(translate("en", teamsStateTextKey("paused", null))).toBe("Paused after repeated failure")
    expect(translate("en", teamsStateWordKey("paused") ?? "teams.mark")).toBe("Paused")
    expect(translate("ko", teamsStateTextKey("paused", null))).toBe("반복된 실패로 멈췄어요")
    expect(translate("ko", teamsStateWordKey("paused") ?? "teams.mark")).toBe("멈춤")
    expect(translate("en", "teams.resume")).toBe("Resume")
    expect(translate("ko", "teams.resume")).toBe("다시 시작")
  })
})

describe("the notification", () => {
  test("only Signed out and Paused need the user", () => {
    expect(teamsNeed("signedOut")).toBe("signedOut")
    expect(teamsNeed("paused")).toBe("paused")
    for (const state of TEAMS_STATES.filter((s) => s !== "signedOut" && s !== "paused"))
      expect(teamsNeed(state)).toBeNull()
  })

  test("a notification goes out when the state becomes Signed out or Paused, once for each change", () => {
    const signed = teamsNoticeStep(null, "signedOut")
    expect(signed).toEqual({ notify: "signedOut", memory: "signedOut" })
    // The loop looks again and the state is the same: no second notification.
    expect(teamsNoticeStep(signed.memory, "signedOut").notify).toBeNull()
    const paused = teamsNoticeStep(null, "paused")
    expect(paused).toEqual({ notify: "paused", memory: "paused" })
    expect(teamsNoticeStep(paused.memory, "paused").notify).toBeNull()
  })

  test("it goes again after the state was fine: a new change", () => {
    let memory: TeamsNeed | null = null
    const states = ["signedOut", "signedOut", "on", "signedOut", "on", "paused"] as const
    const sent: (TeamsNeed | null)[] = []
    for (const state of states) {
      const step = teamsNoticeStep(memory, state)
      memory = step.memory
      sent.push(step.notify)
    }
    expect(sent).toEqual(["signedOut", null, null, "signedOut", null, "paused"])
  })

  test("the user turns the link off: no notification, and the memory ends", () => {
    expect(teamsNoticeStep("signedOut", "off")).toEqual({ notify: null, memory: null })
    expect(teamsNoticeStep("paused", "off")).toEqual({ notify: null, memory: null })
    // A new switch on that ends signed out again is a new change.
    expect(teamsNoticeStep(null, "signedOut").notify).toBe("signedOut")
  })

  test("Connecting and Offline keep the memory: a short look that fails is no new change", () => {
    expect(teamsNoticeStep("signedOut", "offline")).toEqual({ notify: null, memory: "signedOut" })
    expect(teamsNoticeStep("signedOut", "connecting")).toEqual({
      notify: null,
      memory: "signedOut",
    })
    // A flap between Signed out and Offline makes one notification only.
    let memory: TeamsNeed | null = null
    let count = 0
    for (const state of ["signedOut", "offline", "signedOut", "offline", "signedOut"] as const) {
      const step = teamsNoticeStep(memory, state)
      memory = step.memory
      if (step.notify) count++
    }
    expect(count).toBe(1)
  })

  test("Chat not found and Target missing end the need: the user sees them in the state", () => {
    expect(teamsNoticeStep("signedOut", "chatNotFound").memory).toBeNull()
    expect(teamsNoticeStep("paused", "targetMissing").memory).toBeNull()
  })

  test("title and body hold no name and no message: only the state and the reason", () => {
    expect(translate("en", teamsNoticeTitleKey)).toBe("Teams link needs you")
    expect(translate("en", teamsNoticeBodyKey("signedOut"))).toBe(
      "Signed out. Sign in to Teams to go on.",
    )
    expect(
      translate("en", teamsNoticeBodyKey("paused"), {
        reason: translate("en", teamsPauseReasonKey("send")),
      }),
    ).toBe("Paused after repeated failure. Teams does not take the messages.")
    // Every text has a Korean text of its own.
    for (const key of [
      teamsNoticeTitleKey,
      teamsNoticeBodyKey("signedOut"),
      teamsNoticeBodyKey("paused"),
      "settings.notify.kind.teams_link",
    ] as const) {
      expect(catalogues.ko[key]).not.toBe(catalogues.en[key])
      expect(catalogues.ko[key]).toBeTruthy()
    }
  })
})

describe("the row in Today", () => {
  const day = dayBounds(Date.UTC(2036, 5, 15, 12, 0, 0))

  test("no row when the link is fine or off", () => {
    expect(teamsProblem(null)).toBeNull()
  })

  test("a signed-out link has one row that opens Settings, Teams, and holds no text", () => {
    const row = teamsProblem({ state: "signedOut", reason: null, since: 1000 })
    expect(row).toMatchObject({
      kind: "teams_signed_out",
      text: "",
      agentId: null,
      computer: null,
      reason: null,
      at: 1000,
      open: { kind: "teams" },
    })
  })

  test("a paused link has one row with the reason", () => {
    const row = teamsProblem({ state: "paused", reason: "send", since: 2000 })
    expect(row).toMatchObject({
      kind: "teams_paused",
      reason: { code: "send", detail: "" },
      at: 2000,
      open: { kind: "teams" },
    })
  })

  test("the row is in 'Went wrong', and it stays from an earlier day", () => {
    const earlier = day.start - 3 * 24 * 3_600_000
    const rows = wrongRows([], [], [], day, day.start + 1000, {
      state: "paused",
      reason: "read",
      since: earlier,
    })
    expect(rows.map((r) => r.id)).toEqual(["teams:link"])
    expect(wrongRows([], [], [], day, day.start + 1000, null)).toEqual([])
  })
})
