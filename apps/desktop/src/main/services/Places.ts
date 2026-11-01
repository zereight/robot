import { type ChatMessage, messageText, type PlaceSection } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"

export interface PlacesService {
  list(serverId: string): Effect.Effect<readonly PlaceSection[]>
}

const LAST_MESSAGE_MAX = 140

/** Builds the place list of a server: channels, then direct chats with agents. */
export class Places extends Context.Service<Places, PlacesService>()("robot/main/Places") {
  static readonly layer = Layer.effect(
    Places,
    Effect.gen(function* () {
      const agents = yield* Agents
      const db = yield* Database

      const lastMessage = (agentId: string) => {
        const row = db.get<{ parts: string }>(
          "SELECT parts FROM message WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
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
          `SELECT COUNT(*) AS n FROM message m JOIN agent a ON a.id = m.agent_id
           WHERE m.agent_id = ? AND m.author = 'agent' AND m.finished_at > a.last_read_at`,
          agentId,
        )?.n ?? 0

      return Places.of({
        list: (serverId) =>
          agents.list(serverId, false).pipe(
            Effect.map((list): PlaceSection[] => [
              { id: "channels", places: [] },
              {
                id: "agents",
                places: list.map((a) => ({
                  kind: "agent" as const,
                  id: a.id,
                  name: a.name,
                  unread: unread(a.id),
                  working: a.state === "working",
                  lastMessage: lastMessage(a.id),
                })),
              },
            ]),
          ),
      })
    }),
  )
}
