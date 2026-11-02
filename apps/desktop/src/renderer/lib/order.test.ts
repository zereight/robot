import { describe, expect, test } from "bun:test"
import { placeMessage } from "./order.ts"

const m = (id: string, createdAt: number, text = "") => ({ id, createdAt, text })

describe("order of messages", () => {
  test("a new message goes to the end when it is the newest", () => {
    const list = [m("a", 1), m("b", 2)]
    placeMessage(list, m("c", 3))
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c"])
  })

  test("a reply that arrives before its question still goes after it", () => {
    const list = [m("old", 1), m("reply", 20)]
    placeMessage(list, m("question", 10))
    expect(list.map((x) => x.id)).toEqual(["old", "question", "reply"])
  })

  test("a message made at the same time as the last one goes after it", () => {
    const list = [m("a", 5)]
    placeMessage(list, m("b", 5))
    expect(list.map((x) => x.id)).toEqual(["a", "b"])
  })

  test("a changed message keeps its place and takes the new content", () => {
    const list = [m("a", 1, "x"), m("b", 2, "y")]
    placeMessage(list, m("a", 1, "x more"))
    expect(list).toEqual([m("a", 1, "x more"), m("b", 2, "y")])
  })

  test("the oldest message goes to the start", () => {
    const list = [m("b", 2), m("c", 3)]
    placeMessage(list, m("a", 1))
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c"])
  })
})
