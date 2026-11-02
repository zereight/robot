import { describe, expect, test } from "bun:test"
import { type IslandState, islandShape, isMuted, mentionsUser, muteUntil } from "./notifications.ts"

describe("mutes", () => {
  const now = 1_000_000
  test("durations", () => {
    expect(muteUntil("1h", now)).toBe(now + 3_600_000)
    expect(muteUntil("8h", now)).toBe(now + 8 * 3_600_000)
    expect(muteUntil("1d", now)).toBe(now + 86_400_000)
    expect(muteUntil("forever", now)).toBeNull()
    expect(muteUntil("off", now)).toBeUndefined()
  })
  test("a server or a channel mute applies until it ends", () => {
    const mutes = [
      { kind: "channel", id: "c1", until: now + 10 },
      { kind: "server", id: "s2", until: null },
    ] as const
    expect(isMuted(mutes, "s1", "c1", now)).toBe(true)
    expect(isMuted(mutes, "s1", "c1", now + 11)).toBe(false)
    expect(isMuted(mutes, "s1", "c2", now)).toBe(false)
    expect(isMuted(mutes, "s1", null, now)).toBe(false)
    expect(isMuted(mutes, "s2", "c9", now + 1e9)).toBe(true)
  })
})

test("island shape follows the mode and attention", () => {
  const base: IslandState = { mode: "always", working: [], count: 0, attention: null }
  const attention = {
    agentId: "a",
    agent: { id: "a", name: "Ada", face: { shape: 0, hue: 0 } },
    callId: "c",
    kind: "approval",
    summary: "rm x",
    target: { kind: "agent", id: "a" },
    always: true,
  } as const
  expect(islandShape(base)).toBe("bar")
  expect(islandShape({ ...base, mode: "attention" })).toBe("hidden")
  expect(islandShape({ ...base, mode: "attention", attention })).toBe("attention")
  expect(islandShape({ ...base, mode: "off", attention })).toBe("hidden")
})

test("mentions of the user", () => {
  expect(mentionsUser("Hi @you, done")).toBe(true)
  expect(mentionsUser("@User please check")).toBe(true)
  expect(mentionsUser("mail me@you.com")).toBe(false)
  expect(mentionsUser("@Bo go")).toBe(false)
})
