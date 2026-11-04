import { median, type UsageRange, type UsageRow } from "@robot/shared"
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
          Effect.sync(() => {
            const from = rangeStart(days, now)
            const to = now + DAY_MS
            const rows = db.all<Omit<UsageRow, "firstReplyMs">>(
              `SELECT day, agentId, agentName, SUM(replies) AS replies,
                      SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens
               FROM (
                 SELECT date(m.finished_at / 1000, 'unixepoch', 'localtime') AS day,
                        a.id AS agentId, a.name AS agentName, 1 AS replies,
                        m.input_tokens AS inputTokens, m.output_tokens AS outputTokens
                 FROM message m JOIN agent a ON a.id = m.agent_id
                 WHERE a.server_id = ? AND m.author = 'agent' AND m.status = 'done'
                   AND m.finished_at >= ? AND m.finished_at < ?
                 UNION ALL
                 SELECT date(m.finished_at / 1000, 'unixepoch', 'localtime'),
                        a.id, a.name, 1, m.input_tokens, m.output_tokens
                 FROM channel_message m JOIN agent a ON a.id = m.agent_id
                 WHERE a.server_id = ? AND m.author = 'agent' AND m.status = 'done'
                   AND m.finished_at >= ? AND m.finished_at < ?
                 UNION ALL
                 -- A memory check posts no message, so its tokens come from its task (spec 008).
                 -- It is no reply, so it adds no reply to the count.
                 SELECT date(t.finished_at / 1000, 'unixepoch', 'localtime'),
                        a.id, a.name, 0, COALESCE(t.input_tokens, 0), COALESCE(t.output_tokens, 0)
                 FROM task t JOIN agent a ON a.id = t.agent_id
                 WHERE a.server_id = ? AND t.source = 'memory_check' AND t.origin IS NULL
                   AND t.finished_at >= ? AND t.finished_at < ?
               )
               GROUP BY day, agentId
               ORDER BY day DESC, agentName`,
              serverId,
              from,
              to,
              serverId,
              from,
              to,
              serverId,
              from,
              to,
            )
            // The "First reply" times of the chat tasks that ended as done, per agent and day.
            const times = new Map<string, { agentName: string; values: number[] }>()
            for (const t of db.all<{ day: string; agentId: string; agentName: string; ms: number }>(
              `SELECT date(t.finished_at / 1000, 'unixepoch', 'localtime') AS day,
                      a.id AS agentId, a.name AS agentName,
                      MAX(0, t.first_reply_at - COALESCE(t.asked_at, t.created_at)) AS ms
               FROM task t JOIN agent a ON a.id = t.agent_id
               WHERE a.server_id = ? AND t.source = 'chat' AND t.state = 'done'
                 AND t.first_reply_at IS NOT NULL AND t.finished_at >= ? AND t.finished_at < ?`,
              serverId,
              from,
              to,
            )) {
              const key = `${t.day}|${t.agentId}`
              const entry = times.get(key) ?? { agentName: t.agentName, values: [] }
              entry.values.push(t.ms)
              times.set(key, entry)
            }
            const out: UsageRow[] = rows.map((r) => ({
              ...r,
              firstReplyMs: median(times.get(`${r.day}|${r.agentId}`)?.values ?? []),
            }))
            // A day with a time but no counted reply still shows its time.
            for (const [key, entry] of times) {
              const [day = "", agentId = ""] = key.split("|")
              if (out.some((r) => r.day === day && r.agentId === agentId)) continue
              out.push({
                day,
                agentId,
                agentName: entry.agentName,
                replies: 0,
                inputTokens: 0,
                outputTokens: 0,
                firstReplyMs: median(entry.values),
              })
            }
            return out.sort(
              (a, b) => b.day.localeCompare(a.day) || a.agentName.localeCompare(b.agentName),
            )
          }),
      })
    }),
  )
}
