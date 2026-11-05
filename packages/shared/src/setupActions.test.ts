import { describe, expect, test } from "bun:test"
import {
  parseSetupFile,
  SETUP_ACTIONS_MAX,
  SETUP_COMMAND_MAX,
  SETUP_NAME_MAX,
  setupCanon,
} from "./setupActions.ts"

const action = (extra: Record<string, unknown> = {}) => ({
  name: "Copy .npmrc and configurations/env",
  command: 'cp "$ROBOT_ORIGIN/.npmrc" .npmrc',
  ...extra,
})

describe("When robot.json lists setup actions", () => {
  describe("with one action", () => {
    test("should keep the name, the command and the marks that are absent", () => {
      const file = parseSetupFile(JSON.stringify({ setupActions: [action()] }))
      expect(file).toEqual({
        ok: true,
        actions: [
          {
            name: "Copy .npmrc and configurations/env",
            command: 'cp "$ROBOT_ORIGIN/.npmrc" .npmrc',
            onOwnCopy: false,
            onTurnStart: false,
          },
        ],
      })
    })
  })

  describe("with both marks on", () => {
    test("should keep both marks", () => {
      const file = parseSetupFile(
        JSON.stringify({ setupActions: [action({ onOwnCopy: true, onTurnStart: true })] }),
      )
      expect(file.ok).toBe(true)
      if (!file.ok) return
      expect(file.actions[0]?.onOwnCopy).toBe(true)
      expect(file.actions[0]?.onTurnStart).toBe(true)
    })
  })

  describe("with no setupActions field", () => {
    test("should be an empty list", () => {
      expect(parseSetupFile("{}")).toEqual({ ok: true, actions: [] })
    })
  })

  describe("with a bad item", () => {
    test("should ignore that item and keep the others", () => {
      const file = parseSetupFile(
        JSON.stringify({
          setupActions: [
            { name: "  ", command: "true" },
            { name: "Ok", command: "true", onOwnCopy: "yes" },
            { name: "Keep", command: " true " },
            { command: "true" },
          ],
        }),
      )
      expect(file).toEqual({
        ok: true,
        actions: [{ name: "Keep", command: "true", onOwnCopy: false, onTurnStart: false }],
      })
    })
  })

  describe("with more than 20 actions", () => {
    test("should keep the first 20", () => {
      const many = Array.from({ length: SETUP_ACTIONS_MAX + 3 }, (_, i) =>
        action({ name: `Action ${i}`, command: "true" }),
      )
      const file = parseSetupFile(JSON.stringify({ setupActions: many }))
      expect(file.ok).toBe(true)
      if (!file.ok) return
      expect(file.actions).toHaveLength(SETUP_ACTIONS_MAX)
      expect(file.actions[0]?.name).toBe("Action 0")
      expect(file.actions[19]?.name).toBe("Action 19")
    })
  })

  describe("with a name or a command that is too long", () => {
    test("should ignore that action", () => {
      const file = parseSetupFile(
        JSON.stringify({
          setupActions: [
            action({ name: "n".repeat(SETUP_NAME_MAX + 1) }),
            action({ name: "Long command", command: "c".repeat(SETUP_COMMAND_MAX + 1) }),
          ],
        }),
      )
      expect(file).toEqual({ ok: true, actions: [] })
    })
  })
})

describe("When robot.json is not a setup list", () => {
  describe("with text that is not JSON", () => {
    test("should be unreadable", () => {
      expect(parseSetupFile("{")).toEqual({ ok: false })
    })
  })

  describe("with a list at the root", () => {
    test("should be unreadable", () => {
      expect(parseSetupFile("[]")).toEqual({ ok: false })
    })
  })

  describe("with setupActions that is not a list", () => {
    test("should be unreadable", () => {
      expect(parseSetupFile('{"setupActions":{}}')).toEqual({ ok: false })
    })
  })
})

describe("When two lists are compared", () => {
  describe("with the same actions in the same order", () => {
    test("should follow one text", () => {
      const first = parseSetupFile(JSON.stringify({ setupActions: [action({ onOwnCopy: true })] }))
      const second = parseSetupFile(
        JSON.stringify({ other: 1, setupActions: [action({ onOwnCopy: true })] }),
      )
      if (!first.ok || !second.ok) throw new Error("parsed")
      expect(setupCanon(first.actions)).toBe(setupCanon(second.actions))
    })
  })

  describe("with a changed command", () => {
    test("should follow a different text", () => {
      const first = parseSetupFile(JSON.stringify({ setupActions: [action()] }))
      const second = parseSetupFile(JSON.stringify({ setupActions: [action({ command: "true" })] }))
      if (!first.ok || !second.ok) throw new Error("parsed")
      expect(setupCanon(first.actions)).not.toBe(setupCanon(second.actions))
    })
  })
})
