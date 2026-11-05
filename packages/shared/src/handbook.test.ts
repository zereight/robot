import { describe, expect, test } from "bun:test"
import {
  CHANNEL_INSTRUCTIONS_MAX,
  channelInstructionsTooLong,
  composeInstructions,
  HANDBOOK_HISTORY_MAX,
  HANDBOOK_MAX,
  handbookTooLong,
} from "./handbook.ts"

// The handbook and the instructions of a channel (spec 002, "Handbook"; spec 004, "Rules").

describe("the limits", () => {
  test("they are the numbers of the specs", () => {
    expect(HANDBOOK_MAX).toBe(20_000)
    expect(HANDBOOK_HISTORY_MAX).toBe(20)
    expect(CHANNEL_INSTRUCTIONS_MAX).toBe(4_000)
  })

  test("a limit counts characters, not bytes, and an emoji counts once", () => {
    expect(handbookTooLong("가".repeat(HANDBOOK_MAX))).toBe(false)
    expect(handbookTooLong("가".repeat(HANDBOOK_MAX + 1))).toBe(true)
    expect(handbookTooLong("😀".repeat(HANDBOOK_MAX))).toBe(false)
    expect(channelInstructionsTooLong("가".repeat(CHANNEL_INSTRUCTIONS_MAX))).toBe(false)
    expect(channelInstructionsTooLong("x".repeat(CHANNEL_INSTRUCTIONS_MAX + 1))).toBe(true)
    expect(handbookTooLong("")).toBe(false)
  })
})

describe("the order of the texts of a turn", () => {
  test("with the own instructions only, the text is the instructions as they are", () => {
    expect(composeInstructions({ handbook: "", own: "Be brief." })).toBe("Be brief.")
    expect(composeInstructions({ handbook: "   ", own: "  Be brief.  " })).toBe("  Be brief.  ")
    expect(composeInstructions({ handbook: "", own: "" })).toBe("")
    // A channel with no instructions of its own adds nothing either.
    expect(
      composeInstructions({ handbook: "", own: "Be brief.", channel: { name: "Team", text: " " } }),
    ).toBe("Be brief.")
  })

  test("the handbook comes first, then the own instructions, and the text tells the order", () => {
    const text = composeInstructions({ handbook: "Answer in Korean.", own: "Be brief." })
    expect(text).toContain("Your instructions come in 2 texts")
    expect(text).toContain("in this order: the handbook and your own instructions")
    expect(text).toContain("the later text wins")
    expect(text).toContain("The rules of the app always win over all of them")
    expect(text.indexOf("Handbook:\nAnswer in Korean.")).toBeGreaterThanOrEqual(0)
    expect(text.indexOf("Handbook:")).toBeLessThan(
      text.indexOf("Your own instructions:\nBe brief."),
    )
  })

  test("in a channel the instructions of the channel come last, with the name of the channel", () => {
    const text = composeInstructions({
      handbook: "Answer in Korean.",
      own: "Be brief.",
      channel: { name: "Launch", text: "Write a list." },
    })
    expect(text).toContain("Your instructions come in 3 texts")
    expect(text).toContain(
      'in this order: the handbook, your own instructions and the instructions of the channel "Launch"',
    )
    const at = ["Handbook:", "Your own instructions:", 'Instructions of the channel "Launch":'].map(
      (label) => text.indexOf(label),
    )
    expect(at.every((n) => n >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(text.endsWith("Write a list.")).toBe(true)
  })

  test("a text that is empty is left out, and a lone text gets a shorter line", () => {
    const handbookOnly = composeInstructions({ handbook: "Answer in Korean.", own: "" })
    expect(handbookOnly).not.toContain("Your own instructions")
    expect(handbookOnly).not.toContain("in this order")
    expect(handbookOnly).toContain("The rules of the app always win over the text below.")
    expect(handbookOnly).toContain("Handbook:\nAnswer in Korean.")

    const channelAndOwn = composeInstructions({
      handbook: "",
      own: "Be brief.",
      channel: { name: "Team", text: "Use lists." },
    })
    expect(channelAndOwn).not.toContain("Handbook")
    expect(channelAndOwn).toContain(
      'in this order: your own instructions and the instructions of the channel "Team"',
    )

    const withoutOwn = composeInstructions({
      handbook: "Answer in Korean.",
      own: "",
      channel: { name: "Team", text: "Use lists." },
    })
    expect(withoutOwn).toContain("Your instructions come in 2 texts")
    expect(withoutOwn).toContain(
      'in this order: the handbook and the instructions of the channel "Team"',
    )
  })

  test("the texts are trimmed once, and their own lines stay as they are", () => {
    const text = composeInstructions({
      handbook: "\n  Line one\nLine two  \n",
      own: "  Be brief.\n",
    })
    expect(text).toContain("Handbook:\nLine one\nLine two\n\nYour own instructions:\nBe brief.")
  })
})

describe("the goal of an organization in a turn (spec 030, Goal)", () => {
  test("it comes after the handbook and before the own instructions, and the text tells the order", () => {
    const text = composeInstructions({
      handbook: "Answer in Korean.",
      orgs: [{ name: "Docs", text: "Ship the Docs site." }],
      own: "Be brief.",
    })
    expect(text).toContain("Your instructions come in 3 texts")
    expect(text).toContain(
      'in this order: the handbook, the goal of the organization "Docs" and your own instructions',
    )
    const at = ["Handbook:", 'Goal of the organization "Docs":', "Your own instructions:"].map(
      (label) => text.indexOf(label),
    )
    expect(at.every((n) => n >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  test("an agent of two organizations reads both goals, in the order that it gives them", () => {
    const text = composeInstructions({
      handbook: "",
      orgs: [
        { name: "Product", text: "Ship the product." },
        { name: "Docs", text: "Ship the Docs site." },
      ],
      own: "Be brief.",
    })
    expect(text.indexOf("Ship the product.")).toBeLessThan(text.indexOf("Ship the Docs site."))
  })

  test("an empty goal is left out, and a turn with goals only adds no handbook line", () => {
    const text = composeInstructions({
      handbook: "",
      orgs: [
        { name: "Docs", text: "   " },
        { name: "Ops", text: "Keep the site up." },
      ],
      own: "Be brief.",
    })
    expect(text).not.toContain('the organization "Docs"')
    expect(text).toContain('Goal of the organization "Ops":\nKeep the site up.')
    expect(text.indexOf("Handbook:")).toBe(-1)
  })

  test("with no organization the text is the same as before", () => {
    expect(composeInstructions({ handbook: "", orgs: [], own: "Be brief." })).toBe("Be brief.")
  })
})
