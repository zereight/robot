import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MESSAGE_PAGE } from "@robot/shared"
import { cacheKey, LinkCache } from "./cache.ts"

const roots: string[] = []
const make = () => {
  const root = mkdtempSync(join(tmpdir(), "robot-cache-test-"))
  roots.push(root)
  return { root, cache: new LinkCache(root) }
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const message = (id: string, createdAt: number, text = id) => ({
  id,
  agentId: "agent-1",
  createdAt,
  parts: [{ kind: "text", text }],
})

describe("the cache of a linked server", () => {
  test("a request has the same key whatever the order of its fields", () => {
    expect(cacheKey("agents.list", { serverId: "s", archived: false })).toBe(
      cacheKey("agents.list", { archived: false, serverId: "s" }),
    )
    expect(cacheKey("chat.history", { agentId: "a" })).not.toBe(
      cacheKey("chat.history", { agentId: "b" }),
    )
    expect(cacheKey("places.list", { serverId: "s", extra: undefined })).toBe(
      cacheKey("places.list", { serverId: "s" }),
    )
  })

  test("what is set is read again, also by a new copy after the files are written", () => {
    const { root, cache } = make()
    const key = cacheKey("places.list", { serverId: "s" })
    cache.set("link-1", key, [{ id: "section" }])
    expect(cache.get("link-1", key)).toEqual([{ id: "section" }])
    expect(cache.get("link-2", key)).toBeUndefined()
    cache.flush()
    const again = new LinkCache(root)
    expect(again.get("link-1", key)).toEqual([{ id: "section" }])
  })

  test("a message that came live joins a place that was opened, and not one that was not", () => {
    const { cache } = make()
    const key = cacheKey("chat.history", { agentId: "agent-1" })
    cache.set("l", key, { messages: [message("m1", 1)], queue: [] })
    cache.applyEvent("l", "chat.message", message("m2", 2))
    cache.applyEvent("l", "chat.message", { ...message("m1", 1, "changed") })
    const value = cache.get("l", key) as { messages: { id: string; parts: { text: string }[] }[] }
    expect(value.messages.map((m) => m.id)).toEqual(["m1", "m2"])
    expect(value.messages[0]?.parts[0]?.text).toBe("changed")

    // A place that was never opened has no entry, and a live message does not make one.
    cache.applyEvent("l", "chat.message", { ...message("x1", 1), agentId: "agent-2" })
    expect(cache.get("l", cacheKey("chat.history", { agentId: "agent-2" }))).toBeUndefined()

    cache.applyEvent("l", "chat.removed", { agentId: "agent-1", messageId: "m2" })
    cache.applyEvent("l", "chat.queue", { agentId: "agent-1", queue: [{ id: "q" }] })
    const after = cache.get("l", key) as { messages: { id: string }[]; queue: unknown[] }
    expect(after.messages.map((m) => m.id)).toEqual(["m1"])
    expect(after.queue).toEqual([{ id: "q" }])
  })

  test("the messages of a channel follow live messages too", () => {
    const { cache } = make()
    const key = cacheKey("channels.history", { channelId: "c1" })
    cache.set("l", key, [message("a", 1)])
    cache.applyEvent("l", "channel.message", { ...message("b", 2), channelId: "c1" })
    cache.applyEvent("l", "channel.removed", { channelId: "c1", messageId: "a" })
    expect((cache.get("l", key) as { id: string }[]).map((m) => m.id)).toEqual(["b"])
  })

  test("a place keeps the newest messages, as many as a page", () => {
    const { cache } = make()
    const key = cacheKey("chat.history", { agentId: "agent-1" })
    const many = Array.from({ length: MESSAGE_PAGE + 30 }, (_, i) => message(`m${i}`, i))
    cache.set("l", key, { messages: many, queue: [] })
    const kept = (cache.get("l", key) as { messages: { id: string }[] }).messages
    expect(kept).toHaveLength(MESSAGE_PAGE)
    expect(kept[0]?.id).toBe("m30")
    cache.applyEvent("l", "chat.message", message("last", 9999))
    const grown = (cache.get("l", key) as { messages: { id: string }[] }).messages
    expect(grown).toHaveLength(MESSAGE_PAGE)
    expect(grown.at(-1)?.id).toBe("last")
  })

  test("deleting a server removes its entries and its files, and no other", () => {
    const { root, cache } = make()
    cache.set("one", "k", { a: 1 })
    cache.set("two", "k", { b: 2 })
    cache.flush()
    expect(readdirSync(root)).toHaveLength(2)
    cache.delete("one")
    expect(cache.get("one", "k")).toBeUndefined()
    expect(cache.get("two", "k")).toEqual({ b: 2 })
    expect(readdirSync(root)).toHaveLength(1)
    // A copy made after the delete finds nothing either.
    expect(new LinkCache(root).get("one", "k")).toBeUndefined()
    expect(existsSync(root)).toBe(true)
  })

  test("a file that does not read costs one entry, not the cache", () => {
    const { root, cache } = make()
    cache.set("l", "good", { ok: true })
    cache.flush()
    const dir = join(root, readdirSync(root)[0] as string)
    writeFileSync(join(dir, "broken.json"), "{ not json")
    // biome-ignore lint/suspicious/noExplicitAny: a second copy reads the same folder
    expect(new LinkCache(root).get("l", "good")).toEqual({ ok: true } as any)
  })
})
