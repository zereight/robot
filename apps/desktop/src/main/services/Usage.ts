import type { UsageRange, UsageRow } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"

export interface UsageService {
  /** Usage per agent and local day on one server, for the last `days` days including today. */
  summary(serverId: string, days: UsageRange, now?: number): Effect.Effect<readonly UsageRow[]>
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Local midnight at the start of the range. */
const rangeStart = (days: number, now: number) => {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return start.getTime()
}

/** What the providers reported per reply, added up from the stored messages. */
export class Usage extends Context.Service<Usage, UsageService>()("robot/main/Usage") {
  static readonly layer = Layer.effect(
    Usage,
    Effect.gen(function* () {
      const db = yield* Database
      return Usage.of({
        summary: (serverId, days, now = Date.now()) =>
          Effect.sync(() =>
            db.all<UsageRow>(
              `SELECT date(m.finished_at / 1000, 'unixepoch', 'localtime') AS day,
                      a.id AS agentId, a.name AS agentName, COUNT(*) AS replies,
                      SUM(m.input_tokens) AS inputTokens, SUM(m.output_tokens) AS outputTokens
               FROM message m JOIN agent a ON a.id = m.agent_id
               WHERE a.server_id = ? AND m.author = 'agent' AND m.status = 'done'
                 AND m.finished_at >= ? AND m.finished_at < ?
               GROUP BY day, a.id
               ORDER BY day DESC, a.name`,
              serverId,
              rangeStart(days, now),
              now + DAY_MS,
            ),
          ),
      })
    }),
  )
}
