import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MESSAGE_PAGE } from "@robot/shared"

/**
 * What a client remembers of a linked server: the answers to reads, and the messages that came
 * live. It shows when the server is offline. The files live in their own folder, apart from the
 * database, so an export never holds them. The folder of a server goes when its link ends.
 */

interface Entry {
  readonly key: string
  value: unknown
}

const nameOf = (key: string) =>
  `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`

/** A stable text for a request: object keys in order. */
export const cacheKey = (method: string, input: unknown): string => {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, sort(v)]),
          )
        : value
  return `${method}:${JSON.stringify(sort(input ?? null))}`
}

interface Message {
  readonly id: string
  readonly createdAt: number
}

const newest = <T extends Message>(list: readonly T[]) =>
  list.length > MESSAGE_PAGE ? list.slice(list.length - MESSAGE_PAGE) : list

const upsert = <T extends Message>(list: readonly T[], message: T) => {
  const at = list.findIndex((m) => m.id === message.id)
  if (at >= 0) return list.map((m, i) => (i === at ? message : m))
  return newest([...list, message].sort((a, b) => a.createdAt - b.createdAt))
}

export class LinkCache {
  readonly #root: string
  /** In memory, by link. A link loads from its folder the first time it is used. */
  readonly #memory = new Map<string, Map<string, Entry>>()
  readonly #dirty = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(root: string) {
    this.#root = root
    mkdirSync(root, { recursive: true })
  }

  #dir(link: string) {
    return join(this.#root, createHash("sha256").update(link).digest("hex").slice(0, 32))
  }

  #load(link: string): Map<string, Entry> {
    const known = this.#memory.get(link)
    if (known) return known
    const entries = new Map<string, Entry>()
    try {
      for (const file of readdirSync(this.#dir(link))) {
        if (!file.endsWith(".json")) continue
        try {
          const entry = JSON.parse(readFileSync(join(this.#dir(link), file), "utf8")) as Entry
          if (typeof entry.key === "string") entries.set(entry.key, entry)
        } catch {
          // A file that does not read is a lost cache entry, no more.
        }
      }
    } catch {
      // No folder yet.
    }
    this.#memory.set(link, entries)
    return entries
  }

  get(link: string, key: string): unknown {
    return this.#load(link).get(key)?.value
  }

  set(link: string, key: string, value: unknown) {
    const entries = this.#load(link)
    entries.set(key, { key, value: this.#bounded(key, value) })
    this.#mark(link, key)
  }

  /** Keeps the newest messages of a place, as many as a page. */
  #bounded(key: string, value: unknown) {
    if (key.startsWith("chat.history:") && value && typeof value === "object") {
      const { messages, queue } = value as { messages: readonly Message[]; queue: unknown }
      return { messages: newest(messages ?? []), queue }
    }
    if (key.startsWith("channels.history:") && Array.isArray(value))
      return newest(value as Message[])
    return value
  }

  #mark(link: string, key: string) {
    this.#dirty.add(`${link}\u0000${key}`)
    this.#timer ??= setTimeout(() => this.flush(), 400)
  }

  /** Changes an entry that exists. A place that was never opened has none, and stays so. */
  #change(link: string, key: string, change: (value: unknown) => unknown) {
    const entry = this.#load(link).get(key)
    if (!entry) return
    entry.value = this.#bounded(key, change(entry.value))
    this.#mark(link, key)
  }

  /** Applies an event that the server pushed, so the cache holds what the window saw live. */
  applyEvent(link: string, event: string, payload: unknown) {
    const p = payload as Record<string, unknown>
    if (event === "chat.message") {
      this.#change(link, cacheKey("chat.history", { agentId: p.agentId }), (old) => {
        const o = old as { messages: Message[]; queue: unknown }
        return { ...o, messages: upsert(o.messages, payload as Message) }
      })
    } else if (event === "chat.removed") {
      this.#change(link, cacheKey("chat.history", { agentId: p.agentId }), (old) => {
        const o = old as { messages: Message[]; queue: unknown }
        return { ...o, messages: o.messages.filter((m) => m.id !== p.messageId) }
      })
    } else if (event === "chat.queue") {
      this.#change(link, cacheKey("chat.history", { agentId: p.agentId }), (old) => ({
        ...(old as object),
        queue: p.queue,
        hold: p.hold ?? null,
      }))
    } else if (event === "channel.message") {
      this.#change(link, cacheKey("channels.history", { channelId: p.channelId }), (old) =>
        upsert(old as Message[], payload as Message),
      )
    } else if (event === "channel.removed") {
      this.#change(link, cacheKey("channels.history", { channelId: p.channelId }), (old) =>
        (old as Message[]).filter((m) => m.id !== p.messageId),
      )
    }
  }

  /** Writes what changed. */
  flush() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const todo = [...this.#dirty]
    this.#dirty.clear()
    for (const id of todo) {
      const [link = "", key = ""] = id.split("\u0000")
      const entry = this.#memory.get(link)?.get(key)
      if (!entry) continue
      try {
        mkdirSync(this.#dir(link), { recursive: true })
        const path = join(this.#dir(link), nameOf(key))
        writeFileSync(`${path}.tmp`, JSON.stringify(entry))
        renameSync(`${path}.tmp`, path)
      } catch {
        // A cache that cannot be written is no reason to fail a request.
      }
    }
  }

  /** Deletes everything of one server: in memory and on disk. */
  delete(link: string) {
    this.#memory.delete(link)
    for (const id of [...this.#dirty]) if (id.startsWith(`${link}\u0000`)) this.#dirty.delete(id)
    rmSync(this.#dir(link), { recursive: true, force: true })
  }

  has(link: string) {
    return this.#load(link).size > 0
  }
}
