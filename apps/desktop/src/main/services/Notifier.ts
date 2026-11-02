import {
  attentionText,
  type Face,
  firstLine,
  ISLAND_ROWS_MAX,
  ISLAND_WORKING_MAX,
  type IslandAgent,
  type IslandAttention,
  type IslandDoing,
  type IslandResult,
  type IslandRow,
  type IslandState,
  islandShape,
  isMuted,
  isResultKind,
  type Mute,
  type MuteChoice,
  muteUntil,
  type NotifyKind,
  notifyBody,
  type PlaceTarget,
  type ToolStepKind,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Activity } from "./Activity.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { Platform } from "./Platform.ts"
import { SettingsStore } from "./Settings.ts"

export interface Notice {
  readonly kind: NotifyKind
  readonly serverId: string
  readonly channelId?: string | null
  readonly title: string
  readonly body: string
  /** The place to open on a click. A notice with a page opens that page instead. */
  readonly target?: PlaceTarget
  readonly page?: "workflows"
  /** The agent of a reply or of a failure. The result card of the island needs it. */
  readonly agentId?: string
  /** Why a task or routine failed. The result card of the island shows it. */
  readonly reason?: { readonly code: string; readonly detail: string }
}

/** A request for attention, as the chat and the channels report it. */
export interface WaitingInput {
  readonly agentId: string
  readonly serverId: string
  readonly channelId: string | null
  readonly callId: string
  readonly kind: "approval" | "question"
  /** The full text of the step or of the question. The island cuts it. */
  readonly summary: string
  /** For an approval, the kind of step. Null when it is not known. */
  readonly step: ToolStepKind | null
  readonly target: PlaceTarget
}

interface WaitingItem extends IslandAttention {
  readonly serverId: string
  readonly channelId: string | null
}

export interface NotifierService {
  /** A system notification, when the kind is on, the place is not muted and no window has focus. */
  notify(notice: Notice): void
  /** An approval or a question waits: a notification and the island card. */
  attention(item: WaitingInput): void
  clearAttention(agentId: string, callId: string): void
  clearAgent(agentId: string): void
  island(): IslandState
  /** Shows the island again, after a change of its setting. */
  refresh(): void
  /** The result card has ended. A newer result is not touched. */
  dismissResult(id: number): void
  mutes(): readonly Mute[]
  setMute(kind: Mute["kind"], id: string, choice: MuteChoice): Effect.Effect<void>
}

const BODY_MAX = 140
const cut = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return [...line].length > BODY_MAX ? `${[...line].slice(0, BODY_MAX - 1).join("")}…` : line
}

export class Notifier extends Context.Service<Notifier, NotifierService>()("robot/main/Notifier") {
  static readonly layer = Layer.effect(
    Notifier,
    Effect.gen(function* () {
      const db = yield* Database
      const platform = yield* Platform
      const settings = yield* SettingsStore
      const bus = yield* EventBus
      const activity = yield* Activity
      const waiting: WaitingItem[] = []
      let result: IslandResult | null = null
      let resultId = 0

      const mutes = (): Mute[] =>
        db.all<{ kind: Mute["kind"]; id: string; until: number | null }>("SELECT * FROM mute")
      const current = () => Effect.runSync(settings.get)

      const agentInfo = (id: string): IslandAgent | undefined => {
        const row = db.get<{ id: string; name: string; face_shape: number; face_hue: number }>(
          "SELECT id, name, face_shape, face_hue FROM agent WHERE id = ?",
          id,
        )
        const face: Face | undefined = row && { shape: row.face_shape, hue: row.face_hue }
        return row && face ? { id: row.id, name: row.name, face } : undefined
      }

      const channelName = (id: string | null | undefined) =>
        id
          ? (db.get<{ name: string }>("SELECT name FROM channel WHERE id = ?", id)?.name ?? null)
          : null

      /** The running task of an agent: its place, the label of its plan step, and when it began. */
      const runningTask = (agentId: string) =>
        db.get<{
          source: string
          source_id: string | null
          parent_id: string | null
          label: string
          started_at: number | null
        }>(
          `SELECT source, source_id, parent_id, label, started_at FROM task
           WHERE agent_id = ? AND state IN ('running', 'waiting')
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
          agentId,
        )
      /** The channel of a task, or null when it works in a direct chat. */
      const taskChannel = (task: { source: string; source_id: string | null } | undefined) => {
        if (!task?.source_id) return null
        if (task.source === "channel") return task.source_id
        if (task.source === "routine")
          return (
            db.get<{ channel_id: string | null }>(
              "SELECT channel_id FROM routine WHERE id = ?",
              task.source_id,
            )?.channel_id ?? null
          )
        return null
      }
      const targetOf = (agentId: string, channelId: string | null): PlaceTarget =>
        channelId ? { kind: "channel", id: channelId } : { kind: "agent", id: agentId }
      /** When an agent without a task row began to work, for the time of its row. */
      const began = new Map<string, number>()

      const rowOf = (agent: IslandAgent): IslandRow => {
        const task = runningTask(agent.id)
        const channelId = taskChannel(task)
        const place = channelName(channelId)
        const tool = activity.stepOf(agent.id)
        const doing: IslandDoing =
          task?.parent_id && task.label.trim() !== ""
            ? { kind: "plan", label: task.label }
            : tool
              ? { kind: "tool", tool }
              : { kind: "none" }
        const since = task?.started_at ?? began.get(agent.id) ?? Date.now()
        began.set(agent.id, since)
        return {
          agent,
          place,
          target: targetOf(agent.id, place === null ? null : channelId),
          doing,
          since,
        }
      }

      const island = (): IslandState => {
        const mode = current().island
        const agents = activity.workingIds().flatMap((id) => agentInfo(id) ?? [])
        for (const id of [...began.keys()]) if (!agents.some((a) => a.id === id)) began.delete(id)
        return {
          mode,
          working: agents.slice(0, ISLAND_WORKING_MAX),
          count: agents.length,
          rows: agents.slice(0, ISLAND_ROWS_MAX).map(rowOf),
          waiting: waiting.map(({ serverId: _s, channelId: _c, ...item }) => item),
          // The result card is for the mode "always" only.
          result: mode === "always" ? result : null,
        }
      }
      const refresh = () => {
        const state = island()
        platform.setIslandShape(islandShape(state))
        bus.emit("island.state", state)
      }
      activity.onChange(refresh)

      const notify = (n: Notice) => {
        // A kind that was added after the setting was saved has no value and counts as on.
        if (current().notifyKinds[n.kind] === false) return
        if (platform.isFocused()) return
        if (isMuted(mutes(), n.serverId, n.channelId ?? null, Date.now())) return
        // The body of a notice from a workflow is the first characters of the input as they are.
        const body = n.kind === "workflow_notice" ? notifyBody(n.body) : cut(n.body)
        platform.notify({ title: n.title, body }, () => {
          platform.showWindow()
          if (n.page) bus.emit("app.openPage", { page: n.page })
          else if (n.target) bus.emit("app.openPlace", n.target)
        })
        showResult(n)
      }

      /** The result card, under the same rules as the notification, in the mode "always". */
      const showResult = (n: Notice) => {
        if (current().island !== "always" || !isResultKind(n.kind) || !n.agentId || !n.target)
          return
        const agent = agentInfo(n.agentId)
        if (!agent) return
        // A request for attention holds the island. The result is not kept for later.
        if (waiting.length > 0) return
        result = {
          id: ++resultId,
          kind: n.kind,
          agent,
          place: channelName(n.channelId),
          line: n.kind === "reply" ? firstLine(n.body) : "",
          reason: n.kind === "reply" ? null : (n.reason ?? null),
          target: n.target,
        }
        refresh()
      }

      return Notifier.of({
        notify,
        attention: (input) => {
          const agent = agentInfo(input.agentId)
          if (!agent) return
          const { summary, ...rest } = input
          const item: WaitingItem = {
            ...rest,
            agent,
            summary: attentionText(input.kind, summary),
            place: channelName(input.channelId),
          }
          const at = waiting.findIndex(
            (w) => w.agentId === item.agentId && w.callId === item.callId,
          )
          if (at >= 0) waiting[at] = item
          else waiting.push(item)
          // A request for attention replaces a result card at once.
          result = null
          notify({
            kind: item.kind,
            serverId: item.serverId,
            channelId: item.channelId,
            title: item.agent.name,
            body: summary,
            target: item.target,
          })
          refresh()
        },
        clearAttention: (agentId, callId) => {
          const at = waiting.findIndex((w) => w.agentId === agentId && w.callId === callId)
          if (at < 0) return
          waiting.splice(at, 1)
          refresh()
        },
        clearAgent: (agentId) => {
          const before = waiting.length
          for (let i = waiting.length - 1; i >= 0; i--)
            if (waiting[i]?.agentId === agentId) waiting.splice(i, 1)
          if (waiting.length !== before) refresh()
        },
        island,
        refresh,
        dismissResult: (id) => {
          if (result?.id !== id) return
          result = null
          refresh()
        },
        mutes,
        setMute: (kind, id, choice) =>
          Effect.sync(() => {
            const until = muteUntil(choice, Date.now())
            if (until === undefined) db.run("DELETE FROM mute WHERE kind = ? AND id = ?", kind, id)
            else
              db.run(
                "INSERT INTO mute (kind, id, until) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET until = excluded.until",
                kind,
                id,
                until,
              )
            bus.emit("notifications.changed", {})
          }),
      })
    }),
  )
}
