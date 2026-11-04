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
  type WireNotice,
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
  /** A page to open on a click: the workflows page, or Settings, Teams (spec 028). */
  readonly page?: "workflows" | "teams"
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
  /**
   * True when the approval card has the choice "Always allow for this agent". The island offers
   * it only then, and never for a request of the other computer (`from`).
   */
  readonly always: boolean
  readonly target: PlaceTarget
  /** When the agent asked (spec 007). Without it the time of the first notice counts. */
  readonly askedAt?: number
}

interface WaitingItem extends IslandAttention {
  readonly serverId: string
  readonly channelId: string | null
  /** When the request began to wait. The Today page orders its first group by it. */
  readonly askedAt: number
  /** The name of the other computer when the task runs there (spec 019), or null. */
  readonly from: string | null
}

/** A request that waits, as the Today page needs it (spec 021). */
export interface WaitingRequest {
  readonly agentId: string
  readonly callId: string
  readonly kind: "approval" | "question"
  /** The text of the step or of the question, cut by the island rules. */
  readonly summary: string
  /** The channel name, or null for a direct chat. */
  readonly place: string | null
  readonly target: PlaceTarget
  readonly askedAt: number
  readonly from: string | null
}

/** The linked server that a notice came from. */
export interface NoticeSource {
  readonly linkId: string
  /** The id that the server has for itself: mutes are kept by it. */
  readonly serverId: string
  readonly serverName: string
}

export interface NotifierService {
  /** A system notification, when the kind is on, the place is not muted and no window has focus. */
  notify(notice: Notice): void
  /**
   * A notice of a linked server (spec 012, 015). It shows by the settings of this computer: the
   * kind, the focus of the window and the mute of that server or channel. It names the server, and
   * it shows once for a request that waits, also when another device answered it.
   */
  notifyLinked(source: NoticeSource, notice: WireNotice): void
  /** A request of a linked server was answered here: it must not notify again. */
  answeredLinked(linkId: string, agentId: string, callId: string): void
  /** The approvals and questions that wait now, for a linked device that connects. */
  waitingNotices(): readonly WireNotice[]
  /** The requests that wait now, including those of the other computer of a sync pair. */
  waitingRequests(): readonly WaitingRequest[]
  /**
   * An approval or a question waits: a notification and the island card. `from` names the other
   * computer when the task runs there (spec 015, 019).
   */
  attention(item: WaitingInput, from?: string): void
  /**
   * Whether the island may take "Always allow" for this request. False for a request that is not
   * known, and for a request of the other computer: the answer is then one "Allow" (spec 015, 019).
   */
  canAlways(agentId: string, callId: string): boolean
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
          id: string
          source: string
          source_id: string | null
          parent_id: string | null
          label: string
          started_at: number | null
        }>(
          `SELECT id, source, source_id, parent_id, label, started_at FROM task
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
        // The turn of the task of this row is quiet (spec 005, "Quiet line").
        const quiet = task ? activity.quietOf(task.id) : undefined
        return {
          agent,
          place,
          target: targetOf(agent.id, place === null ? null : channelId),
          doing,
          since,
          quiet: quiet ? { name: quiet.name, seconds: quiet.seconds } : null,
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
          waiting: waiting.map(
            ({ serverId: _s, channelId: _c, askedAt: _a, from: _f, ...item }) => item,
          ),
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

      const BODY = (text: string) => cut(text)

      /** The body of a notice from a workflow is the first characters of the input as they are. */
      const bodyOf = (n: Notice) =>
        n.kind === "workflow_notice" ? notifyBody(n.body) : cut(n.body)

      /** Linked devices get every notice and decide by their own settings. */
      const push = (n: Notice, ids?: { callId: string; agentId: string }) => {
        const kind = n.kind
        // The Teams link belongs to this computer. A linked device shows no part of it (spec 028).
        if (kind === "teams_link") return
        bus.emit("notice", {
          kind,
          channelId: n.channelId ?? null,
          title: n.title,
          body: bodyOf(n),
          ...(n.target ? { target: n.target } : {}),
          ...(n.page === "workflows" ? { page: n.page } : {}),
          ...(ids ? { callId: ids.callId, agentId: ids.agentId } : {}),
        })
      }

      const notify = (n: Notice, ids?: { callId: string; agentId: string }, isNew = true) => {
        // A linked device has the main thread only: a reply in another thread is no news there
        // (spec 011, 012). A card that waits in another thread still goes, for "Needs you".
        if (isNew && !(n.kind === "reply" && n.target?.threadId)) push(n, ids)
        show(n)
      }

      const show = (n: Notice) => {
        // A kind that was added after the setting was saved has no value and counts as on.
        if (current().notifyKinds[n.kind] === false) return
        if (platform.isFocused()) return
        if (isMuted(mutes(), n.serverId, n.channelId ?? null, Date.now())) return
        platform.notify({ title: n.title, body: bodyOf(n) }, () => {
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

      /** The requests of linked servers that were shown or answered, so none shows twice. */
      const linkedSeen = new Set<string>()
      const keyOf = (linkId: string, agentId: string, callId: string) =>
        `${linkId}:${agentId}:${callId}`

      return Notifier.of({
        notify: (n) => notify(n),
        notifyLinked: (source, notice) => {
          if (notice.callId && notice.agentId) {
            const key = keyOf(source.linkId, notice.agentId, notice.callId)
            if (linkedSeen.has(key)) return
            linkedSeen.add(key)
          }
          if (current().notifyKinds[notice.kind] === false) return
          if (platform.isFocused()) return
          if (isMuted(mutes(), source.serverId, notice.channelId, Date.now())) return
          platform.notify(
            {
              title: `${notice.title} · ${source.serverName}`,
              body: notice.kind === "workflow_notice" ? notifyBody(notice.body) : cut(notice.body),
            },
            () => {
              platform.showWindow()
              if (notice.page)
                bus.emit("app.openPage", { page: notice.page, serverId: source.serverId })
              else if (notice.target)
                bus.emit("app.openPlace", { ...notice.target, serverId: source.serverId })
            },
          )
        },
        answeredLinked: (linkId, agentId, callId) => {
          linkedSeen.add(keyOf(linkId, agentId, callId))
        },
        waitingNotices: () =>
          waiting.map((w) => ({
            kind: w.kind,
            channelId: w.channelId,
            title: w.agent.name,
            body: BODY(w.summary),
            target: w.target,
            callId: w.callId,
            agentId: w.agentId,
          })),
        waitingRequests: () =>
          waiting.map((w) => ({
            agentId: w.agentId,
            callId: w.callId,
            kind: w.kind,
            summary: w.summary,
            place: w.place,
            target: w.target,
            askedAt: w.askedAt,
            from: w.from,
          })),
        attention: (input, from) => {
          const agent = agentInfo(input.agentId)
          if (!agent) return
          const { summary, askedAt, ...rest } = input
          const at = waiting.findIndex(
            (w) => w.agentId === input.agentId && w.callId === input.callId,
          )
          const item: WaitingItem = {
            ...rest,
            agent,
            summary: attentionText(input.kind, summary),
            place: channelName(input.channelId),
            // A request of the other computer never has "Always allow" here, whatever the caller says.
            always: input.always && from === undefined,
            // A request that is seen again keeps the time it began to wait.
            askedAt: askedAt ?? waiting[at]?.askedAt ?? Date.now(),
            from: from ?? null,
          }
          if (at >= 0) waiting[at] = item
          else waiting.push(item)
          // A request for attention replaces a result card at once.
          result = null
          notify(
            {
              kind: item.kind,
              serverId: item.serverId,
              channelId: item.channelId,
              title: from ? `${item.agent.name} · ${from}` : item.agent.name,
              body: summary,
              target: item.target,
            },
            { callId: item.callId, agentId: item.agentId },
            at < 0,
          )
          refresh()
        },
        canAlways: (agentId, callId) =>
          waiting.some((w) => w.agentId === agentId && w.callId === callId && w.always),
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
