import { describe, expect, test } from "bun:test"
import {
  composeInstructions,
  HANDBOOK_HISTORY_MAX,
  HANDBOOK_MAX,
  handbookTooLong,
} from "./handbook.ts"

// The handbook and the instructions of an agent (spec 002, "Handbook").

describe("the limits", () => {
  test("they are the numbers of the specs", () => {
    expect(HANDBOOK_MAX).toBe(20_000)
    expect(HANDBOOK_HISTORY_MAX).toBe(20)
  })

  test("a limit counts characters, not bytes, and an emoji counts once", () => {
    expect(handbookTooLong("가".repeat(HANDBOOK_MAX))).toBe(false)
    expect(handbookTooLong("가".repeat(HANDBOOK_MAX + 1))).toBe(true)
    expect(handbookTooLong("😀".repeat(HANDBOOK_MAX))).toBe(false)
    expect(handbookTooLong("")).toBe(false)
  })
})

describe("the order of the texts of a turn", () => {
  test("with the own instructions only, the text is the instructions as they are", () => {
    expect(composeInstructions({ handbook: "", own: "Be brief." })).toBe("Be brief.")
    expect(composeInstructions({ handbook: "   ", own: "  Be brief.  " })).toBe("  Be brief.  ")
    expect(composeInstructions({ handbook: "", own: "" })).toBe("")
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

  test("a text that is empty is left out, and a lone text gets a shorter line", () => {
    const handbookOnly = composeInstructions({ handbook: "Answer in Korean.", own: "" })
    expect(handbookOnly).not.toContain("Your own instructions")
    expect(handbookOnly).not.toContain("in this order")
    expect(handbookOnly).toContain("The rules of the app always win over the text below.")
    expect(handbookOnly).toContain("Handbook:\nAnswer in Korean.")
  })

  test("the texts are trimmed once, and their own lines stay as they are", () => {
    const text = composeInstructions({
      handbook: "\n  Line one\nLine two  \n",
      own: "  Be brief.\n",
    })
    expect(text).toContain("Handbook:\nLine one\nLine two\n\nYour own instructions:\nBe brief.")
  })
})
