import type { PlaceSection } from "@robot/shared"
import { Context, Effect, Layer } from "effect"

export interface PlacesService {
  list(serverId: string): Effect.Effect<readonly PlaceSection[]>
}

/** Builds the place list of a server: channels, then direct chats with agents. */
export class Places extends Context.Service<Places, PlacesService>()("robot/main/Places") {
  static readonly layer = Layer.succeed(
    Places,
    Places.of({
      list: () =>
        Effect.succeed([
          { id: "channels", places: [] },
          { id: "agents", places: [] },
        ]),
    }),
  )
}
