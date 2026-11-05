import { describe, expect, test } from "bun:test"
import type { LinkState } from "@robot/link"
import type { OrgChartPhase } from "@robot/phone"
import {
  type AgentState,
  buildChart,
  type ChartModel,
  type OrgAgent,
  type OrgSnapshot,
} from "@robot/shared"
import { orgScreen } from "./screen.ts"

const agent = (id: string, state: AgentState = "idle"): OrgAgent => ({
  id,
  name: id,
  role: "",
  face: { shape: 0, hue: 0 },
  state,
  task: null,
})
const model = (snapshot: Partial<OrgSnapshot> = {}): ChartModel =>
  buildChart({ mainAgentId: null, agents: [], orgs: [], handoffs: [], ...snapshot })
const withAgent = model({ agents: [agent("Ada")] })

const STATES: readonly LinkState[] = [
  "connecting",
  "online",
  "reconnecting",
  "offline",
  "not_allowed",
  "update_app",
]

describe("what the screen Org chart shows", () => {
  test("a server in any state other than online shows the offline line and no list", () => {
    const phases: OrgChartPhase[] = [
      { kind: "off" },
      { kind: "loading" },
      { kind: "ready", model: withAgent },
      { kind: "ready", model: model() },
      { kind: "unsupported" },
      { kind: "failed", code: "timeout" },
    ]
    for (const state of STATES) {
      if (state === "online") continue
      for (const phase of phases) expect(orgScreen(state, phase)).toEqual({ kind: "offline" })
    }
  })

  test("an online server with a model shows the list", () => {
    const screen = orgScreen("online", { kind: "ready", model: withAgent })
    expect(screen.kind).toBe("list")
    if (screen.kind === "list")
      expect(screen.list.blocks[0]?.rows.map((r) => r.name)).toEqual(["Ada"])
  })

  test("an online server with no agent shows the empty line, not a list", () => {
    expect(orgScreen("online", { kind: "ready", model: model() })).toEqual({ kind: "empty" })
  })

  test("an online server whose model is on its way shows loading, also before the feed began", () => {
    expect(orgScreen("online", { kind: "loading" })).toEqual({ kind: "loading" })
    expect(orgScreen("online", { kind: "off" })).toEqual({ kind: "loading" })
  })

  test("an older server shows the line to open it on the computer", () => {
    expect(orgScreen("online", { kind: "unsupported" })).toEqual({ kind: "unsupported" })
  })

  test("a failed read shows its code", () => {
    expect(orgScreen("online", { kind: "failed", code: "timeout" })).toEqual({
      kind: "failed",
      code: "timeout",
    })
  })

  test("when the server comes back, the screen shows the list again from the new model", () => {
    const old = model({ agents: [agent("Ada")] })
    const fresh = model({ agents: [agent("Ada"), agent("Bo")] })
    expect(orgScreen("reconnecting", { kind: "ready", model: old })).toEqual({ kind: "offline" })
    const again = orgScreen("online", { kind: "ready", model: fresh })
    expect(again.kind === "list" ? again.list.blocks[0]?.rows.map((r) => r.name) : null).toEqual([
      "Ada",
      "Bo",
    ])
  })
})
