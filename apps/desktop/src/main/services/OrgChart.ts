import {
  type AgentState,
  buildChart,
  type ChartModel,
  ORG_HANDOFF_WINDOW_MS,
  type OrgAgent,
  type OrgChannel,
  type OrgHandoff,
  type OrgSnapshot,
  type OrgTask,
  type RpcEvent,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Activity } from "./Activity.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { Providers } from "./Providers.ts"

export interface OrgChartService {
  /**
   * What the org chart of this computer draws, at `now` (spec 029). It reads the agents, the
   * channels and the tasks. It stores nothing, starts no turn and sends nothing off the computer.
   */
  snapshot(now?: number): Effect.Effect<OrgSnapshot>
  /**
   * The same chart as a ready model (spec 029, 012): the nodes in the order of the page, the
   * counts, the states, the lines and the labels of running tasks cut at 90 characters. A linked
   * computer and the phone get this. It holds no prompt, no message and no file content.
   */
  model(now?: number): Effect.Effect<ChartModel>
  /**
   * Looks at the chart again as the clock passes: a hand-off that leaves the window of 7 days. It
   * pushes the chart when it changed, as the loop does: to the window, and to the linked devices. Tests call it by hand with a fake clock.
   */
  check(now: number): Effect.Effect<void>
}

/** The events that can change the chart. It is pushed within a short wait after one of them. */
const SOURCES = new Set<RpcEvent>([
  "agents.changed",
  "channels.changed",
  "places.changed",
  "tasks.changed",
  "providers.changed",
  "sync.changed",
])

/** How often the loop looks for a change that came from an event, and at the clock. */
const STEP_MS = 100
/** The chart is looked at again at least this often, so a hand-off leaves it within a minute. */
const REFRESH_MS = 30_000

interface AgentRow {
  id: string
  name: string
  role: string
  face_shape: number
  face_hue: number
  model_account_id: string | null
}

/** Reads the org chart from the local data (spec 029). */
export class OrgChart extends Context.Service<OrgChart, OrgChartService>()("robot/main/OrgChart") {
  static readonly layer = Layer.effect(
    OrgChart,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const activity = yield* Activity
      const providers = yield* Providers

      const build = (now: number): { snapshot: OrgSnapshot; change: number } => {
        // The task that each agent runs now. A task of the other computer is not run here.
        const active = new Map<string, OrgTask>()
        for (const t of db.all<{
          agent_id: string
          label: string
          state: "running" | "waiting"
        }>(
          `SELECT agent_id, label, state FROM task
           WHERE state IN ('running', 'waiting') AND origin IS NULL
           ORDER BY COALESCE(started_at, created_at) DESC, rowid DESC`,
        )) {
          // An agent runs one task at a time. If two rows are open, the one that waits for the user
          // is the one the user can act on; else the newest.
          const own = active.get(t.agent_id)
          if (!own || (own.state === "running" && t.state === "waiting"))
            active.set(t.agent_id, { label: t.label, state: t.state })
        }

        const agents: OrgAgent[] = db
          .all<AgentRow>(
            `SELECT id, name, role, face_shape, face_hue, model_account_id FROM agent
             WHERE archived_at IS NULL ORDER BY created_at, id`,
          )
          .map((row) => {
            const task = active.get(row.id) ?? null
            // The same rule as the state of an agent in its profile (spec 002). An agent whose task
            // waits for the user is "waiting", also when the app started again since.
            const state: AgentState =
              task?.state === "waiting"
                ? "waiting"
                : activity.isWorking(row.id)
                  ? "working"
                  : row.model_account_id && providers.isConnected(row.model_account_id)
                    ? "idle"
                    : "offline"
            return {
              id: row.id,
              name: row.name,
              role: row.role,
              face: { shape: row.face_shape, hue: row.face_hue },
              state,
              task: state === "working" || state === "waiting" ? task : null,
            }
          })

        const members = new Map<string, string[]>()
        for (const m of db.all<{ channel_id: string; agent_id: string }>(
          "SELECT channel_id, agent_id FROM channel_member ORDER BY channel_id, position",
        )) {
          members.set(m.channel_id, [...(members.get(m.channel_id) ?? []), m.agent_id])
        }
        const channels: OrgChannel[] = db
          .all<{
            id: string
            name: string
            lead_agent_id: string | null
            created_at: number
            parent_channel_id: string | null
          }>(
            "SELECT id, name, lead_agent_id, created_at, parent_channel_id FROM channel ORDER BY created_at, id",
          )
          .map((c) => ({
            id: c.id,
            name: c.name,
            createdAt: c.created_at,
            leadId: c.lead_agent_id,
            memberIds: members.get(c.id) ?? [],
            parentId: c.parent_channel_id,
          }))

        // Hand-offs: the tasks that made a "send" of the source "agent" in the last 7 days, of both
        // computers of a sync pair. A reply, a retry and a task from before the mark are left out.
        const since = now - ORG_HANDOFF_WINDOW_MS
        const handoffs: OrgHandoff[] = db
          .all<{ from_id: string; to_id: string; n: number; newest: number }>(
            `SELECT source_id AS from_id, agent_id AS to_id, COUNT(*) AS n, MAX(created_at) AS newest
             FROM task
             WHERE agent_message = 'send' AND source = 'agent' AND source_id IS NOT NULL
               AND created_at >= ?
             GROUP BY source_id, agent_id
             ORDER BY source_id, agent_id`,
            since,
          )
          .map((h) => ({ from: h.from_id, to: h.to_id, count: h.n, newest: h.newest }))

        // The oldest hand-off in the window leaves it at this time.
        const oldest = db.get<{ at: number | null }>(
          `SELECT MIN(created_at) AS at FROM task
           WHERE agent_message = 'send' AND source = 'agent' AND created_at >= ?`,
          since,
        )?.at
        const change =
          oldest == null
            ? now + REFRESH_MS
            : Math.min(now + REFRESH_MS, oldest + ORG_HANDOFF_WINDOW_MS)
        // The main agent (spec 002, flow 7) has no switch in the app yet, so the root is "You".
        return { snapshot: { mainAgentId: null, agents, channels, handoffs }, change }
      }

      // ------------------------------------------------------------------ Pushing
      // What the window of this computer has: its last read or push.
      let pushed = ""
      // What the linked devices were told last. A read by the window never changes it, so a window
      // that reads between a change and the next look cannot keep the push from a linked device.
      let pushedLinked = ""
      let change = 0
      let dirty = false

      const push = (now: number) => {
        const built = build(now)
        change = built.change
        const sig = JSON.stringify(built.snapshot)
        if (sig !== pushed) {
          pushed = sig
          bus.emit("orgChart.changed", built.snapshot)
        }
        if (sig !== pushedLinked) {
          pushedLinked = sig
          // The ready model goes to the linked devices only (spec 029, 012). No window gets it.
          bus.emitLinked("orgChart.model", buildChart(built.snapshot))
        }
      }

      bus.tap((event) => {
        if (SOURCES.has(event)) dirty = true
      })

      const check = (now: number) =>
        Effect.sync(() => {
          if (!dirty && !(change > 0 && now >= change)) return
          dirty = false
          push(now)
        })

      yield* Effect.forkDetach(
        Effect.forever(
          Effect.sleep(STEP_MS).pipe(Effect.andThen(Effect.suspend(() => check(Date.now())))),
        ),
      )

      return OrgChart.of({
        snapshot: (now = Date.now()) =>
          Effect.sync(() => {
            const built = build(now)
            change = built.change
            pushed = JSON.stringify(built.snapshot)
            return built.snapshot
          }),
        // A read for a client changes nothing that the push loop compares with, so a client that
        // asks never keeps the window of this computer, or another client, from getting a push.
        model: (now = Date.now()) =>
          Effect.sync(() => {
            const built = build(now)
            if (change === 0) change = built.change
            return buildChart(built.snapshot)
          }),
        check,
      })
    }),
  )
}
