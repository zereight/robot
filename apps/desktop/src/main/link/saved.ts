import {
  allPlaces,
  type ChatMessage,
  matchesAll,
  messageText,
  type Place,
  type PlaceSection,
  pageOf,
  SEARCH_CAP,
  SEARCH_SNIPPET,
  type SearchHit,
  type SearchPage,
  searchWords,
  snippetOf,
} from "@robot/shared"
import type { LinkCache } from "./cache.ts"

/**
 * Message search on a linked server that does not answer (spec 001, "Message search"). The
 * client searches what it saved of that server: the places it listed, and the newest messages of
 * each place that the user opened while the server was online (spec 012). It uses the same
 * rule as the server, and the page says that the hits come from saved messages.
 */

interface Saved {
  readonly id: string
  readonly author: "user" | "agent"
  readonly status?: string
  readonly parts: ChatMessage["parts"]
  readonly createdAt: number
}

const isSaved = (value: unknown): value is Saved =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Saved).id === "string" &&
  typeof (value as Saved).createdAt === "number" &&
  Array.isArray((value as Saved).parts)

const field = (input: unknown, name: string) =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>)[name] : undefined

export const searchSaved = (
  cache: Pick<LinkCache, "entriesOf">,
  link: string,
  serverId: string,
  query: string,
  offset: number,
): SearchPage => {
  const none: SearchPage = { hits: [], more: false, capped: false, cached: true }
  const words = searchWords(query)
  if (!words) return none

  // The places that the server listed. An archived place is not in the list.
  const places = new Map<string, Place>()
  for (const entry of cache.entriesOf(link, "places.list")) {
    if (field(entry.input, "serverId") !== serverId || !Array.isArray(entry.value)) continue
    for (const section of entry.value as PlaceSection[])
      for (const place of allPlaces(section)) places.set(`${place.kind}:${place.id}`, place)
  }

  const matches: { place: Place; message: Saved; body: string }[] = []
  const take = (place: Place | undefined, list: unknown) => {
    if (!place || !Array.isArray(list)) return
    for (const message of list) {
      if (!isSaved(message) || message.status === "streaming") continue
      const body = messageText(message)
      if (body && matchesAll(body, words)) matches.push({ place, message, body })
    }
  }
  for (const entry of cache.entriesOf(link, "chat.history")) {
    const id = field(entry.input, "agentId")
    take(places.get(`agent:${id}`), (entry.value as { messages?: unknown } | undefined)?.messages)
  }

  matches.sort(
    (a, b) => b.message.createdAt - a.message.createdAt || (a.message.id < b.message.id ? 1 : -1),
  )
  const page = pageOf(matches.slice(0, SEARCH_CAP + 1), offset)
  const hits = page.items.map((m): SearchHit => {
    const piece = snippetOf(m.body, words, SEARCH_SNIPPET)
    return {
      kind: m.place.kind,
      placeId: m.place.id,
      placeName: m.place.name,
      messageId: m.message.id,
      createdAt: m.message.createdAt,
      author: m.message.author,
      snippet: piece.text,
      marks: piece.marks,
    }
  })
  return { hits, more: page.more, capped: page.capped, cached: true }
}
