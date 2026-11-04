import {
  type ChatMessage,
  messageText,
  type Place,
  type PlaceKind,
  type PlaceSection,
  type UserSection,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Database } from "./Database.ts"
import { Sections } from "./Sections.ts"

export interface PlacesService {
  list(serverId: string): Effect.Effect<readonly PlaceSection[]>
}

const LAST_MESSAGE_MAX = 140

/**
 * Puts places in their sections. A place with no section, or with a section that is not in the
 * list, goes to the built-in part. The order inside each part does not change.
 */
const group = (
  id: PlaceSection["id"],
  kind: PlaceKind,
  places: readonly Place[],
  userSections: readonly UserSection[],
): PlaceSection => {
  const mine = userSections.filter((s) => s.kind === kind).sort((a, b) => a.position - b.position)
  const known = new Set(mine.map((s) => s.id))
  return {
    id,
    places: places.filter((p) => p.sectionId === null || !known.has(p.sectionId)),
    sections: mine.map((s) => ({
      id: s.id,
      name: s.name,
      places: places.filter((p) => p.sectionId === s.id),
    })),
  }
}

/** Builds the place list of a server: channels, then direct chats with agents. */
export class Places extends Context.Service<Places, PlacesService>()("robot/main/Places") {
  static readonly layer = Layer.effect(
    Places,
    Effect.gen(function* () {
      const agents = yield* Agents
      const db = yield* Database
      const channels = yield* Channels
      const sections = yield* Sections

      const lastMessage = (agentId: string) => {
        const row = db.get<{ parts: string }>(
          // The muted line and the card of a handover are no news for the preview (spec 003).
          `SELECT parts FROM message WHERE agent_id = ?
             AND parts NOT LIKE '%"note":"handed_over"%' AND parts NOT LIKE '%"kind":"handover"%'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          agentId,
        )
        if (!row) return null
        const text = messageText({ parts: JSON.parse(row.parts) as ChatMessage["parts"] })
          .replace(/\s+/g, " ")
          .trim()
        return text ? text.slice(0, LAST_MESSAGE_MAX) : null
      }
      const unread = (agentId: string) =>
        db.get<{ n: number }>(
          // Each thread keeps its own count (spec 003). The place shows the sum of them. The line
          // "Compacted" is no news.
          `SELECT COUNT(*) AS n FROM message m JOIN agent a ON a.id = m.agent_id
           LEFT JOIN thread_read r ON r.thread_id = m.thread_id
           WHERE m.agent_id = ? AND m.author = 'agent'
             AND m.finished_at > CASE WHEN m.thread_id IS NULL THEN a.last_read_at ELSE COALESCE(r.at, 0) END
             AND m.parts NOT LIKE '%"kind":"compacted"%'`,
          agentId,
        )?.n ?? 0

      return Places.of({
        list: (serverId) =>
          Effect.all([
            agents.list(serverId, false),
            channels.list(serverId),
            sections.list(serverId),
          ]).pipe(
            Effect.map(([list, channelList, userSections]): PlaceSection[] => [
              group(
                "channels",
                "channel",
                channelList.map(
                  (c): Place => ({
                    kind: "channel",
                    id: c.id,
                    name: c.name,
                    unread: c.unread,
                    working: c.working,
                    lastMessage: channels.lastMessage(c.id),
                    sectionId: c.sectionId,
                  }),
                ),
                userSections,
              ),
              group(
                "agents",
                "agent",
                list.map(
                  (a): Place => ({
                    kind: "agent",
                    id: a.id,
                    name: a.name,
                    unread: unread(a.id),
                    working: a.state === "working",
                    lastMessage: lastMessage(a.id),
                    sectionId: a.sectionId,
                    // The role line goes with the place, so a row, a linked computer and the phone
                    // show the badge from one answer (spec 001, 012). An agent with none sends none.
                    ...(a.role.trim() ? { role: a.role.trim() } : {}),
                  }),
                ),
                userSections,
              ),
            ]),
          ),
      })
    }),
  )
}
