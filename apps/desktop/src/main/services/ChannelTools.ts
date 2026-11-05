import { type ChannelLimitInfo, type ChannelUsageRow, limitViewOf } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { limitStopping, usedToday } from "./channelAccess.ts"
import { Database } from "./Database.ts"
import { AppError } from "./errors.ts"

// The daily token limit of a channel as the window reads it (spec 030). The tools of an
// organization are in the service of organizations. The limit moves to the organizations in the
// next step, and this service goes with it.

export interface ChannelToolsService {
  /** The limit of a channel, the tokens used today, and the channel that stops it. */
  limit(channelId: string): Effect.Effect<ChannelLimitInfo, AppError>
  /** One row for each channel of a server that has a daily token limit (spec 006). */
  usage(serverId: string): Effect.Effect<readonly ChannelUsageRow[]>
}

export class ChannelTools extends Context.Service<ChannelTools, ChannelToolsService>()(
  "robot/main/ChannelTools",
) {
  static readonly layer = Layer.effect(
    ChannelTools,
    Effect.gen(function* () {
      const db = yield* Database

      const channelServer = (channelId: string) =>
        db.get<{ server_id: string }>("SELECT server_id FROM channel WHERE id = ?", channelId)
          ?.server_id

      return ChannelTools.of({
        limit: (channelId) =>
          Effect.suspend(() => {
            const serverId = channelServer(channelId)
            if (serverId === undefined)
              return Effect.fail(new AppError({ code: "channel_not_found" }))
            const { channels, used } = usedToday(db, serverId)
            const own = channels.find((c) => c.id === channelId)?.dailyLimit ?? null
            return Effect.succeed({
              ...limitViewOf(own, used.get(channelId) ?? 0),
              stoppedBy: limitStopping(db, channelId),
            })
          }),
        usage: (serverId) =>
          Effect.sync(() => {
            const { channels, used } = usedToday(db, serverId)
            const names = new Map(
              db
                .all<{ id: string; name: string }>(
                  "SELECT id, name FROM channel WHERE server_id = ?",
                  serverId,
                )
                .map((c) => [c.id, c.name]),
            )
            return channels
              .flatMap((c) =>
                c.dailyLimit === null
                  ? []
                  : [
                      {
                        channelId: c.id,
                        name: names.get(c.id) ?? "",
                        used: used.get(c.id) ?? 0,
                        limit: c.dailyLimit,
                      },
                    ],
              )
              .sort((a, b) => a.name.localeCompare(b.name))
          }),
      })
    }),
  )
}
