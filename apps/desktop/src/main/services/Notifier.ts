import {
  type Face,
  ISLAND_WORKING_MAX,
  type IslandAgent,
  type IslandAttention,
  type IslandState,
  islandShape,
  isMuted,
  type Mute,
  type MuteChoice,
  muteUntil,
  type NotifyKind,
  notifyBody,
  type PlaceTarget,
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
  readonly page?: "workflows"
}

export interface WaitingItem extends IslandAttention {
  readonly serverId: string
  readonly channelId: string | null
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
  /**
   * An approval or a question waits: a notification and the island card. `from` names the other
   * computer when the task runs there (spec 015, 017).
   */
  attention(item: Omit<WaitingItem, "agent">, from?: string): void
  clearAttention(agentId: string, callId: string): void
  clearAgent(agentId: string): void
  island(): IslandState
  /** Shows the island again, after a change of its setting. */
  refresh(): void
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

      const island = (): IslandState => {
        const agents = activity.workingIds().flatMap((id) => agentInfo(id) ?? [])
        return {
          mode: current().island,
          working: agents.slice(0, ISLAND_WORKING_MAX),
          count: agents.length,
          attention: waiting[0] ?? null,
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
      const push = (n: Notice, ids?: { callId: string; agentId: string }) =>
        bus.emit("notice", {
          kind: n.kind,
          channelId: n.channelId ?? null,
          title: n.title,
          body: bodyOf(n),
          ...(n.target ? { target: n.target } : {}),
          ...(n.page ? { page: n.page } : {}),
          ...(ids ? { callId: ids.callId, agentId: ids.agentId } : {}),
        })

      const notify = (n: Notice, ids?: { callId: string; agentId: string }, isNew = true) => {
        if (isNew) push(n, ids)
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
        attention: (partial, from) => {
          const agent = agentInfo(partial.agentId)
          if (!agent) return
          const item: WaitingItem = { ...partial, agent }
          const at = waiting.findIndex(
            (w) => w.agentId === item.agentId && w.callId === item.callId,
          )
          if (at >= 0) waiting[at] = item
          else waiting.push(item)
          notify(
            {
              kind: item.kind,
              serverId: item.serverId,
              channelId: item.channelId,
              title: from ? `${item.agent.name} · ${from}` : item.agent.name,
              body: item.summary,
              target: item.target,
            },
            { callId: item.callId, agentId: item.agentId },
            at < 0,
          )
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
