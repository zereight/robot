import { describe, expect, test } from "bun:test"
import { workingLineKey } from "./followUp.ts"

describe("When the working line is chosen", () => {
  describe("with a follow-up turn", () => {
    test("should say that the agent looks again", () => {
      expect(workingLineKey({ compacting: false, quiet: false, followUp: true })).toBe(
        "chat.working.followUp",
      )
    })
  })

  describe("with a quiet follow-up", () => {
    test("should keep the quiet line", () => {
      expect(workingLineKey({ compacting: false, quiet: true, followUp: true })).toBe("quiet.line")
    })
  })

  describe("with a compact during a follow-up", () => {
    test("should keep the compact line", () => {
      expect(workingLineKey({ compacting: true, quiet: false, followUp: true })).toBe(
        "chat.compacting",
      )
    })
  })

  describe("with an ordinary turn", () => {
    test("should say that the agent is working", () => {
      expect(workingLineKey({ compacting: false, quiet: false, followUp: false })).toBe(
        "chat.working",
      )
    })
  })
})
