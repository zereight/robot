import {
  charLength,
  matchesAll,
  type OutsideSource,
  pageOf,
  parseOutsideSource,
  SEARCH_CAP,
  SEARCH_SNIPPET,
  type SearchHit,
  type SearchPage,
  searchWords,
  snippetOf,
  TOOL_SEARCH_HITS,
  TOOL_SEARCH_SNIPPET,
  type ToolHit,
  toolSearchOutput,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database, type DatabaseService } from "./Database.ts"

/**
 * Message search (spec 001) and the tool "search chats" (spec 007). The text of the sent messages
 * is in the table `message_text`, which triggers keep in step with the message tables, and the
 * index `message_fts` finds a part of a word in it, with no regard for case. A word of fewer than
 * 3 characters is not in that index; the rows are read and checked here instead.
 */

export interface SearchService {
  /**
   * One page of the hits for the window: the messages of the chats of one server,
   * newest first, 20 at a time, at most 200 in all. Archived chats are left out. With `mainOnly`
   * (a linked device), messages of threads other than the main thread are left out (spec 003).
   */
  page(
    serverId: string,
    query: string,
    offset: number,
    mainOnly?: boolean,
  ): Effect.Effect<SearchPage>
  /**
   * The answer of the tool "search chats" for one agent: its own chats. `failed` is true when the
   * words are too short to search.
   */
  forAgent(
    agentId: string,
    query: string,
  ): {
    readonly output: string
    readonly failed: boolean
    /**
     * The first source of a turn that holds the program mark, when a hit is a message of an
     * outside program, of Teams, or of such a turn (spec 007, "Program mark"). Else null.
     */
    readonly program: OutsideSource | null
    /**
     * The first source of outside content, when a hit is a message that the user did not write
     * (spec 007, "Outside content"): the agent that wrote it. Else null. A hit that holds the
     * program mark gives the program mark as well (`program`).
     */
    readonly outside: OutsideSource | null
  }
}

type Scope =
  | { readonly kind: "server"; readonly serverId: string; readonly mainOnly?: boolean }
  | { readonly kind: "agent"; readonly agentId: string }

/** A matching message, as the index knows it. */
interface Found {
  readonly n: number
  readonly message_id: string
  readonly place_id: string
  readonly created_at: number
  readonly body?: string
}

/** Rows that are read and checked in one step, when a word is too short for the index. */
const BATCH = 500

/** A word of the index query. The quotes make it one phrase, whatever characters it holds. */
const phrase = (word: string) => `"${word.replaceAll('"', '""')}"`

const scopeSql = (scope: Scope): { sql: string; params: string[] } =>
  scope.kind === "server"
    ? {
        sql: `(t.kind = 'chat' AND a.server_id = ? AND a.archived_at IS NULL${
          scope.mainOnly
            ? " AND (SELECT m.thread_id FROM message m WHERE m.id = t.message_id) IS NULL"
            : ""
        })`,
        params: [scope.serverId],
      }
    : {
        sql: "(t.kind = 'chat' AND t.place_id = ? AND a.archived_at IS NULL)",
        params: [scope.agentId],
      }

/** The newest `limit` messages that hold every word, newest first. */
const find = (
  db: DatabaseService,
  scope: Scope,
  words: readonly string[],
  limit: number,
): Found[] => {
  const indexed = words.filter((w) => charLength(w) >= 3)
  const short = words.filter((w) => charLength(w) < 3)
  const where = scopeSql(scope)
  const sql = (keyset: boolean) => `
    SELECT t.n AS n, t.message_id AS message_id, t.place_id AS place_id,
      t.created_at AS created_at${short.length > 0 ? ", t.body AS body" : ""}
    FROM ${indexed.length > 0 ? "message_fts JOIN message_text t ON t.n = message_fts.rowid" : "message_text t"}
    LEFT JOIN agent a ON t.kind = 'chat' AND a.id = t.place_id
    WHERE ${indexed.length > 0 ? "message_fts MATCH ? AND" : ""} ${where.sql}
    ${keyset ? "AND (t.created_at < ? OR (t.created_at = ? AND t.n < ?))" : ""}
    ORDER BY t.created_at DESC, t.n DESC
    LIMIT ?`
  const base = [...(indexed.length > 0 ? [indexed.map(phrase).join(" AND ")] : []), ...where.params]

  // Every word is in the index: the index answers, and nothing needs a second look.
  if (short.length === 0) return db.all<Found>(sql(false), ...base, limit)

  // A short word: read the candidates in steps, newest first, and keep those that hold it.
  const found: Found[] = []
  let after: Found | undefined
  while (found.length < limit) {
    const rows = after
      ? db.all<Found>(sql(true), ...base, after.created_at, after.created_at, after.n, BATCH)
      : db.all<Found>(sql(false), ...base, BATCH)
    for (const row of rows) {
      if (found.length < limit && matchesAll(row.body ?? "", short)) found.push(row)
    }
    if (rows.length < BATCH) break
    after = rows.at(-1)
  }
  return found
}

const bodyOf = (db: DatabaseService, found: Found) =>
  found.body ??
  db.get<{ body: string }>("SELECT body FROM message_text WHERE n = ?", found.n)?.body ??
  ""

export class Search extends Context.Service<Search, SearchService>()("robot/main/Search") {
  static readonly layer = Layer.effect(
    Search,
    Effect.gen(function* () {
      const db = yield* Database

      const nameOf = (id: string) =>
        db.get<{ name: string }>("SELECT name FROM agent WHERE id = ?", id)?.name ?? ""

      /** Who wrote a message: the user, or the agent of the chat. */
      const writer = (found: Found): { author: "user" | "agent"; agent: string } => {
        const row = db.get<{ author: string }>(
          "SELECT author FROM message WHERE id = ?",
          found.message_id,
        )
        return row?.author === "user"
          ? { author: "user", agent: "" }
          : { author: "agent", agent: nameOf(found.place_id) }
      }

      /** The thread of a hit, when it is not the main thread (spec 003). */
      const threadOf = (found: Found) =>
        db.get<{ thread_id: string | null }>(
          "SELECT thread_id FROM message WHERE id = ?",
          found.message_id,
        )?.thread_id ?? null

      /** The program mark of a hit: the first source of its turn, or null. */
      const programOf = (found: Found): OutsideSource | null =>
        parseOutsideSource(
          db.get<{ program_mark: string | null }>(
            "SELECT program_mark FROM message WHERE id = ?",
            found.message_id,
          )?.program_mark,
        )

      return Search.of({
        page: (serverId, query, offset, mainOnly = false) =>
          Effect.sync(() => {
            const words = searchWords(query)
            if (!words) return { hits: [], more: false, capped: false, cached: false }
            const found = find(db, { kind: "server", serverId, mainOnly }, words, SEARCH_CAP + 1)
            const page = pageOf(found, offset)
            const hits = page.items.map((f): SearchHit => {
              const piece = snippetOf(bodyOf(db, f), words, SEARCH_SNIPPET)
              return {
                kind: "agent",
                placeId: f.place_id,
                placeName: nameOf(f.place_id),
                messageId: f.message_id,
                ...(threadOf(f) ? { threadId: threadOf(f) as string } : {}),
                createdAt: f.created_at,
                author: writer(f).author,
                snippet: piece.text,
                marks: piece.marks,
              }
            })
            return { hits, more: page.more, capped: page.capped, cached: false }
          }),
        forAgent: (agentId, query) => {
          const words = searchWords(query)
          if (!words) {
            return {
              output: "Give at least 2 characters to search for.",
              failed: true,
              program: null,
              outside: null,
            }
          }
          const found = find(db, { kind: "agent", agentId }, words, TOOL_SEARCH_HITS)
          const program = found.map(programOf).find((source) => source !== null) ?? null
          // A message that the user did not write can hold text that came from outside, so a hit
          // on one is outside content (spec 007, "Outside content").
          const other = found.map(writer).find((w) => w.author !== "user")
          const outside: OutsideSource | null = other ? { kind: "agent", name: other.agent } : null
          const hits = found.map((f): ToolHit => {
            const who = writer(f)
            return {
              place: nameOf(f.place_id),
              kind: "agent",
              createdAt: f.created_at,
              who: who.agent,
              isUser: who.author === "user",
              text: snippetOf(bodyOf(db, f), words, TOOL_SEARCH_SNIPPET).text,
            }
          })
          return { output: toolSearchOutput(hits), failed: false, program, outside }
        },
      })
    }),
  )
}
