import {
  cleanEventParams,
  cleanEventSummary,
  cutEventDetail,
  EVENT_ID_MAX,
  EVENT_ID_MS,
  EVENTS_MAX,
  EVENTS_PAGE,
  EVENTS_PER_LOOK_MAX,
  type EventInput,
  type EventResult,
  type EventSource,
  type EventText,
  type RobotEvent,
  SUBJECT_WAITING_MAX,
  subjectWaits,
  testEventGone,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"

/**
 * The record of what arrived at a place that the user made (spec 038). It stores one row for each
 * arrival, keeps the id of a call for 7 days, and trims a profile to 2000 rows. It starts nothing:
 * the routine and the workflow ask it to record, and the record is for the user.
 */
export interface EventsService {
  /** Records one arrival, and trims the profile. It makes no task and no run. */
  add(input: EventInput): Effect.Effect<RobotEvent>
  /** The newest events of a server, with a filter, in pages of 50. */
  list(
    serverId: string,
    options?: { result?: EventResult; offset?: number },
  ): Effect.Effect<readonly RobotEvent[]>
  /** One event, or null. */
  get(id: string): Effect.Effect<RobotEvent | null>
  /**
   * The event of the same call, when the app saw it less than 7 days ago. Null for a call that is
   * new, for a call with no id, and for an id that is older than that.
   */
  duplicateOf(
    serverId: string,
    callId: string | null,
    now: number,
  ): Effect.Effect<RobotEvent | null>
  /**
   * How many messages of one subject wait for their work to end now. Used to decide between Waits
   * and Skipped (spec 038, "One at a time for one subject").
   */
  waitingOf(serverId: string, subject: string): Effect.Effect<number>
  /** Drops the test events that are more than 1 day old. The loop calls it by the clock. */
  trimTest(now: number): Effect.Effect<void>
  /**
   * The newest event of one place that ended as Routed shows "Failed" with the reason (spec 038,
   * "Result"). A place with no such event is not changed. The routine calls it when a run ends
   * as failed or blocked, and the workflow when a run does. The reason is the error of the task,
   * which is the code and the detail that the task already keeps (spec 005), so the page shows it
   * through the same key as the Tasks page.
   */
  failLatestOfPlace(placeId: string, reason: { code: string; detail: string }): Effect.Effect<void>
}

interface Row {
  id: string
  server_id: string
  source: string
  type: string
  subject: string | null
  call_id: string | null
  summary: string
  detail: string
  link: string | null
  agent_id: string | null
  place_id: string | null
  place_is_routine: number
  place_name: string | null
  why: string
  got: string
  task_id: string | null
  result: string
  reason: string | null
  outside: number
  at: number
}

const toEvent = (r: Row): RobotEvent => ({
  id: r.id,
  serverId: r.server_id,
  source: r.source as EventSource,
  type: decodeText(r.type),
  subject: r.subject,
  callId: r.call_id,
  summary: decodeText(r.summary),
  detail: r.detail,
  link: r.link,
  agentId: r.agent_id,
  placeId: r.place_id,
  placeIsRoutine: r.place_is_routine === 1,
  placeName: r.place_name,
  why: decodeText(r.why),
  got: r.got,
  taskId: r.task_id,
  result: r.result as EventResult,
  reason: r.reason ? decodeText(r.reason) : null,
  outside: r.outside === 1,
  at: r.at,
})

/**
 * A text of a row that the app wrote as a key, or text that a source gave from outside. A row from
 * before the keys are held as JSON keeps its plain text, and the page shows it as it is.
 */
const decodeText = (raw: string): EventText => {
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { key?: unknown; text?: unknown; params?: unknown }
      if (typeof parsed.key === "string")
        return { key: parsed.key, params: paramsOf(parsed.params) }
      if (typeof parsed.text === "string") return { text: parsed.text }
    } catch {
      // Not JSON: a plain text.
    }
  }
  return { text: raw }
}

const paramsOf = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object") return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) out[key] = String(raw)
  return out
}

/** A text of an event as one column holds it. */
const encodeText = (value: EventText): string => JSON.stringify(value)

/**
 * One line of an event, cut at the limit: the text of a source as it came, or the parameters that
 * the app fills. The catalogue sentence itself is short, so only the parameters and an outside text
 * need the cut (spec 038, "Limits and retention").
 */
const cleanText = (value: EventText): EventText =>
  "key" in value
    ? { key: value.key, params: cleanEventParams(value.params) }
    : { text: cleanEventSummary(value.text) }

const SELECT = `
  SELECT id, server_id, source, type, subject, call_id, summary, detail, link, agent_id,
    place_id, place_is_routine, place_name, why, got, task_id, result, reason, outside, at
  FROM robot_event`

export class Events extends Context.Service<Events, EventsService>()("robot/main/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus

      const make = (input: EventInput, now: number): RobotEvent => ({
        id: crypto.randomUUID(),
        serverId: input.serverId,
        source: input.source,
        type: input.type,
        subject: input.subject ?? null,
        callId: input.callId ?? null,
        summary: cleanText(input.summary),
        detail: cutEventDetail(input.detail ?? ""),
        link: input.link ?? null,
        agentId: input.agentId ?? null,
        placeId: input.placeId ?? null,
        placeIsRoutine: input.placeIsRoutine ?? false,
        placeName: input.placeName ?? null,
        why: input.why,
        got: cutEventDetail(input.got ?? "", 4000),
        taskId: input.taskId ?? null,
        result: input.result,
        reason: input.reason ?? null,
        outside: input.outside ?? false,
        at: now,
      })

      const trim = (serverId: string) => {
        // A profile keeps 2000 events, oldest first out (spec 038, "Limits and retention").
        // Many rows can share one millisecond, so the order uses the row number too.
        const count = db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM robot_event WHERE server_id = ?",
          serverId,
        )
        const over = (count?.n ?? 0) - EVENTS_MAX
        if (over <= 0) return
        db.run(
          `DELETE FROM robot_event WHERE id IN (
            SELECT id FROM robot_event WHERE server_id = ? ORDER BY at, rowid LIMIT ?
          )`,
          serverId,
          over,
        )
      }

      const waiting = (serverId: string, subject: string) => {
        const row = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM robot_event
           WHERE server_id = ? AND subject = ? AND result = 'waits'`,
          serverId,
          subject,
        )
        return row?.n ?? 0
      }

      return Events.of({
        add: (input) =>
          Effect.sync(() => {
            const now = Date.now()
            const event = make(input, now)
            db.run(
              `INSERT INTO robot_event (id, server_id, source, type, subject, call_id, summary, detail,
                 link, agent_id, place_id, place_is_routine, place_name, why, got, task_id, result,
                 reason, outside, at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              event.id,
              event.serverId,
              event.source,
              encodeText(event.type),
              event.subject,
              event.callId,
              encodeText(event.summary),
              event.detail,
              event.link,
              event.agentId,
              event.placeId,
              event.placeIsRoutine ? 1 : 0,
              event.placeName,
              encodeText(event.why),
              event.got,
              event.taskId,
              event.result,
              event.reason ? encodeText(event.reason) : null,
              event.outside ? 1 : 0,
              event.at,
            )
            trim(event.serverId)
            bus.emit("events.changed", { serverId: event.serverId })
            return event
          }),
        list: (serverId, options = {}) =>
          Effect.sync(() => {
            const offset = options.offset ?? 0
            const limit = Math.min(EVENTS_PAGE, EVENTS_PER_LOOK_MAX - offset)
            if (limit <= 0) return []
            const rows = options.result
              ? db.all<Row>(
                  `${SELECT} WHERE server_id = ? AND result = ? ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`,
                  serverId,
                  options.result,
                  limit,
                  offset,
                )
              : db.all<Row>(
                  `${SELECT} WHERE server_id = ? ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`,
                  serverId,
                  limit,
                  offset,
                )
            const now = Date.now()
            return rows.map(toEvent).filter((e) => !testEventGone(e, now))
          }),
        get: (id) =>
          Effect.sync(() => {
            const row = db.get<Row>(`${SELECT} WHERE id = ?`, id)
            return row ? toEvent(row) : null
          }),
        duplicateOf: (serverId, callId, now) =>
          Effect.sync(() => {
            if (!callId || callId.length > EVENT_ID_MAX) return null
            const row = db.get<Row>(
              `${SELECT} WHERE server_id = ? AND call_id = ? AND at >= ? ORDER BY at DESC LIMIT 1`,
              serverId,
              callId,
              now - EVENT_ID_MS,
            )
            return row ? toEvent(row) : null
          }),
        waitingOf: (serverId, subject) => Effect.sync(() => waiting(serverId, subject)),
        trimTest: (now) =>
          Effect.sync(() => {
            // A test event leaves after 1 day (spec 038, "Check where this goes").
            const rows = db.all<{ server_id: string }>(
              "SELECT DISTINCT server_id FROM robot_event WHERE source = 'test' AND at < ?",
              now - 24 * 60 * 60 * 1000,
            )
            db.run(
              "DELETE FROM robot_event WHERE source = 'test' AND at < ?",
              now - 24 * 60 * 60 * 1000,
            )
            for (const r of rows) bus.emit("events.changed", { serverId: r.server_id })
          }),
        failLatestOfPlace: (placeId, reason) =>
          Effect.sync(() => {
            const row = db.get<Row>(
              "SELECT * FROM robot_event WHERE place_id = ? AND result = 'routed' ORDER BY at DESC, rowid DESC LIMIT 1",
              placeId,
            )
            if (!row) return
            db.run(
              "UPDATE robot_event SET result = 'failed', reason = ? WHERE id = ?",
              encodeText({ key: `error.${reason.code}`, params: { detail: reason.detail } }),
              row.id,
            )
            bus.emit("events.changed", { serverId: row.server_id })
          }),
      })
    }),
  )
}

/**
 * The result of a message of one subject that has work going now (spec 038, "One at a time for one
 * subject"): it waits, or it is skipped when three messages of that subject wait already.
 */
export const subjectResult = (
  waitingNow: number,
): { result: "waits" | "skipped"; reason: string | null } =>
  waitingNow >= SUBJECT_WAITING_MAX
    ? { result: "skipped", reason: `${SUBJECT_WAITING_MAX} messages of the subject wait.` }
    : { result: "waits", reason: null }

/** True when this source waits in turn for the same subject (spec 038). */
export const sourceWaits = (source: EventSource) => subjectWaits(source)
