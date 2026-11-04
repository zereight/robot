import { describe, expect, test } from "bun:test"
import type { AgentChannelTool, ChannelToolRow } from "@robot/shared"
import { fromChannels, switchOf, toolsOfKind } from "./toolsView.ts"

// The part "Tools of this channel" and the lines "From <channel>" (spec 030).

const row = (
  over: Partial<ChannelToolRow> & Pick<ChannelToolRow, "kind" | "name">,
): ChannelToolRow => ({
  id: over.name,
  on: false,
  all: false,
  ...over,
})

describe("the rows of the part Tools of this channel", () => {
  const rows = [
    row({ kind: "skill", name: "Release notes" }),
    row({ kind: "connection", name: "Notes" }),
    row({ kind: "skill", name: "Weekly summary", on: true, all: true }),
  ]

  test("a group holds the rows of its kind, in the order of the list", () => {
    expect(toolsOfKind(rows, "skill").map((r) => r.name)).toEqual([
      "Release notes",
      "Weekly summary",
    ])
    expect(toolsOfKind(rows, "connection").map((r) => r.name)).toEqual(["Notes"])
    expect(toolsOfKind([], "skill")).toEqual([])
  })

  test("a row can change on the computer that holds the tool", () => {
    expect(switchOf(rows[0] as ChannelToolRow, false)).toEqual({ checked: false, disabled: false })
    expect(switchOf(row({ kind: "skill", name: "A", on: true }), false)).toEqual({
      checked: true,
      disabled: false,
    })
  })

  test("a tool for All agents shows on and cannot change", () => {
    expect(switchOf(rows[2] as ChannelToolRow, false)).toEqual({ checked: true, disabled: true })
  })

  test("a linked computer reads each row and changes none", () => {
    for (const r of rows) expect(switchOf(r, true).disabled).toBe(true)
    expect(switchOf(rows[2] as ChannelToolRow, true).checked).toBe(true)
    expect(switchOf(rows[0] as ChannelToolRow, true).checked).toBe(false)
  })
})

describe("the line From <channel>", () => {
  const tool = (names: string[]): AgentChannelTool => ({
    kind: "skill",
    id: "k",
    name: "Release notes",
    channels: names.map((name) => ({ id: name.toLowerCase(), name })),
  })

  test("it names the channel that gives the tool", () => {
    expect(fromChannels(tool(["Product"]))).toBe("Product")
  })

  test("a tool from more than one channel names each of them, nearest first", () => {
    expect(fromChannels(tool(["Site", "Docs", "Product"]))).toBe("Site, Docs, Product")
  })
})
