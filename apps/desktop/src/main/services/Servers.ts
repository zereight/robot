import { randomUUID } from "node:crypto"
import type { Server } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"

export interface ServersService {
  readonly list: Effect.Effect<readonly Server[]>
  /** The server that is this computer. The app makes it on first start. */
  readonly local: Effect.Effect<Server>
}

export class Servers extends Context.Service<Servers, ServersService>()("robot/main/Servers") {
  static readonly layer = (localName: string) =>
    Layer.effect(
      Servers,
      Effect.gen(function* () {
        const db = yield* Database
        const list = Effect.sync(() =>
          db.all<Server>("SELECT id, name, kind FROM server ORDER BY position, created_at"),
        )
        const existing = db.get<Server>("SELECT id, name, kind FROM server WHERE kind = 'local'")
        if (!existing) {
          db.run(
            "INSERT INTO server (id, name, kind, position, created_at) VALUES (?, ?, 'local', 0, ?)",
            randomUUID(),
            localName,
            Date.now(),
          )
        }
        const local = Effect.sync(
          () => db.get<Server>("SELECT id, name, kind FROM server WHERE kind = 'local'") as Server,
        )
        return Servers.of({ list, local })
      }),
    )
}
