import { describe, expect, test } from "bun:test"
import {
  RETRO_MAX,
  RETRO_REASON_MAX,
  type RetroEvidence,
  retroProposals,
  retroRequest,
  retroWorkLines,
} from "./retro.ts"

const evidence = (extra: Partial<RetroEvidence> = {}): RetroEvidence => ({
  organization: "Docs",
  members: ["Ada", "Bo"],
  work: [
    { label: "Draft the release notes", state: "done", verdict: "met", verdictReason: null },
    {
      label: "Check the links",
      state: "done",
      verdict: "not_met",
      verdictReason: "Two links return 404.",
    },
    { label: "Publish the site", state: "blocked", verdict: null, verdictReason: null },
  ],
  ...extra,
})

describe("the request of a retrospective (spec 030, Retrospective)", () => {
  test("it names the organization, its members and the work, with the verdicts", () => {
    const text = retroRequest(evidence())
    expect(text).toContain("The organization: Docs")
    expect(text).toContain("Its members: Ada, Bo")
    expect(text).toContain("- Draft the release notes · done · verdict Met")
    expect(text).toContain("- Check the links · done · verdict Not met: Two links return 404.")
    expect(text).toContain("- Publish the site · blocked")
  })

  test("an organization with no work says so, and gives no empty list", () => {
    const text = retroRequest(evidence({ work: [] }))
    expect(text).toContain("No work ended.")
    expect(retroWorkLines(evidence({ work: [] }))).toEqual([])
  })

  test("the reason of a verdict is cut at the length of the spec", () => {
    const long = retroRequest(
      evidence({
        work: [
          {
            label: "Check",
            state: "done",
            verdict: "not_met",
            verdictReason: "x".repeat(RETRO_REASON_MAX + 50),
          },
        ],
      }),
    )
    const line = long.split("\n").find((l) => l.startsWith("- Check"))
    expect(line).toBeDefined()
    expect((line ?? "").length).toBeLessThan(RETRO_REASON_MAX + 40)
  })

  test("it hides a known secret, as every other request of the app does", () => {
    const text = retroRequest(
      evidence({
        members: ["Ada"],
        work: [{ label: "Use sk-live-123", state: "done", verdict: null, verdictReason: null }],
      }),
      ["sk-live-123"],
    )
    expect(text).not.toContain("sk-live-123")
  })

  test("it holds no message, no prompt, no thinking and no tool output: those are not inputs", () => {
    // The shape of the evidence is the guarantee: there is no field to put them in.
    const keys = Object.keys(evidence())
    expect(keys.sort()).toEqual(["members", "organization", "work"])
    const workKeys = Object.keys(evidence().work[0] as object)
    expect(workKeys.sort()).toEqual(["label", "state", "verdict", "verdictReason"])
  })
})

describe("the proposals of an answer", () => {
  test("an array of the two kinds becomes proposals, the most useful first", () => {
    const answer = JSON.stringify([
      {
        kind: "instructions",
        agent: "Ada",
        evidence: "3 of 5 parts with the verdict Not met",
        text: "Check every link before you publish.",
      },
      {
        kind: "skill",
        agent: "Bo",
        evidence: "1 blocked task",
        name: "Check the links",
        description: "Use it before a release.",
        instructions: "Open every link and report the broken ones.",
      },
    ])
    const out = retroProposals(answer)
    expect(out).toHaveLength(2)
    expect(out?.[0]).toMatchObject({ kind: "instructions", agent: "Ada" })
    expect(out?.[1]).toMatchObject({ kind: "skill", name: "Check the links" })
  })

  test("the answer may hold text around the array", () => {
    const out = retroProposals(
      'Here are the proposals:\n[{"kind":"instructions","agent":"Ada","text":"Be brief."}]\nThat is all.',
    )
    expect(out).toHaveLength(1)
  })

  test("at most three proposals come back", () => {
    const many = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        kind: "instructions",
        agent: "Ada",
        text: `Text ${i}`,
      })),
    )
    expect(retroProposals(many)).toHaveLength(RETRO_MAX)
  })

  test("an answer with no proposal gives null", () => {
    expect(retroProposals("I am not sure.")).toBeNull()
    expect(retroProposals("[]")).toBeNull()
    expect(retroProposals("[{")).toBeNull()
    // A proposal of a kind that does not exist, or without the text that its kind needs.
    expect(retroProposals('[{"kind":"other","agent":"Ada","text":"x"}]')).toBeNull()
    expect(retroProposals('[{"kind":"instructions","agent":"Ada","text":"  "}]')).toBeNull()
    expect(retroProposals('[{"kind":"skill","agent":"Ada","name":"N"}]')).toBeNull()
    expect(retroProposals('[{"kind":"instructions","text":"x"}]')).toBeNull()
  })
})
