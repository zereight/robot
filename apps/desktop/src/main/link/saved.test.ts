import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Place, PlaceSection } from "@robot/shared"
import { SEARCH_CAP, SEARCH_PAGE } from "@robot/shared"
import { cacheKey, LinkCache } from "./cache.ts"
import { searchSaved } from "./saved.ts"

const roots: string[] = []
const make = () => {
  const root = mkdtempSync(join(tmpdir(), "robot-saved-test-"))
  roots.push(root)
  return new LinkCache(root)
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const place = (kind: "agent" | "channel", id: string, name: string): Place => ({
  kind,
  id,
  name,
  unread: 0,
  working: false,
  lastMessage: null,
  sectionId: null,
})
const message = (
  id: string,
  createdAt: number,
  text: string,
  options: { author?: "user" | "agent"; status?: string } = {},
) => ({
  id,
  createdAt,
  author: options.author ?? "user",
  status: options.status ?? "done",
  parts: [
    { kind: "tool", id: "t", name: "x", label: "toollabel", state: "done", input: "", output: "" },
    { kind: "text", text },
  ],
})

/** A server whose places were listed, and whose chats were opened. */
const saved = () => {
  const cache = make()
  const sections: PlaceSection[] = [
    { id: "channels", places: [place("channel", "c1", "launch")], sections: [] },
    {
      id: "agents",
      places: [place("agent", "a1", "Ada")],
      sections: [{ id: "u1", name: "Team", places: [place("agent", "a2", "Bo")] }],
    },
  ]
  cache.set("link", cacheKey("places.list", { serverId: "srv" }), sections)
  return cache
}
const history = (cache: LinkCache, agentId: string, messages: unknown[]) =>
  cache.set("link", cacheKey("chat.history", { agentId }), { messages, queue: [] })

describe("search in the saved messages of a linked server", () => {
  test("it finds the messages by the rule of the server, newest first, from every place", () => {
    const cache = saved()
    history(cache, "a1", [message("m1", 10, "The budget is 4200 euros"), message("m2", 30, "no")])
    history(cache, "a2", [message("m3", 20, "Euros and BUDGET again", { author: "agent" })])
    cache.set("link", cacheKey("channels.history", { channelId: "c1" }), [
      message("m4", 40, "launch budget in euros"),
    ])
    const page = searchSaved(cache, "link", "srv", "euros budget", 0)
    expect(page.cached).toBe(true)
    expect(page.hits.map((h) => h.messageId)).toEqual(["m4", "m3", "m1"])
    expect(page.hits.map((h) => [h.kind, h.placeName, h.author])).toEqual([
      ["channel", "launch", "user"],
      ["agent", "Bo", "agent"],
      ["agent", "Ada", "user"],
    ])
    expect(page.hits[2]?.marks.map(([a, b]) => page.hits[2]?.snippet.slice(a, b))).toEqual([
      "budget",
      "euros",
    ])
    expect(page.more).toBe(false)
    expect(page.capped).toBe(false)
  })

  test("it reads no tool card, no streaming reply, and no place that is not listed", () => {
    const cache = saved()
    history(cache, "a1", [
      message("m1", 10, "plain needle"),
      message("m2", 11, "streaming needle", { status: "streaming" }),
    ])
    // The server lists no place "gone" (it is archived or deleted): its messages do not match.
    history(cache, "gone", [message("m3", 12, "needle in an archived chat")])
    expect(searchSaved(cache, "link", "srv", "needle", 0).hits.map((h) => h.messageId)).toEqual([
      "m1",
    ])
    expect(searchSaved(cache, "link", "srv", "toollabel", 0).hits).toEqual([])
  })

  test("a place that was never opened has no messages to find", () => {
    const cache = saved()
    history(cache, "a1", [message("m1", 10, "needle")])
    expect(searchSaved(cache, "link", "srv", "needle", 0).hits).toHaveLength(1)
    expect(searchSaved(cache, "link", "srv", "launch needle", 0).hits).toEqual([])
  })

  test("a text of fewer than 2 characters finds nothing; a short word matches", () => {
    const cache = saved()
    history(cache, "a1", [message("m1", 10, "ok then")])
    expect(searchSaved(cache, "link", "srv", "o", 0).hits).toEqual([])
    expect(searchSaved(cache, "link", "srv", "ok", 0).hits).toHaveLength(1)
  })

  test("another server's places and another link's cache stay apart", () => {
    const cache = saved()
    history(cache, "a1", [message("m1", 10, "needle")])
    expect(searchSaved(cache, "link", "other", "needle", 0).hits).toEqual([])
    expect(searchSaved(cache, "elsewhere", "srv", "needle", 0).hits).toEqual([])
  })

  test("hits come 20 at a time, and at most 200", () => {
    const cache = saved()
    // The cache keeps the newest 200 messages of a place, so the hits come from three places.
    history(
      cache,
      "a1",
      Array.from({ length: 120 }, (_, i) => message(`a${i}`, 1000 + i, `needle ${i}`)),
    )
    history(
      cache,
      "a2",
      Array.from({ length: 120 }, (_, i) => message(`b${i}`, 2000 + i, `needle ${i}`)),
    )
    const first = searchSaved(cache, "link", "srv", "needle", 0)
    expect(first.hits).toHaveLength(SEARCH_PAGE)
    expect(first.hits[0]?.messageId).toBe("b119")
    expect(first.more).toBe(true)
    expect(first.capped).toBe(true)
    const last = searchSaved(cache, "link", "srv", "needle", SEARCH_CAP - SEARCH_PAGE)
    expect(last.hits).toHaveLength(SEARCH_PAGE)
    expect(last.more).toBe(false)
    expect(last.capped).toBe(true)
    expect(searchSaved(cache, "link", "srv", "needle", SEARCH_CAP).hits).toEqual([])
  })

  test("a cache with nothing in it gives an empty page that says it is cached", () => {
    const page = searchSaved(make(), "link", "srv", "needle", 0)
    expect(page).toEqual({ hits: [], more: false, capped: false, cached: true })
  })
})
