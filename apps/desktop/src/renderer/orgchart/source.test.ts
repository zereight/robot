import { describe, expect, test } from "bun:test"
import type { LinkState, Server } from "@robot/shared"
import { RpcFailure } from "../lib/rpc.ts"
import { NewestModel, orgSource, unsupportedByServer } from "./source.ts"

const STATES: readonly LinkState[] = [
  "connecting",
  "online",
  "reconnecting",
  "offline",
  "not_allowed",
  "update_app",
]

describe("where the chart comes from (spec 029, 012)", () => {
  test("this computer draws from its own snapshot, whatever else is true", () => {
    expect(orgSource({ kind: "local" })).toBe("local")
    // No server yet (the list is still loading) is the same as this computer.
    expect(orgSource(undefined)).toBe("local")
  })

  test("a linked server is read only while it is online; every other state of 012 is offline", () => {
    const sources = STATES.map((state) => [state, orgSource({ kind: "linked", state })] as const)
    expect(sources.filter(([, source]) => source === "linked").map(([state]) => state)).toEqual([
      "online",
    ])
    for (const [state, source] of sources) {
      if (state !== "online") expect(source).toBe("offline")
    }
  })

  test("a linked server with no state yet counts as offline, not as a chart to draw", () => {
    const server: Pick<Server, "kind" | "state"> = { kind: "linked" }
    expect(orgSource(server)).toBe("offline")
  })
})

describe("a server of an older build", () => {
  test("only 'Not allowed' means that the server does not know the request", () => {
    expect(
      unsupportedByServer(new RpcFailure({ code: "not_allowed", message: "Not allowed" })),
    ).toBe(true)
    for (const code of ["offline", "timeout", "invalid_input", "internal", "server_not_found"]) {
      expect(unsupportedByServer(new RpcFailure({ code, message: code }))).toBe(false)
    }
    expect(unsupportedByServer(new Error("not_allowed"))).toBe(false)
    expect(unsupportedByServer(undefined)).toBe(false)
  })
})

describe("the newest model of a linked server", () => {
  const make = () => {
    const shown: (string | undefined)[] = []
    const feed = new NewestModel<string>((m) => shown.push(m))
    return { shown, feed, last: () => shown.at(-1) }
  }

  test("a question clears what was shown, so the chart of another server never stays", () => {
    const { feed, shown } = make()
    feed.pushed("chart of A")
    feed.begin()
    expect(shown).toEqual(["chart of A", undefined])
  })

  test("the answer is shown", () => {
    const { feed, last } = make()
    const question = feed.begin()
    expect(feed.answered(question, "read")).toBe(true)
    expect(last()).toBe("read")
  })

  test("a push that came while the read was on its way is newer than the read", () => {
    const { feed, last } = make()
    const question = feed.begin()
    feed.pushed("pushed")
    expect(feed.answered(question, "read")).toBe(false)
    expect(last()).toBe("pushed")
  })

  test("a push after the read replaces it", () => {
    const { feed, last } = make()
    const question = feed.begin()
    feed.answered(question, "read")
    feed.pushed("pushed")
    expect(last()).toBe("pushed")
  })

  test("the answer to an earlier question is dropped", () => {
    const { feed, last } = make()
    const first = feed.begin()
    const second = feed.begin()
    expect(feed.answered(first, "old")).toBe(false)
    expect(feed.current(first)).toBe(false)
    expect(feed.current(second)).toBe(true)
    expect(last()).toBeUndefined()
    expect(feed.answered(second, "new")).toBe(true)
    expect(last()).toBe("new")
  })

  test("stop clears the chart at once, and an answer that comes later is dropped", () => {
    const { feed, last } = make()
    const question = feed.begin()
    feed.answered(question, "read")
    feed.stop()
    expect(last()).toBeUndefined()
    expect(feed.answered(question, "late")).toBe(false)
    expect(last()).toBeUndefined()
  })
})
