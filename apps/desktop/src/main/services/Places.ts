import type { PlaceSection } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Agents } from "./Agents.ts"

export interface PlacesService {
  list(serverId: string): Effect.Effect<readonly PlaceSection[]>
}

/** Builds the place list of a server: channels, then direct chats with agents. */
export class Places extends Context.Service<Places, PlacesService>()("robot/main/Places") {
  static readonly layer = Layer.effect(
    Places,
    Effect.gen(function* () {
      const agents = yield* Agents
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
                  unread: 0,
                  working: a.state === "working",
                  lastMessage: null,
                })),
              },
            ]),
          ),
      })
    }),
  )
}
