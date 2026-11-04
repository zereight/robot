import { describe, expect, test } from "bun:test"
import { LinkError } from "@robot/link"
import type { ChartModel } from "@robot/shared"
import { type OrgChartPhase, OrgFeed, unsupportedByServer } from "./orgChart.ts"

const model = (tag: string): ChartModel => ({
  root: null,
  channels: [],
  lines: [],
  handoffsCapped: false,
  empty: tag === "empty",
})

const feed = () => {
  const seen: OrgChartPhase[] = []
  const f = new OrgFeed((phase) => seen.push(phase))
  return { f, seen, kinds: () => seen.map((p) => p.kind) }
}

describe("the org chart feed of the phone", () => {
  test("it starts with nothing held", () => {
    const { f, seen } = feed()
    expect(f.phase).toEqual({ kind: "off" })
    expect(seen).toEqual([])
  })

  test("a question shows loading, and the answer shows the model", () => {
    const { f, kinds } = feed()
    const q = f.begin()
    expect(f.phase).toEqual({ kind: "loading" })
    const a = model("empty")
    expect(f.answered(q, a)).toBe(true)
    expect(f.phase).toEqual({ kind: "ready", model: a })
    expect(kinds()).toEqual(["loading", "ready"])
  })

  test("a push replaces the model", () => {
    const { f } = feed()
    f.answered(f.begin(), model("a"))
    const next = model("empty")
    f.pushed(next)
    expect(f.phase).toEqual({ kind: "ready", model: next })
  })

  test("a push that came before the answer is newer than the answer, so the answer is dropped", () => {
    const { f } = feed()
    const q = f.begin()
    const pushed = model("empty")
    f.pushed(pushed)
    expect(f.answered(q, model("old"))).toBe(false)
    expect(f.phase).toEqual({ kind: "ready", model: pushed })
  })

  test("an answer to an earlier question is dropped", () => {
    const { f } = feed()
    const first = f.begin()
    const second = f.begin()
    expect(f.answered(first, model("old"))).toBe(false)
    expect(f.phase).toEqual({ kind: "loading" })
    expect(f.answered(second, model("empty"))).toBe(true)
  })

  test("a new question drops the model that was shown, so no old chart stays", () => {
    const { f, kinds } = feed()
    f.answered(f.begin(), model("empty"))
    f.begin()
    expect(f.phase).toEqual({ kind: "loading" })
    expect(kinds()).toEqual(["loading", "ready", "loading"])
  })

  test("stop drops the model at once, and a late answer or push shows nothing", () => {
    const { f, seen } = feed()
    const q = f.begin()
    f.answered(q, model("empty"))
    f.stop()
    expect(f.phase).toEqual({ kind: "off" })
    const count = seen.length
    expect(f.answered(q, model("empty"))).toBe(false)
    f.pushed(model("empty"))
    expect(f.phase).toEqual({ kind: "off" })
    expect(seen).toHaveLength(count)
  })

  test("stop on a feed that holds nothing tells nobody", () => {
    const { f, seen } = feed()
    f.stop()
    expect(seen).toEqual([])
  })

  test("discard drops the model and tells nobody", () => {
    const { f, seen } = feed()
    f.answered(f.begin(), model("empty"))
    const count = seen.length
    f.discard()
    expect(f.phase).toEqual({ kind: "off" })
    expect(seen).toHaveLength(count)
  })

  test("asking again keeps the model until the answer comes, and a push still wins", () => {
    const { f, kinds } = feed()
    const first = model("a")
    f.answered(f.begin(), first)
    const q = f.again()
    // The list does not flash to "loading".
    expect(f.phase).toEqual({ kind: "ready", model: first })
    const pushed = model("empty")
    f.pushed(pushed)
    expect(f.answered(q, model("old"))).toBe(false)
    expect(f.phase).toEqual({ kind: "ready", model: pushed })
    expect(kinds()).toEqual(["loading", "ready", "ready"])
  })

  test("asking again after a failure shows loading", () => {
    const { f } = feed()
    f.failed(f.begin(), new LinkError("timeout"))
    expect(f.phase).toEqual({ kind: "failed", code: "timeout" })
    const q = f.again()
    expect(f.phase).toEqual({ kind: "loading" })
    f.answered(q, model("empty"))
    expect(f.phase.kind).toBe("ready")
  })

  test("a server that answers Not allowed is an older build: the phase is unsupported", () => {
    const { f } = feed()
    f.failed(f.begin(), new LinkError("not_allowed"))
    expect(f.phase).toEqual({ kind: "unsupported" })
  })

  test("another failure is a failure with its code, and a push replaces it", () => {
    const { f } = feed()
    f.failed(f.begin(), new LinkError("timeout"))
    expect(f.phase).toEqual({ kind: "failed", code: "timeout" })
    f.pushed(model("empty"))
    expect(f.phase.kind).toBe("ready")
    // An error with no code is an internal failure.
    const g = feed().f
    g.failed(g.begin(), new Error("boom"))
    expect(g.phase).toEqual({ kind: "failed", code: "internal" })
  })

  test("a failure of an earlier question, or after a push, is ignored", () => {
    const { f } = feed()
    const first = f.begin()
    const second = f.begin()
    f.failed(first, new LinkError("timeout"))
    expect(f.phase).toEqual({ kind: "loading" })
    f.pushed(model("empty"))
    f.failed(second, new LinkError("not_allowed"))
    expect(f.phase.kind).toBe("ready")
  })

  test("only the code Not allowed means an older server", () => {
    expect(unsupportedByServer(new LinkError("not_allowed"))).toBe(true)
    expect(unsupportedByServer(new LinkError("offline"))).toBe(false)
    expect(unsupportedByServer(new LinkError("timeout"))).toBe(false)
    expect(unsupportedByServer(new Error("not_allowed"))).toBe(false)
    expect(unsupportedByServer(null)).toBe(false)
    expect(unsupportedByServer("not_allowed")).toBe(false)
  })
})
