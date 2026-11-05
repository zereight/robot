import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  CHANGE_METHODS,
  CLIENT_METHODS,
  isChangeMethod,
  isClientMethod,
  isRoutedMethod,
  type Organization as OrganizationState,
  PUSHED_EVENTS,
  type RpcResult,
} from "@robot/shared"
import { Effect } from "effect"
import { Organization } from "../services/Organization.ts"
import { Remote } from "../services/Remote.ts"
import { testRuntime } from "../services/testing.ts"
import { pairRuntimes } from "./pairing.testing.ts"

// The part "Organization" of a linked server (spec 030, 012). A client reads it with only the link
// and never changes it, with the switch "Can create and change agents" or without it.

type Rt = ReturnType<typeof testRuntime>

const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

const waitFor = async <T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40))
    last = await read()
  }
  return last
}

beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
  process.env.ROBOT_LINK_RETRY_MAX_MS = "300"
  process.env.ROBOT_LINK_NEARBY_WAIT_MS = "80"
})
afterAll(async () => {
  for (const s of sides) await s.runtime.dispose().catch(() => {})
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
  delete process.env.ROBOT_LINK_NEARBY_WAIT_MS
})

const pair = async (canChange: boolean) => {
  const server = side("MacBook 2")
  const client = side("MacBook 1")
  const { entry } = await pairRuntimes(server, client, { canChange })
  const serverId = entry.serverId
  const ask = (method: string, input: unknown): Promise<RpcResult<unknown>> =>
    client.runtime.runPromise(
      Remote.use((r) => Effect.promise(() => r.invoke(serverId, method, input))),
    )
  const read = async () => {
    const result = await ask("organization.get", { serverId })
    if (!result.ok) throw new Error(`request failed: ${result.error.code}`)
    return result.value as OrganizationState
  }
  const set = (value: "any" | "organizations") =>
    server.runtime.runPromise(Organization.use((o) => o.setHandOff(value)))
  return { server, client, serverId, ask, read, set }
}

const codeOf = (result: RpcResult<unknown>) => (result.ok ? "ok" : result.error.code)

describe('a client and the part "Organization" of a server (spec 030, 012)', () => {
  test("the read is on the list of a client and needs no switch; no change is on any list", () => {
    expect(isClientMethod("organization.get")).toBe(true)
    expect(isChangeMethod("organization.get")).toBe(false)
    expect(isRoutedMethod("organization.get")).toBe(true)
    // No request of a client changes the part, with the switch or without it.
    expect(isClientMethod("organization.setHandOff")).toBe(false)
    expect(isChangeMethod("organization.setHandOff")).toBe(false)
    expect(isRoutedMethod("organization.setHandOff")).toBe(false)
    // The same for the switch "Ask up the line" (spec 030, 013): a client reads it, never sets it.
    expect(isClientMethod("organization.setAskUpTheLine")).toBe(false)
    expect(isChangeMethod("organization.setAskUpTheLine")).toBe(false)
    expect(isRoutedMethod("organization.setAskUpTheLine")).toBe(false)
    expect(CLIENT_METHODS.filter((m) => m.startsWith("organization."))).toEqual([
      "organization.get",
    ])
    expect((CHANGE_METHODS as readonly string[]).some((m) => m.startsWith("organization."))).toBe(
      false,
    )
    expect(PUSHED_EVENTS).toContain("organization.changed")
  })

  test("a client reads the rule of the server, and a later change reaches it as a push", async () => {
    const p = await pair(false)
    expect(await p.read()).toEqual({ handOff: "any", askUpTheLine: false })
    await p.set("organizations")
    expect(await p.read()).toEqual({ handOff: "organizations", askUpTheLine: false })
    // The window of the client hears that the part changed on that server.
    const pushes = await waitFor(
      () =>
        p.client.events.filter(
          (e) => e.event === "organization.changed" && e.server === p.serverId,
        ),
      (list) => list.length > 0,
    )
    expect(pushes.length).toBeGreaterThan(0)
  })

  test("the switch makes no difference: a client with it cannot change the rule either", async () => {
    for (const canChange of [false, true]) {
      const p = await pair(canChange)
      expect(codeOf(await p.ask("organization.setHandOff", { rule: "organizations" }))).toBe(
        "not_allowed",
      )
      expect(await p.read()).toEqual({ handOff: "any", askUpTheLine: false })
      // The server still holds the rule it had.
      expect(await p.server.runtime.runPromise(Organization.use((o) => o.get))).toEqual({
        handOff: "any",
        askUpTheLine: false,
      })
    }
  })

  test("a client reads the switch 'Ask up the line' and cannot set it, with the switch or without it", async () => {
    for (const canChange of [false, true]) {
      const p = await pair(canChange)
      await p.server.runtime.runPromise(Organization.use((o) => o.setAskUpTheLine(true)))
      expect(await p.read()).toEqual({ handOff: "any", askUpTheLine: true })
      expect(codeOf(await p.ask("organization.setAskUpTheLine", { on: false }))).toBe("not_allowed")
      expect(await p.read()).toEqual({ handOff: "any", askUpTheLine: true })
    }
  })

  test("the request names this server; any other id or any other field is refused", async () => {
    const p = await pair(false)
    expect(codeOf(await p.ask("organization.get", { serverId: "another-server" }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("organization.get", { serverId: p.serverId, extra: 1 }))).toBe(
      "invalid_input",
    )
    expect(codeOf(await p.ask("organization.get", {}))).toBe("invalid_input")
  })

  test("the chart that the server sends names the rule for the legend", async () => {
    const p = await pair(false)
    // The chart is empty without an agent, and the rule still goes with it.
    await p.set("organizations")
    const model = await waitFor(
      async () => {
        const result = await p.ask("orgChart.model", { serverId: p.serverId })
        return result.ok ? (result.value as { handOffRule?: string }) : {}
      },
      (m) => m.handOffRule === "organizations",
    )
    expect(model.handOffRule).toBe("organizations")
  })
})
