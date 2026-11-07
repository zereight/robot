import { describe, expect, test } from "bun:test"
import { type GraphNodeChange, type MessageKey, translate } from "@robot/shared"
import { memoryTabs, nodeDetails, showsProposals, workflowTabs } from "./improveView.ts"

const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("en", key, params)

const values = (extra: Partial<GraphNodeChange["now"]> = {}): GraphNodeChange["now"] => ({
  name: "Send",
  prompt: "",
  question: "",
  options: [],
  account: null,
  model: null,
  effort: null,
  continueOnFailure: false,
  threshold: 0.9,
  ...extra,
})

const node = (extra: Partial<GraphNodeChange>): GraphNodeChange => ({
  number: 3,
  name: "Send",
  kind: "text",
  fields: [],
  now: values(),
  was: null,
  ...extra,
})

describe("the values of a node on the card of a graph change", () => {
  test("an added node shows its prompt, account, model and effort as text", () => {
    const rows = nodeDetails(
      t,
      node({
        now: values({
          prompt: "Send it to <b>the</b> team.",
          account: "Mock",
          model: "m",
          effort: "low",
        }),
      }),
    )
    expect(rows.map((r) => [r.field, r.now, r.old])).toEqual([
      ["name", "Send", null],
      ["prompt", "Send it to <b>the</b> team.", null],
      ["account", "Mock", null],
      ["model", "m", null],
      ["effort", "low", null],
      ["continueOnFailure", "no", null],
    ])
    expect(rows.find((r) => r.field === "prompt")?.long).toBe(true)
  })

  test("a decision node shows its question, its options and its threshold", () => {
    const rows = nodeDetails(
      t,
      node({
        kind: "decision",
        now: values({ question: "Is it good?", options: ["Yes", "No"] }),
      }),
    )
    expect(rows.map((r) => r.field)).toEqual([
      "name",
      "question",
      "options",
      "continueOnFailure",
      "threshold",
    ])
    expect(rows.find((r) => r.field === "options")?.now).toBe("Yes\nNo")
  })

  test("an added decision node shows that it goes on after a failure", () => {
    const rows = nodeDetails(
      t,
      node({
        kind: "decision",
        now: values({ question: "Ok?", options: ["Yes"], continueOnFailure: true }),
      }),
    )
    expect(rows.find((r) => r.field === "continueOnFailure")?.now).toBe("yes")
  })

  test("a changed node shows only the changed fields, old and new", () => {
    const rows = nodeDetails(
      t,
      node({
        fields: ["prompt", "model"],
        was: values({ prompt: "Old.", model: "a" }),
        now: values({ prompt: "New.", model: "b" }),
      }),
    )
    expect(rows.map((r) => [r.field, r.old, r.now])).toEqual([
      ["prompt", "Old.", "New."],
      ["model", "a", "b"],
    ])
  })

  test("an empty old value reads (none)", () => {
    const rows = nodeDetails(
      t,
      node({ fields: ["effort"], was: values(), now: values({ effort: "high" }) }),
    )
    expect(rows[0]).toMatchObject({ old: "(none)", now: "high" })
  })
})

describe("a linked server does not show the proposals (spec 002, 'Surfaces')", () => {
  test("the tab Self-improvement is only on the computer that holds the proposals", () => {
    expect(workflowTabs(true)).toContain("improvement")
    expect(workflowTabs(false)).not.toContain("improvement")
    expect(workflowTabs(false)).toContain("memory")
  })

  test("the memory page of a linked server has the items and no history", () => {
    expect(memoryTabs(true)).toEqual(["items", "history"])
    expect(memoryTabs(false)).toEqual(["items"])
  })

  test("the line 'N proposals wait' and the link are for the local server only", () => {
    expect(showsProposals("local")).toBe(true)
    expect(showsProposals("linked")).toBe(false)
    expect(showsProposals(undefined)).toBe(false)
  })
})
