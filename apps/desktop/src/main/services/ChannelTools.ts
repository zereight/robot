import {
  type AgentChannelTool,
  type ChannelLimitInfo,
  type ChannelToolRow,
  type ChannelUsageRow,
  channelsThatGive,
  limitViewOf,
  withChannelSwitch,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { audienceOf, givingFor, limitStopping, usedToday } from "./channelAccess.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Providers } from "./Providers.ts"

// The tools of a channel and its daily token limit as the window reads them (spec 030). The switch
// of a tool is the list of the skill or the connection (017, 018), so this service changes that
// list and nothing else.

export interface ChannelToolsService {
  /** The skills and connections of this computer, with the switch of this channel. */
  forChannel(channelId: string): Effect.Effect<readonly ChannelToolRow[], AppError>
  /**
   * Turns a skill or a connection on or off for a channel. A skill or connection for "All agents"
   * stays as it is. Gives the rows as they are now.
   */
  set(
    channelId: string,
    kind: "skill" | "connection",
    id: string,
    on: boolean,
  ): Effect.Effect<readonly ChannelToolRow[], AppError>
  /** The skills and connections that an agent has from a channel (the line "From <channel>"). */
  forAgent(agentId: string): Effect.Effect<readonly AgentChannelTool[]>
  /** The limit of a channel, the tokens used today, and the channel that stops it. */
  limit(channelId: string): Effect.Effect<ChannelLimitInfo, AppError>
  /** One row for each channel of a server that has a daily token limit (spec 006). */
  usage(serverId: string): Effect.Effect<readonly ChannelUsageRow[]>
}

interface ToolRow {
  id: string
  name: string
  agents: string | null
  channels: string
  enabled: number
}

export class ChannelTools extends Context.Service<ChannelTools, ChannelToolsService>()(
  "robot/main/ChannelTools",
) {
  static readonly layer = Layer.effect(
    ChannelTools,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const providers = yield* Providers

      const tableOf = (kind: "skill" | "connection") =>
        kind === "skill" ? "skill" : "tool_connection"

      const rowsOf = (kind: "skill" | "connection", serverId: string) =>
        db.all<ToolRow>(
          `SELECT id, name, agents, channels, enabled FROM ${tableOf(kind)} WHERE server_id = ?
           ORDER BY name_key`,
          serverId,
        )

      const listFor = (serverId: string, channelId: string): ChannelToolRow[] =>
        (["skill", "connection"] as const).flatMap((kind) =>
          rowsOf(kind, serverId).map((row) => {
            const audience = audienceOf(row)
            const all = audience.agentIds === null
            return {
              kind,
              id: row.id,
              name: row.name,
              on: all || audience.channelIds.includes(channelId),
              all,
            }
          }),
        )

      const channelServer = (channelId: string) =>
        db.get<{ server_id: string }>("SELECT server_id FROM channel WHERE id = ?", channelId)
          ?.server_id

      return ChannelTools.of({
        forChannel: (channelId) =>
          Effect.suspend(() => {
            const serverId = channelServer(channelId)
            return serverId === undefined
              ? Effect.fail(new AppError({ code: "channel_not_found" }))
              : Effect.succeed(listFor(serverId, channelId))
          }),
        set: (channelId, kind, id, on) =>
          Effect.suspend(() => {
            const serverId = channelServer(channelId)
            if (serverId === undefined)
              return Effect.fail(new AppError({ code: "channel_not_found" }))
            const row = db.get<ToolRow>(
              `SELECT id, name, agents, channels, enabled FROM ${tableOf(kind)}
               WHERE id = ? AND server_id = ?`,
              id,
              serverId,
            )
            if (!row)
              return Effect.fail(
                new AppError({
                  code: kind === "skill" ? "skill_unavailable" : "connection_not_found",
                }),
              )
            const audience = audienceOf(row)
            const next = withChannelSwitch(audience, channelId, on)
            if (next !== audience) {
              db.run(
                `UPDATE ${tableOf(kind)} SET channels = ? WHERE id = ?`,
                JSON.stringify(next.channelIds),
                id,
              )
              if (kind === "skill") bus.emit("skills.changed", { serverId })
              else bus.emit("connections.changed", {})
            }
            return Effect.succeed(listFor(serverId, channelId))
          }),
        forAgent: (agentId) =>
          Effect.sync(() => {
            const agent = db.get<{ server_id: string; model_account_id: string | null }>(
              "SELECT server_id, model_account_id FROM agent WHERE id = ?",
              agentId,
            )
            if (!agent) return []
            const giving = givingFor(db, agentId)
            if (giving.length === 0) return []
            const names = new Map(
              db
                .all<{ id: string; name: string }>(
                  "SELECT id, name FROM channel WHERE server_id = ?",
                  agent.server_id,
                )
                .map((c) => [c.id, c.name]),
            )
            // An agent on a vendor runtime has no connections (spec 018), so it has none from a channel.
            const onRuntime =
              agent.model_account_id !== null && providers.isRuntime(agent.model_account_id)
            const out: AgentChannelTool[] = []
            for (const kind of ["skill", "connection"] as const) {
              if (kind === "connection" && onRuntime) continue
              for (const row of rowsOf(kind, agent.server_id)) {
                if (row.enabled !== 1) continue
                const from = channelsThatGive(audienceOf(row), giving)
                if (from.length === 0) continue
                out.push({
                  kind,
                  id: row.id,
                  name: row.name,
                  channels: from.map((id) => ({ id, name: names.get(id) ?? "" })),
                })
              }
            }
            return out
          }),
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
