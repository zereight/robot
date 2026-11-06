import {
  type ChatMessage,
  messageText,
  orderByPosition,
  type Place,
  type PlaceKind,
  type PlaceSection,
  type UserSection,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { Sections } from "./Sections.ts"

export interface PlacesService {
  list(serverId: string): Effect.Effect<readonly PlaceSection[]>
}

const LAST_MESSAGE_MAX = 140

/** The spot that the user set for a place, and whether it is pinned. Both are the layout. */
interface Layout {
  readonly position: number | null
  readonly pinned: boolean
}
type Layouts = ReadonlyMap<string, Layout>

const layoutKey = (kind: PlaceKind, id: string) => `${kind}:${id}`

/**
 * Puts places in their sections. A place with no section, or with a section that is not in the
 * list, goes to the built-in part. Inside each part the places that the user ordered come first, in
 * their order, then the others in the order that they came in (by name).
 */
const group = (
  id: PlaceSection["id"],
  kind: PlaceKind,
  places: readonly Place[],
  userSections: readonly UserSection[],
  layouts: Layouts,
): PlaceSection => {
  const mine = userSections.filter((s) => s.kind === kind).sort((a, b) => a.position - b.position)
  const known = new Set(mine.map((s) => s.id))
  const ordered = (list: readonly Place[]) =>
    orderByPosition(list, (p) => layouts.get(layoutKey(p.kind, p.id))?.position)
  return {
    id,
    places: ordered(places.filter((p) => p.sectionId === null || !known.has(p.sectionId))),
    sections: mine.map((s) => ({
      id: s.id,
      name: s.name,
      places: ordered(places.filter((p) => p.sectionId === s.id)),
    })),
  }
}

/** Marks the pinned places with their spot in the group "Pinned". */
const withPinRanks = (sections: PlaceSection[], layouts: Layouts): PlaceSection[] => {
  const pinned = sections
    .flatMap((s) => [s.places, ...s.sections.map((u) => u.places)].flat())
    .filter((p) => layouts.get(layoutKey(p.kind, p.id))?.pinned)
  const ranked = orderByPosition(pinned, (p) => layouts.get(layoutKey(p.kind, p.id))?.position)
  const rank = new Map(ranked.map((p, index) => [layoutKey(p.kind, p.id), index]))
  const mark = (p: Place): Place => {
    const at = rank.get(layoutKey(p.kind, p.id))
    return at === undefined ? p : { ...p, pinRank: at }
  }
  return sections.map((s) => ({
    ...s,
    places: s.places.map(mark),
    sections: s.sections.map((u) => ({ ...u, places: u.places.map(mark) })),
  }))
}

/** Builds the place list of a server: the direct chats with agents. */
export class Places extends Context.Service<Places, PlacesService>()("robot/main/Places") {
  static readonly layer = Layer.effect(
    Places,
    Effect.gen(function* () {
      const agents = yield* Agents
      const db = yield* Database
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

      const layoutsOf = (serverId: string): Layouts => {
        const read = (kind: PlaceKind, extra: string) =>
          db
            .all<{ id: string; place_position: number | null; pinned: number }>(
              `SELECT id, place_position, pinned FROM ${kind} WHERE server_id = ?${extra}`,
              serverId,
            )
            .map((r): [string, Layout] => [
              layoutKey(kind, r.id),
              { position: r.place_position, pinned: r.pinned === 1 },
            ])
        return new Map(read("agent", " AND archived_at IS NULL"))
      }

      return Places.of({
        list: (serverId) =>
          Effect.all([agents.list(serverId, false), sections.list(serverId)]).pipe(
            Effect.map(([list, userSections]): PlaceSection[] => {
              const layouts = layoutsOf(serverId)
              return withPinRanks(
                [
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
                    layouts,
                  ),
                ],
                layouts,
              )
            }),
          ),
      })
    }),
  )
}
