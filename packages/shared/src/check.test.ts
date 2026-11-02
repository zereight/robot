import { describe, expect, test } from "bun:test"
import {
  cleanDoneTest,
  cleanReason,
  DONE_TEST_MAX,
  endChars,
  needsVerdict,
  nudgeRefusal,
  parseCheck,
  partText,
  stillNotMet,
  VERDICT_REASON_MAX,
} from "./check.ts"

describe("the done test", () => {
  test("it is one line of up to 200 characters, or nothing", () => {
    expect(cleanDoneTest("Holds a title")).toBe("Holds a title")
    expect(cleanDoneTest("  Holds a title\n and a date \n")).toBe("Holds a title and a date")
    expect(cleanDoneTest("x".repeat(DONE_TEST_MAX + 40))).toBe("x".repeat(DONE_TEST_MAX))
    expect(cleanDoneTest("   ")).toBeNull()
    expect(cleanDoneTest("")).toBeNull()
    expect(cleanDoneTest(12)).toBeNull()
    expect(cleanDoneTest(undefined)).toBeNull()
  })

  test("a character is a code point, so an emoji counts once", () => {
    expect([...(cleanDoneTest("😀".repeat(300)) ?? "")]).toHaveLength(DONE_TEST_MAX)
  })

  test("the member gets it before the prompt, so the prompt stays the last line", () => {
    expect(partText("Intro", "Write the intro", "Holds a title")).toBe(
      "Your part: Intro\nDone test: Holds a title\nWrite the intro",
    )
    expect(partText("Intro", "Write the intro", null)).toBe("Your part: Intro\nWrite the intro")
  })

  test("the reason of a verdict is up to 160 characters on one line", () => {
    expect(cleanReason("Half of the facts\nare missing")).toBe("Half of the facts are missing")
    expect(cleanReason("y".repeat(300))).toBe("y".repeat(VERDICT_REASON_MAX))
    expect(cleanReason("  ")).toBeNull()
  })

  test("the end of a reply keeps the last characters", () => {
    expect(endChars("abcdef", 3)).toBe("def")
    expect(endChars("abc", 5)).toBe("abc")
  })
})

describe("which part gets a verdict", () => {
  const part = {
    state: "done" as const,
    doneTest: "Holds a title",
    verdict: null,
    decidedAt: null,
  }
  test("a part that is done, has a done test, no verdict and no decision gets one", () => {
    expect(needsVerdict(part)).toBe(true)
  })
  test("a failed, blocked, cancelled or open part gets none", () => {
    for (const state of ["failed", "blocked", "cancelled", "queued", "running", "review"] as const)
      expect(needsVerdict({ ...part, state }), state).toBe(false)
  })
  test("a part with no done test, a verdict, or a decision of the user gets none", () => {
    expect(needsVerdict({ ...part, doneTest: null })).toBe(false)
    expect(needsVerdict({ ...part, verdict: "met" })).toBe(false)
    expect(needsVerdict({ ...part, verdict: "not_met" })).toBe(false)
    expect(needsVerdict({ ...part, decidedAt: 5 })).toBe(false)
  })
})

describe("the answer of the lead", () => {
  test("reads verdicts and a nudge, also inside a code fence", () => {
    const json = JSON.stringify({
      verdicts: [
        { part: 1, verdict: "met" },
        { part: 2, verdict: "not_met", reason: "Half of the facts are missing." },
      ],
      action: "nudge",
      part: 2,
      instruction: "Finish the facts.",
    })
    for (const reply of [json, `\`\`\`json\n${json}\n\`\`\``, `Here it is: ${json} done`]) {
      expect(parseCheck(reply)).toEqual({
        verdicts: [
          { part: 1, verdict: "met", reason: null },
          { part: 2, verdict: "not_met", reason: "Half of the facts are missing." },
        ],
        action: { kind: "nudge", part: 2, member: null, instruction: "Finish the facts." },
      })
    }
  })

  test("a part number may be a text, a verdict may be spelled in other ways", () => {
    const answer = parseCheck(
      '{"verdicts":[{"part":"3","verdict":"Not Met","reason":"No"},{"part":4,"verdict":"not-met"}],"action":"nothing"}',
    )
    expect(answer?.verdicts).toEqual([
      { part: 3, verdict: "not_met", reason: "No" },
      { part: 4, verdict: "not_met", reason: null },
    ])
  })

  test("a verdict that is wrong, unknown or twice is dropped; a reason of Met is dropped", () => {
    const answer = parseCheck(
      JSON.stringify({
        verdicts: [
          { part: 0, verdict: "met" },
          { part: 1.5, verdict: "met" },
          { part: 2, verdict: "maybe" },
          { part: 3, verdict: "met", reason: "fine" },
          { part: 3, verdict: "not_met", reason: "second" },
          null,
          "text",
        ],
        action: "nothing",
      }),
    )
    expect(answer?.verdicts).toEqual([{ part: 3, verdict: "met", reason: null }])
  })

  test("a nudge may name the member instead of the part", () => {
    expect(parseCheck('{"action":"nudge","member":"Cy","instruction":"Go on"}')?.action).toEqual({
      kind: "nudge",
      part: null,
      member: "Cy",
      instruction: "Go on",
    })
  })

  test("an ask needs a question, a nudge needs an instruction and a target", () => {
    expect(parseCheck('{"action":"ask","question":"Which date?"}')?.action).toEqual({
      kind: "ask",
      question: "Which date?",
    })
    expect(parseCheck('{"action":"ask","question":"  "}')?.action).toEqual({ kind: "nothing" })
    expect(parseCheck('{"action":"nudge","part":1}')?.action).toEqual({ kind: "nothing" })
    expect(parseCheck('{"action":"nudge","instruction":"Go on"}')?.action).toEqual({
      kind: "nothing",
    })
  })

  test("a missing or unknown action is nothing; verdicts still count", () => {
    expect(parseCheck('{"verdicts":[{"part":1,"verdict":"met"}]}')).toEqual({
      verdicts: [{ part: 1, verdict: "met", reason: null }],
      action: { kind: "nothing" },
    })
    expect(parseCheck('{"action":"destroy"}')?.action).toEqual({ kind: "nothing" })
  })

  test("an answer that cannot be read is null", () => {
    for (const reply of ["", "I think it is fine.", "{broken", "[1,2]", "{}}", "null"])
      expect(parseCheck(reply), reply).toBeNull()
  })
})

describe("when the lead may nudge", () => {
  const part = { state: "done" as const, verdict: null, decidedAt: null, nudged: false }
  test("a part that ended may be nudged, also one that failed or is blocked", () => {
    for (const state of ["done", "failed", "blocked"] as const)
      expect(nudgeRefusal({ ...part, state }), state).toBeNull()
    expect(nudgeRefusal({ ...part, verdict: "not_met" })).toBeNull()
    expect(nudgeRefusal({ ...part, verdict: "met" })).toBeNull()
  })
  test("a part the user decided on or stopped, or that is open, is not nudged", () => {
    expect(nudgeRefusal({ ...part, decidedAt: 9 })).toBe("decided")
    expect(nudgeRefusal({ ...part, state: "cancelled" })).toBe("stopped")
    for (const state of ["queued", "running", "waiting", "review"] as const)
      expect(nudgeRefusal({ ...part, state }), state).toBe("open")
  })
  test("a nudged part that is still Not met is not nudged again for that reason", () => {
    expect(nudgeRefusal({ ...part, verdict: "not_met", nudged: true })).toBe("again")
    // Another reason: a nudged part that failed may be tried again.
    expect(nudgeRefusal({ ...part, state: "failed", nudged: true })).toBeNull()
  })
})

describe("the parts that stay Not met", () => {
  const p = (
    id: string,
    verdict: "met" | "not_met" | null,
    retryOf: string | null = null,
    state: "done" | "failed" = "done",
  ) => ({ id, verdict, retryOf, state })
  test("a Not met part that no later part fixed is named", () => {
    expect(stillNotMet([p("a", "met"), p("b", "not_met")])).toEqual(["b"])
  })
  test("a later part that is done and Met fixes it", () => {
    expect(stillNotMet([p("a", "met"), p("b", "not_met"), p("c", "met", "b")])).toEqual([])
  })
  test("a later part that is Not met too does not fix it; both are named", () => {
    expect(stillNotMet([p("b", "not_met"), p("c", "not_met", "b")])).toEqual(["b", "c"])
  })
  test("a later part with no verdict or a failed one does not fix it", () => {
    expect(stillNotMet([p("b", "not_met"), p("c", null, "b")])).toEqual(["b"])
    expect(stillNotMet([p("b", "not_met"), p("c", "met", "b", "failed")])).toEqual(["b"])
  })
  test("a chain: the last part fixes the ones before it", () => {
    expect(stillNotMet([p("b", "not_met"), p("c", "not_met", "b"), p("d", "met", "c")])).toEqual([])
  })
  test("no verdicts, nothing to name", () => {
    expect(stillNotMet([p("a", null), p("b", "met")])).toEqual([])
  })
})
