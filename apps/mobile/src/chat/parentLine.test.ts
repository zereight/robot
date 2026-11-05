import { describe, expect, test } from "bun:test"
import { type NamedChannel, parentChannelOf } from "./parentLine.ts"

const channel = (
  id: string,
  name: string,
  parentId: string | null,
  archived = false,
): NamedChannel => ({ id, name, parentId, archived })

describe("When the phone shows a channel", () => {
  describe("with a parent in the list", () => {
    test("should name that parent", () => {
      const channels = [channel("product", "Product", null), channel("docs", "Docs", "product")]
      expect(parentChannelOf(channels, "docs")?.name).toBe("Product")
    })
  })

  describe("with a parent that is not in the list", () => {
    test("should name no parent", () => {
      expect(parentChannelOf([channel("docs", "Docs", "gone")], "docs")).toBeNull()
    })
  })

  describe("with an archived parent", () => {
    test("should name no parent", () => {
      const channels = [
        channel("product", "Product", null, true),
        channel("docs", "Docs", "product"),
      ]
      expect(parentChannelOf(channels, "docs")).toBeNull()
    })
  })
})
