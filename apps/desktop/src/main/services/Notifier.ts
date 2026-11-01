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
  type PlaceTarget,
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
  readonly target: PlaceTarget
}

export interface WaitingItem extends IslandAttention {
  readonly serverId: string
  readonly channelId: string | null
}

export interface NotifierService {
  /** A system notification, when the kind is on, the place is not muted and no window has focus. */
  notify(notice: Notice): void
  /** An approval or a question waits: a notification and the island card. */
  attention(item: Omit<WaitingItem, "agent">): void
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

      const notify = (n: Notice) => {
        if (!current().notifyKinds[n.kind]) return
        if (platform.isFocused()) return
        if (isMuted(mutes(), n.serverId, n.channelId ?? null, Date.now())) return
        platform.notify({ title: n.title, body: cut(n.body) }, () => {
          platform.showWindow()
          bus.emit("app.openPlace", n.target)
        })
      }

      return Notifier.of({
        notify,
        attention: (partial) => {
          const agent = agentInfo(partial.agentId)
          if (!agent) return
          const item: WaitingItem = { ...partial, agent }
          const at = waiting.findIndex(
            (w) => w.agentId === item.agentId && w.callId === item.callId,
          )
          if (at >= 0) waiting[at] = item
          else waiting.push(item)
          notify({
            kind: item.kind,
            serverId: item.serverId,
            channelId: item.channelId,
            title: item.agent.name,
            body: item.summary,
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
