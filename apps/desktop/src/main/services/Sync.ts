import { randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { readFile } from "node:fs/promises"
import { join, sep } from "node:path"
import {
  ATTACH_BYTES,
  askKind,
  askStep,
  askSummary,
  CLOCK_WARN_MS,
  COUNTED_KINDS,
  type DownloadChunk,
  GUARD_DELETE_MIN,
  isSyncKind,
  type MessagePart,
  messageText,
  parseAddress,
  pictureType,
  SYNC_BACKUPS_KEEP,
  SYNC_DECISION_MS,
  SYNC_IDS_PAGE,
  SYNC_MODES,
  SYNC_WIRE,
  type SyncAttention,
  type SyncChangeEntry,
  type SyncCounts,
  type SyncGuard,
  type SyncKind,
  type SyncMode,
  type SyncPreview,
  type SyncRequest,
  type SyncRowState,
  type SyncStatus,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { LinkError } from "../link/client.ts"
import { ageOnArrival } from "../sync/clock.ts"
import { SyncEngine, type Touch } from "../sync/engine.ts"
import { KINDS } from "../sync/kinds.ts"
import {
  MAX_BATCH_BYTES,
  MAX_OP_BYTES,
  type ParsedOp,
  type PushBatch,
  parseBatch,
  type WireOp,
} from "../sync/wire.ts"
import { workspaceFolderName } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Devices } from "./Devices.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { migrations } from "./migrations.ts"
import { Notifier } from "./Notifier.ts"
import { Platform } from "./Platform.ts"
import { secretKey } from "./Providers.ts"
import { Remote } from "./Remote.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"

export interface SyncService {
  /** The sync row of each computer that this computer can open. */
  statuses(): readonly SyncStatus[]
  preview(linkId: string): Effect.Effect<SyncPreview, AppError>
  start(linkId: string, mode: SyncMode): Effect.Effect<SyncStatus, AppError>
  cancelOffer(linkId: string): Effect.Effect<void>
  setPaused(linkId: string, paused: boolean): Effect.Effect<void, AppError>
  stop(linkId: string): Effect.Effect<void, AppError>
  dismiss(linkId: string): Effect.Effect<void>
  requests(): readonly SyncRequest[]
  decide(id: string, allow: boolean): Effect.Effect<void, AppError>
  changes(): readonly SyncChangeEntry[]
  guard(): SyncGuard | null
  decideGuard(remove: boolean): Effect.Effect<void>
  /**
   * Answers an approval or a question of a task that runs on the other computer. The answer goes
   * to that computer (spec 019). False when the card is not one of that kind.
   */
  respond(agentId: string, callId: string, answer: string): Effect.Effect<boolean, AppError>
  /** True when a file of a message is on this computer. */
  fileHere(agentId: string, path: string, size: number, messageId: string): boolean
  /**
   * The bytes of a picture of a message, for the small picture above the message (spec 003).
   * Null when the file is not a kind of picture that shows, or is not here.
   */
  picture(input: {
    agentId: string
    path: string
    size: number
    messageId: string
  }): Promise<Uint8Array | null>
  /** Opens a file of a message. A file that is not here is copied from the computer of the message. */
  openFile(input: {
    agentId: string
    path: string
    size: number
    messageId: string
  }): Effect.Effect<void, AppError>
  /** The computer that is the sync pair, or undefined. */
  peerId(): string | undefined
  /** A request of the other computer. Rejects with an `AppError`. */
  handle(method: string, input: unknown, actorId: string): Promise<unknown>
  /** Runs the pending work now. For tests. */
  flush(): Promise<void>
}

type Phase = "offering" | "copying" | "live"

interface PairRow {
  peer_id: string
  peer_name: string
  role: "start" | "accept"
  mode: SyncMode
  phase: Phase
  paused: number
  ctl: number
  backed_up: number
  stamped: number
  started_at: number
  synced_at: number | null
  out_total: number
  out_done: number
  out_cursor: string
  out_complete: number
  in_total: number
  in_done: number
  in_cursor: string
  in_complete: number
  in_force: number
  applied_seq: number
  clock_offset: number
}

interface Held {
  readonly k: "agent" | "channel"
  readonly i: string
  readonly s: readonly [number, number, string]
}

interface Hello {
  readonly wire: number
  readonly schema: number
  readonly now: number
  readonly ctl: number
  readonly paused: boolean
  readonly paired: boolean
}

const toApp = (error: unknown) =>
  error instanceof AppError
    ? error
    : error instanceof LinkError
      ? new AppError({ code: error.code, ...(error.detail ? { detail: error.detail } : {}) })
      : new AppError({ code: "internal" })

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const readCounts = (v: unknown): SyncCounts | undefined =>
  isObject(v) && isCount(v.agents) && isCount(v.channels) && isCount(v.messages)
    ? { agents: v.agents, channels: v.channels, messages: v.messages }
    : undefined

const SCHEMA = migrations.length
/** How many items one part of the first copy holds, and a pause after each part. Tests turn them. */
const SNAPSHOT_BATCH = Math.max(1, Number(process.env.ROBOT_SYNC_BATCH) || 250)
/** Tests turn the clock that this computer reports to the other one. */
const wall = () => Date.now() + (Number(process.env.ROBOT_SYNC_CLOCK_SKEW_MS) || 0)
/** A message of the other computer that is older than this when it arrives fires no workflow. */
const HEARD_MAX_AGE_MS = 5 * 60_000
const SNAPSHOT_DELAY_MS = Math.max(0, Number(process.env.ROBOT_SYNC_DELAY_MS) || 0)
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve))
const invalid = () => new AppError({ code: "invalid_input" })

export class Sync extends Context.Service<Sync, SyncService>()("robot/main/Sync") {
  static readonly layer = Layer.effect(
    Sync,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const devices = yield* Devices
      const remote = yield* Remote
      const platform = yield* Platform
      const secrets = yield* Secrets
      const settings = yield* SettingsStore
      const servers = yield* Servers
      const data = yield* Data
      const chat = yield* Chat
      const channels = yield* Channels
      const tasks = yield* Tasks
      const tools = yield* Tools
      const notifier = yield* Notifier

      const current = () => Effect.runSync(settings.get)
      const localServerId = () => Effect.runSync(servers.local).id

      const pairRow = () => db.get<PairRow>("SELECT * FROM sync_pair WHERE id = 1")
      let active = pairRow() !== undefined
      const updatePair = (patch: Partial<Record<keyof PairRow, number | string | null>>) => {
        const keys = Object.keys(patch)
        if (keys.length === 0) return
        db.run(
          `UPDATE sync_pair SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`,
          ...keys.map((k) => patch[k as keyof PairRow] as number | string | null),
        )
      }
      const changed = () => {
        bus.emit("sync.changed", {})
        // The switch "Can create and change agents" of the other computer counts as on while the
        // two computers sync (spec 012), so a change of the pair can change what that device may do.
        devices.announceAccess()
      }
      devices.bindSyncLock((id) => {
        const p = pairRow()
        return p !== undefined && p.peer_id === id && p.phase !== "offering"
      })

      const engine = new SyncEngine({
        db,
        self: devices.selfId,
        selfName: () => devices.deviceName(),
        peer: () => {
          const p = pairRow()
          return p ? { id: p.peer_id, name: peerName(p) } : undefined
        },
        localServerId,
        newWorkspace: (name, id) => {
          const root = current().workspaceRoot || platform.defaultWorkspaceRoot
          const dir = join(root, workspaceFolderName(name, id))
          mkdirSync(dir, { recursive: true })
          return dir
        },
        facesDir: join(platform.dataDir, "faces"),
        removeSecret: (accountId) => secrets.remove(secretKey(accountId)),
      })

      const peerName = (p: PairRow) => devices.link(p.peer_id)?.name ?? p.peer_name

      const stateGet = (key: string) =>
        db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = ?", key)?.value
      const stateSet = (key: string, value: string | null) => {
        if (value === null) db.run("DELETE FROM sync_state WHERE key = ?", key)
        else {
          db.run(
            "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            key,
            value,
          )
        }
      }

      // ------------------------------------------------------------------ guard of deletions
      const heldList = (): Held[] => {
        const raw = stateGet("guard")
        return raw ? (JSON.parse(raw) as Held[]) : []
      }
      const setHeld = (list: Held[]) => stateSet("guard", list.length ? JSON.stringify(list) : null)

      // ------------------------------------------------------------------ events for the window
      const touched = (touches: readonly Touch[], live = true) => {
        const serverId = localServerId()
        const seen = new Set<string>()
        const once = (key: string, run: () => void) => {
          if (seen.has(key)) return
          seen.add(key)
          run()
        }
        for (const t of touches) {
          switch (t.kind) {
            case "account":
              once("providers", () => bus.emit("providers.changed", {}))
              once("agents", () => bus.emit("agents.changed", { serverId }))
              break
            case "agent":
              once("agents", () => bus.emit("agents.changed", { serverId }))
              once("places", () => bus.emit("places.changed", { serverId }))
              // A deleted agent also leaves the skills of this computer (spec 017).
              if (t.action === "deleted")
                once("skills", () => bus.emit("skills.changed", { serverId }))
              break
            case "channel":
              once(`channel:${t.id}`, () => bus.emit("channels.changed", { channelId: t.id }))
              once("places", () => bus.emit("places.changed", { serverId }))
              break
            case "memory":
              once(`memory:${t.parent?.id}`, () =>
                bus.emit("memory.changed", { agentId: t.parent?.id ?? "" }),
              )
              break
            case "thread":
              // The list of threads shows in the chat header (spec 003).
              once(`thread:${t.parent?.id}`, () =>
                bus.emit("chat.threads", { agentId: t.parent?.id ?? "" }),
              )
              break
            case "iversion":
              // The instruction history shows in the profile of the agent (spec 002).
              once("agents", () => bus.emit("agents.changed", { serverId }))
              break
            case "hversion":
              // The handbook page shows the newest version and the history (spec 002, 019).
              once("handbook", () => bus.emit("handbook.changed", { serverId }))
              break
            case "routine":
              once("routines", () => bus.emit("routines.changed", { serverId }))
              break
            case "workflow":
            case "wrun":
            case "wstep":
              once("workflows", () => bus.emit("workflows.changed", { serverId }))
              break
            case "task": {
              once("tasks", () => bus.emit("tasks.changed", { serverId }))
              // The state of a part shows in its channel: in review, blocked (spec 004, 019).
              const part = db.get<{ source: string; source_id: string | null }>(
                "SELECT source, source_id FROM task WHERE id = ?",
                t.id,
              )
              const channelId = part?.source === "channel" ? part.source_id : null
              if (channelId)
                once(`channel:${channelId}`, () => bus.emit("channels.changed", { channelId }))
              break
            }
            case "message":
              // A first copy holds a long history: it makes one event, not one for each message.
              if (live && t.action === "deleted") {
                bus.emit("chat.removed", { agentId: t.parent?.id ?? "", messageId: t.id })
              } else if (live) once(`m:${t.id}`, () => chat.announce(t.id))
              if (live) attend("message", t.id)
              once("places", () => bus.emit("places.changed", { serverId }))
              break
            case "cmessage":
              if (live && t.action === "deleted") {
                bus.emit("channel.removed", { channelId: t.parent?.id ?? "", messageId: t.id })
              } else if (live) once(`c:${t.id}`, () => channels.announce(t.id))
              if (live) {
                attend("cmessage", t.id)
                if (t.action === "added") hear(t.id)
              }
              once("places", () => bus.emit("places.changed", { serverId }))
              break
            default:
              once("places", () => bus.emit("places.changed", { serverId }))
          }
        }
        changed()
      }

      // ------------------------------------------------------------------ state
      const versionIssue = new Map<string, "update_this" | "update_other">()
      const clockIssue = new Map<string, number>()
      const needHello = new Set<string>()
      /** The user asked to cancel a request that waits for Allow. */
      const cancelled = new Set<string>()

      const online = (p: PairRow) => remote.stateOf(p.peer_id) === "online"
      const linkOk = (p: PairRow) => {
        const link = devices.link(p.peer_id)
        return link !== undefined && link.kind === "computer" && link.inbound && link.outbound
      }

      // ------------------------------------------------------------------ tasks of the other computer
      /** The name of a computer by its id: the link has it, or this computer kept it. */
      const computerName = (id: string) => devices.link(id)?.name ?? stateGet(`name:${id}`) ?? ""

      /** The name of the computer that runs a task of this agent now, while both are online. */
      const busyOn = (agentId: string): string | null => {
        const p = pairRow()
        if (p?.phase !== "live" || p.paused === 1 || !online(p)) return null
        // A reply of the other computer that still streams here counts as its task: the task row
        // can say done before the end of the reply arrives, and a task that started then would
        // not see that reply.
        const row = db.get<{ x: number }>(
          `SELECT 1 AS x FROM task WHERE agent_id = ? AND origin IS NOT NULL
             AND state IN ('running', 'waiting')
           UNION ALL
           SELECT 1 AS x FROM message WHERE agent_id = ? AND origin IS NOT NULL
             AND status = 'streaming'
           LIMIT 1`,
          agentId,
          agentId,
        )
        return row ? peerName(p) || computerName(p.peer_id) || p.peer_id : null
      }

      const offlineError = (originId: string) =>
        new AppError({ code: "sync_origin_offline", detail: computerName(originId) })

      /** Asks the computer where a task runs to do something, as a linked device does (012). */
      const askOrigin = (originId: string, method: string, input: unknown) =>
        Effect.tryPromise({
          try: async () => {
            if (remote.stateOf(originId) !== "online") throw offlineError(originId)
            return await remote.request(originId, method, input, 15_000)
          },
          catch: (error) => (error instanceof AppError ? error : toApp(error)),
        })

      tasks.setRemote({
        nameOf: (id) => computerName(id),
        busyOn,
        stop: (taskId, originId) =>
          Effect.asVoid(askOrigin(originId, "tasks.stop", { id: taskId })),
      })

      /** The computer where the card of a task that waits was made. */
      const askOriginOf = (agentId: string, callId: string): string | undefined => {
        for (const table of ["message", "channel_message"]) {
          const rows = db.all<{ parts: string; origin: string }>(
            `SELECT parts, origin FROM ${table}
             WHERE agent_id = ? AND origin IS NOT NULL AND status = 'streaming'`,
            agentId,
          )
          for (const r of rows) {
            const parts = JSON.parse(r.parts) as MessagePart[]
            if (parts.some((x) => x.kind === "tool" && x.id === callId && x.state === "waiting"))
              return r.origin
          }
        }
        return undefined
      }

      const respond = (agentId: string, callId: string, answer: string) =>
        Effect.suspend(() => {
          // A card of a task here is answered here.
          if (tools.isWaiting(agentId, callId)) return Effect.succeed(false)
          const origin = askOriginOf(agentId, callId)
          if (origin === undefined) return Effect.succeed(false)
          return askOrigin(origin, "tools.respond", { agentId, callId, answer }).pipe(
            Effect.map(() => {
              notifier.clearAttention(agentId, callId)
              return true
            }),
          )
        })

      // ------------------------------------------------------------------ notices of cards
      /** The cards of messages of the other computer that wait, so a notice can drop. */
      const noticed = new Map<string, { agentId: string; calls: Set<string> }>()

      const attend = (kind: "message" | "cmessage", id: string) => {
        const table = kind === "message" ? "message" : "channel_message"
        const row = db.get<{
          agent_id: string | null
          channel_id?: string
          parts: string
          status: string
          origin: string | null
        }>(
          `SELECT agent_id, ${kind === "cmessage" ? "channel_id," : ""} parts, status, origin
           FROM ${table} WHERE id = ?`,
          id,
        )
        const known = noticed.get(id)
        const calls = new Set<string>()
        if (row?.agent_id && row.origin !== null && row.status === "streaming") {
          const name = computerName(row.origin) || pairRow()?.peer_name || ""
          for (const part of JSON.parse(row.parts) as MessagePart[]) {
            if (part.kind !== "tool" || part.state !== "waiting" || !part.ask) continue
            calls.add(part.id)
            if (known?.calls.has(part.id)) continue
            notifier.attention(
              {
                agentId: row.agent_id,
                serverId: localServerId(),
                channelId: row.channel_id ?? null,
                callId: part.id,
                kind: askKind(part.ask),
                // A computer cannot change what an agent may always do on the other one (019).
                always: false,
                summary: askSummary(part.ask),
                step: askStep(part.ask, part.name),
                target: row.channel_id
                  ? { kind: "channel", id: row.channel_id, messageId: id }
                  : { kind: "agent", id: row.agent_id, messageId: id },
                ...(part.ask.askedAt !== undefined ? { askedAt: part.ask.askedAt } : {}),
              },
              name,
            )
          }
        }
        // A card that was answered, or a message that went, drops its notice.
        const agentId = row?.agent_id ?? known?.agentId
        if (known && agentId) {
          for (const call of known.calls)
            if (!calls.has(call)) notifier.clearAttention(agentId, call)
        }
        if (calls.size > 0 && agentId) noticed.set(id, { agentId, calls })
        else noticed.delete(id)
      }

      /** Looks at every card that waits now: after a first copy and after the app starts. */
      const attendAll = () => {
        if (!pairRow()) return
        for (const [table, kind] of [
          ["message", "message"],
          ["channel_message", "cmessage"],
        ] as const) {
          for (const r of db.all<{ id: string }>(
            `SELECT id FROM ${table} WHERE origin IS NOT NULL AND status = 'streaming'`,
          ))
            attend(kind, r.id)
        }
      }

      /** A message that was sent on the other computer can fire a workflow here (spec 019). */
      const hear = (id: string) => {
        const r = db.get<{
          channel_id: string
          author: string
          origin: string | null
          parts: string
          created_at: number
        }>(
          "SELECT channel_id, author, origin, parts, created_at FROM channel_message WHERE id = ?",
          id,
        )
        if (r?.author !== "user" || r.origin === null) return
        // A message that is older than 5 minutes when it arrives does not fire a workflow. The
        // other computer wrote the time by its own clock, so the age uses the difference between
        // the two clocks that the computers measured when they connected.
        const pair = pairRow()
        const skew = pair?.peer_id === r.origin ? pair.clock_offset : 0
        if (ageOnArrival(r.created_at, wall(), skew) > HEARD_MAX_AGE_MS) return
        channels.hearUserMessage(r.channel_id, messageText({ parts: JSON.parse(r.parts) }))
      }

      // ------------------------------------------------------------------ files of messages
      const ATTACHMENT = /^attachments\/([^/\\]{1,255})$/

      /** The places where a copy of the file of a message can be, in the order that is tried. */
      const fileSpots = (agentId: string, path: string, messageId: string): string[] => {
        const match = ATTACHMENT.exec(path)
        const workspace = db.get<{ workspace: string }>(
          "SELECT workspace FROM agent WHERE id = ?",
          agentId,
        )?.workspace
        if (!match || !workspace || match[1] === "." || match[1] === "..") return []
        const name = match[1] as string
        return [
          join(workspace, "attachments", name),
          // A different file of that name is here: the copy of the other computer has a name of its own.
          join(workspace, "attachments", `from-sync-${messageId.slice(0, 8)}-${name}`),
        ]
      }

      const isFileOf = (spot: string, size: number) => {
        try {
          const real = realpathSync(spot)
          const dir = realpathSync(join(spot, ".."))
          return (
            real.startsWith(dir + sep) && statSync(real).isFile() && statSync(real).size === size
          )
        } catch {
          return false
        }
      }

      const fileHere = (agentId: string, path: string, size: number, messageId: string) =>
        fileSpots(agentId, path, messageId).some((spot) => isFileOf(spot, size))

      const picture = async (input: {
        agentId: string
        path: string
        size: number
        messageId: string
      }): Promise<Uint8Array | null> => {
        if (!pictureType(input.path)) return null
        if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > ATTACH_BYTES)
          return null
        const spot = fileSpots(input.agentId, input.path, input.messageId).find((s) =>
          isFileOf(s, input.size),
        )
        if (!spot) return null
        try {
          return new Uint8Array(await readFile(spot))
        } catch {
          return null
        }
      }

      const copyFile = async (
        originId: string,
        agentId: string,
        path: string,
        size: number,
        target: string,
      ) => {
        if (!Number.isSafeInteger(size) || size < 0 || size > ATTACH_BYTES) {
          throw new AppError({ code: "file_too_large" })
        }
        const theirs =
          db.get<{ peer_id: string }>("SELECT peer_id FROM sync_alias WHERE local_id = ?", agentId)
            ?.peer_id ?? agentId
        mkdirSync(join(target, ".."), { recursive: true })
        // The copy is written beside its place and moved when it is whole.
        const part = `${target}.${randomUUID().slice(0, 8)}.part`
        const fd = openSync(part, "w")
        let offset = 0
        try {
          for (;;) {
            const chunk = (await remote.request(
              originId,
              "attachment.download",
              { agentId: theirs, path, offset },
              30_000,
            )) as DownloadChunk
            if (!isObject(chunk) || typeof chunk.data !== "string") throw invalid()
            const bytes = Buffer.from(chunk.data, "base64")
            offset += bytes.length
            if (offset > ATTACH_BYTES) throw new AppError({ code: "file_too_large" })
            writeSync(fd, bytes)
            if (chunk.done || bytes.length === 0) break
          }
        } catch (error) {
          closeSync(fd)
          rmSync(part, { force: true })
          throw toApp(error)
        }
        closeSync(fd)
        if (offset !== size) {
          rmSync(part, { force: true })
          throw new AppError({ code: "file_unreadable" })
        }
        renameSync(part, target)
      }

      const openFile = (input: {
        agentId: string
        path: string
        size: number
        messageId: string
      }) =>
        Effect.tryPromise({
          try: async () => {
            const spots = fileSpots(input.agentId, input.path, input.messageId)
            if (spots.length === 0) throw new AppError({ code: "invalid_input" })
            const here = spots.find((spot) => isFileOf(spot, input.size))
            if (here) return await platform.openFile(here)
            // Not here: copy it from the computer where the message was made.
            const origin =
              db.get<{ origin: string | null }>(
                "SELECT origin FROM message WHERE id = ?",
                input.messageId,
              )?.origin ?? null
            if (origin === null) throw new AppError({ code: "file_unreadable" })
            if (remote.stateOf(origin) !== "online") {
              throw new AppError({ code: "sync_file_offline", detail: computerName(origin) })
            }
            // The first place is used when it is free, else the second.
            const target = existsSync(spots[0] as string)
              ? (spots[1] as string)
              : (spots[0] as string)
            await copyFile(origin, input.agentId, input.path, input.size, target)
            await platform.openFile(target)
          },
          catch: (error) => (error instanceof AppError ? error : toApp(error)),
        })

      const statusOf = (linkId: string): SyncStatus => {
        const p = pairRow()
        const base: SyncStatus = {
          linkId,
          state: "off",
          attention: null,
          ownSwitchOff: false,
          mode: null,
          done: 0,
          total: 0,
          lastSyncedAt: null,
          denied: stateGet(`denied:${linkId}`) !== undefined,
          stoppedBy: stateGet(`stopped:${linkId}`) !== undefined,
          clockMinutes: 0,
          deletions: 0,
        }
        if (!p || p.peer_id !== linkId) return base
        const held = heldList()
        const issue = versionIssue.get(linkId)
        const skew = clockIssue.get(linkId) ?? 0
        let attention: SyncAttention | null = null
        if (issue) attention = issue
        else if (held.length > 0) attention = "deletions"
        else if (Math.abs(skew) > CLOCK_WARN_MS) attention = "clock"
        let state: SyncRowState
        if (p.phase === "offering") state = "offered"
        else if (attention) state = "attention"
        else if (p.paused) state = "paused"
        else if (p.phase === "copying") state = "copying"
        else if (!online(p) || !current().acceptLinks) state = "waiting"
        else state = "live"
        return {
          ...base,
          state,
          attention,
          ownSwitchOff: !current().acceptLinks,
          mode: p.mode,
          done: p.out_done + p.in_done,
          total: p.out_total + p.in_total,
          lastSyncedAt: p.synced_at,
          denied: false,
          stoppedBy: false,
          clockMinutes: Math.round(Math.abs(skew) / 60_000),
          deletions: held.length,
        }
      }

      // ------------------------------------------------------------------ counts and ids
      const counts = (): SyncCounts => ({
        agents: KINDS.agent.count(db),
        channels: KINDS.channel.count(db),
        messages: KINDS.message.count(db) + KINDS.cmessage.count(db),
      })

      const localIds = (kind: SyncKind) => {
        const out = new Set<string>()
        let after = ""
        for (;;) {
          const page = KINDS[kind].ids(db, after, 2000)
          for (const id of page) out.add(id)
          if (page.length < 2000) break
          after = page[page.length - 1] as string
        }
        return out
      }

      const peerIds = async (linkId: string, kind: SyncKind) => {
        const out = new Set<string>()
        let after = ""
        for (;;) {
          const reply = (await remote.request(linkId, "sync.ids", { kind, after })) as {
            ids?: unknown
            more?: unknown
          }
          if (!Array.isArray(reply.ids) || reply.ids.length > SYNC_IDS_PAGE) throw invalid()
          for (const id of reply.ids) {
            if (typeof id !== "string" || id.length > 200) throw invalid()
            out.add(id)
          }
          if (reply.more !== true || reply.ids.length === 0) break
          after = reply.ids[reply.ids.length - 1] as string
        }
        return out
      }

      /** How many items only one of the computers holds. Only the kinds a user knows by name count. */
      const diff = async (linkId: string) => {
        let onlyHere = 0
        let onlyThere = 0
        for (const kind of COUNTED_KINDS) {
          const here = localIds(kind)
          const there = await peerIds(linkId, kind)
          for (const id of here) if (!there.has(id)) onlyHere++
          for (const id of there) if (!here.has(id)) onlyThere++
        }
        return { onlyHere, onlyThere }
      }

      const outboundLink = (linkId: string) => {
        const link = devices.link(linkId)
        if (!link?.outbound || link.kind !== "computer") {
          throw new AppError({ code: "server_not_found" })
        }
        return link
      }

      // ------------------------------------------------------------------ the pair
      const flagsFor = (role: "start" | "accept", mode: SyncMode) => {
        const sends = mode === "merge" || (mode === "take" ? role === "accept" : role === "start")
        const receives =
          mode === "merge" || (mode === "take" ? role === "start" : role === "accept")
        return {
          out_complete: sends ? 0 : 1,
          in_complete: receives ? 0 : 1,
          in_force: mode !== "merge" && receives ? 1 : 0,
        }
      }

      const begin = (peerId: string, name: string, role: "start" | "accept", mode: SyncMode) => {
        const f = flagsFor(role, mode)
        db.run("DELETE FROM sync_pair")
        engine.wipe()
        setHeld([])
        db.run(
          `INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at, out_complete, in_complete, in_force)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          peerId,
          name,
          role,
          mode,
          role === "start" ? "offering" : "copying",
          Date.now(),
          f.out_complete,
          f.in_complete,
          f.in_force,
        )
        stateSet(`denied:${peerId}`, null)
        stateSet(`stopped:${peerId}`, null)
        // The name stays known when the link is gone, for the tasks that this computer ran.
        stateSet(`name:${peerId}`, name)
        active = true
        needHello.add(peerId)
        changed()
      }

      /** After a stop, what ran on the other computer will not end by itself: it ends here. */
      const letGo = (peerId: string) => {
        const now = Date.now()
        db.run(
          `UPDATE task SET state = 'failed', error_code = 'sync_stopped', error_detail = ?, finished_at = ?
           WHERE origin IS NOT NULL AND state IN ('queued', 'running', 'waiting')`,
          computerName(peerId),
          now,
        )
        for (const [table, announce] of [
          ["message", (id: string) => chat.announce(id)],
          ["channel_message", (id: string) => channels.announce(id)],
        ] as const) {
          const ids = db.all<{ id: string }>(
            `SELECT id FROM ${table} WHERE origin IS NOT NULL AND status = 'streaming'`,
          )
          db.run(
            `UPDATE ${table} SET status = 'stopped' WHERE origin IS NOT NULL AND status = 'streaming'`,
          )
          for (const r of ids) announce(r.id)
        }
        for (const [id, known] of noticed) {
          for (const call of known.calls) notifier.clearAttention(known.agentId, call)
          noticed.delete(id)
        }
        bus.emit("tasks.changed", { serverId: localServerId() })
      }

      const stopLocal = (reason: "user" | "peer" | "link" | "none") => {
        const p = pairRow()
        if (!p) return
        engine.markStopped()
        engine.wipe()
        setHeld([])
        db.run("DELETE FROM sync_pair")
        active = false
        letGo(p.peer_id)
        versionIssue.delete(p.peer_id)
        clockIssue.delete(p.peer_id)
        needHello.delete(p.peer_id)
        if (reason === "peer") stateSet(`stopped:${p.peer_id}`, "1")
        changed()
      }

      const check = () => {
        const p = pairRow()
        if (!p || p.phase === "offering") return
        if (!linkOk(p)) stopLocal("link")
      }
      devices.onLinks(check)
      remote.onRemoved(check)
      remote.onOnline((linkId) => {
        needHello.add(linkId)
        schedule(0)
        changed()
      })

      // A request that never got an answer before the app closed is gone.
      if (pairRow()?.phase === "offering") {
        db.run("DELETE FROM sync_pair")
        engine.wipe()
        active = false
      }

      // ------------------------------------------------------------------ backups
      const backup = async () => {
        const dir = join(platform.dataDir, "backups")
        mkdirSync(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        await Effect.runPromise(data.backup(join(dir, `sync-${stamp}.zip`)))
        const old = readdirSync(dir)
          .filter((f) => /^sync-.*\.zip$/.test(f))
          .sort()
        for (const file of old.slice(0, Math.max(0, old.length - SYNC_BACKUPS_KEEP))) {
          rmSync(join(dir, file), { force: true })
        }
      }

      // ------------------------------------------------------------------ the pump
      let running = false
      let again = false
      /** True after the layer closed. The database is closed too, so no step can run or be logged. */
      let closed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      function schedule(ms = 150) {
        if (!active || closed || timer) return
        timer = setTimeout(() => {
          timer = undefined
          void pump()
        }, ms)
      }
      // A change gets its stamp when it is made, not when it is sent: the later edit of two
      // wins, also when the pump of the other computer ran first.
      let recording = false
      const recordSoon = () => {
        if (recording) return
        recording = true
        queueMicrotask(() => {
          recording = false
          if (!active) return
          try {
            if (engine.flush(200)) setImmediate(recordSoon)
          } catch (error) {
            console.error("sync record failed", error)
          }
        })
      }
      db.onWrite(() => {
        if (!active) return
        recordSoon()
        schedule()
      })
      const interval = setInterval(() => schedule(0), 3000)
      interval.unref?.()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true
          clearInterval(interval)
          if (timer) clearTimeout(timer)
          for (const r of pending.values()) {
            clearTimeout(r.timer)
            r.resolve(false)
          }
        }),
      )

      const pump = async () => {
        if (running) {
          again = true
          return
        }
        running = true
        try {
          do {
            again = false
            try {
              await step()
            } catch (error) {
              // A step that was still running when the layer closed fails on the closed database.
              if (!closed) console.error("sync step failed", error)
            }
          } while (again && !closed)
        } finally {
          running = false
        }
      }

      const hello = async (p: PairRow): Promise<boolean> => {
        const mine: Omit<Hello, "paired"> = {
          wire: SYNC_WIRE,
          schema: SCHEMA,
          now: wall(),
          ctl: p.ctl,
          paused: p.paused === 1,
        }
        const sentAt = wall()
        let reply: Hello
        try {
          reply = readHello(await remote.request(p.peer_id, "sync.hello", mine, 10_000))
        } catch (error) {
          if (error instanceof LinkError && error.code === "update_app") {
            versionIssue.set(p.peer_id, error.detail === "this" ? "update_this" : "update_other")
            changed()
          }
          return false
        }
        if (reply.wire !== SYNC_WIRE || reply.schema !== SCHEMA) {
          const newer = reply.wire > SYNC_WIRE || reply.schema > SCHEMA
          versionIssue.set(p.peer_id, newer ? "update_this" : "update_other")
          changed()
          return false
        }
        versionIssue.delete(p.peer_id)
        if (!reply.paired) {
          stopLocal("peer")
          return false
        }
        const skew = reply.now - (sentAt + wall()) / 2
        clockIssue.set(p.peer_id, skew)
        updatePair({ clock_offset: Math.round(skew) })
        if (reply.ctl > p.ctl) {
          updatePair({ ctl: reply.ctl, paused: reply.paused ? 1 : 0 })
        } else if (p.ctl > reply.ctl) {
          await remote
            .request(p.peer_id, "sync.control", { paused: p.paused === 1, ctl: p.ctl }, 10_000)
            .catch(() => undefined)
        }
        changed()
        return true
      }

      const readHello = (raw: unknown): Hello => {
        if (
          !isObject(raw) ||
          !isCount(raw.wire) ||
          !isCount(raw.schema) ||
          typeof raw.now !== "number" ||
          !Number.isFinite(raw.now) ||
          !isCount(raw.ctl) ||
          typeof raw.paused !== "boolean" ||
          typeof raw.paired !== "boolean"
        ) {
          throw invalid()
        }
        return raw as unknown as Hello
      }

      const step = async () => {
        let p = pairRow()
        if (!p || p.phase === "offering") return
        if (!linkOk(p)) return stopLocal("link")
        // Changes are recorded also while the other computer is away or the sync is paused.
        while (engine.flush()) await yieldNow()
        if (p.phase === "copying") {
          if (!p.backed_up) {
            await backup()
            updatePair({ backed_up: 1 })
          }
          p = pairRow() ?? p
          if (!p.stamped) {
            for (const _ of engine.stampAll()) await yieldNow()
            const sends = p.out_complete === 0
            updatePair({ stamped: 1, out_total: sends ? engine.snapshotTotal() : 0 })
            changed()
          }
        }
        p = pairRow()
        if (!p || p.phase === "offering") return
        if (p.phase === "copying" && p.out_complete === 1 && p.in_complete === 1) finishCopy()
        p = pairRow()
        if (!p || p.paused || !online(p) || !current().acceptLinks) {
          if (p) changed()
          return
        }
        if (needHello.has(p.peer_id)) {
          if (!(await hello(p))) return
          needHello.delete(p.peer_id)
          p = pairRow()
          if (!p || p.paused) return
        }
        if (versionIssue.has(p.peer_id)) return
        await send(p)
      }

      const finishCopy = () => {
        engine.settleInitial()
        // The channels came in parts, so the tree is checked now that the copy is whole (spec 030,
        // "Repair").
        const repaired = engine.repairTree()
        updatePair({ phase: "live", synced_at: Date.now() })
        attendAll()
        touched(repaired)
        changed()
      }

      const classify = (error: unknown): "wait" | "retry" | "invalid" | "version" => {
        if (error instanceof LinkError) {
          if (error.code === "paused" || error.code === "not_ready") return "retry"
          if (error.code === "invalid_input") return "invalid"
          if (error.code === "update_app") return "version"
        }
        return "wait"
      }

      /** Sends ops. Returns false when sending must stop for now. */
      const push = async (p: PairRow, batch: PushBatch): Promise<boolean> => {
        try {
          await remote.request(p.peer_id, "sync.push", batch, 60_000)
          return true
        } catch (error) {
          const kind = classify(error)
          if (kind === "version") {
            versionIssue.set(
              p.peer_id,
              (error as LinkError).detail === "this" ? "update_this" : "update_other",
            )
            changed()
          } else if (kind === "retry") {
            needHello.add(p.peer_id)
            schedule(1000)
          } else if (kind === "invalid") {
            throw error
          }
          return false
        }
      }

      const send = async (start: PairRow) => {
        let p = start
        // The first copy.
        while (p.out_complete === 0 && p.stamped === 1) {
          const batch = engine.snapshotBatch(p.out_cursor, SNAPSHOT_BATCH, 1_500_000)
          const body: PushBatch = {
            ops: batch.ops,
            snap: { total: p.out_total, done: batch.done, cursor: batch.cursor },
          }
          if (!(await push(p, body))) return
          updatePair({
            out_cursor: batch.cursor,
            out_done: Math.min(p.out_total, p.out_done + batch.ops.length),
            out_complete: batch.done ? 1 : 0,
          })
          changed()
          p = pairRow() ?? p
          if (!pairRow() || p.paused) return
          if (SNAPSHOT_DELAY_MS > 0) await new Promise((r) => setTimeout(r, SNAPSHOT_DELAY_MS))
          else await yieldNow()
        }
        if (p.phase === "copying" && p.out_complete === 1 && p.in_complete === 1) finishCopy()
        if (p.out_complete === 0) return
        // Changes made since.
        for (;;) {
          while (engine.flush()) await yieldNow()
          const items = engine.pending(500, MAX_BATCH_BYTES)
          if (items.length === 0) break
          const sendable = items.filter((i) => {
            if (JSON.stringify(i.op).length <= MAX_OP_BYTES) return true
            engine.discard(i)
            return false
          })
          if (sendable.length === 0) continue
          let ok: boolean
          try {
            ok = await push(p, { ops: sendable.map((i) => i.op) })
          } catch {
            // The other computer refuses something in this part: find the item and drop it.
            ok = true
            if (sendable.length === 1) {
              engine.discard(sendable[0] as (typeof sendable)[number])
              console.error("sync: the other computer refused a change", sendable[0]?.kind)
            } else {
              for (const one of sendable) {
                try {
                  await remote.request(p.peer_id, "sync.push", { ops: [one.op] }, 60_000)
                  engine.ack([one])
                } catch (error) {
                  if (classify(error) === "invalid") engine.discard(one)
                  else return
                }
              }
              continue
            }
          }
          if (!ok) return
          engine.ack(sendable)
          if (engine.pendingCount() === 0) {
            updatePair({ synced_at: Date.now() })
            changed()
          }
          p = pairRow() ?? p
          if (!pairRow() || p.paused) return
          await yieldNow()
        }
        updatePair({ synced_at: Date.now() })
        changed()
      }

      // ------------------------------------------------------------------ receiving
      const heldFrom = (ops: readonly ParsedOp[]) => {
        const keep: ParsedOp[] = []
        const hold: ParsedOp[] = []
        const guarded = (op: ParsedOp) =>
          op.deleted !== undefined &&
          (op.kind === "agent" || op.kind === "channel") &&
          KINDS[op.kind].read(engine.ctx, op.id) !== undefined
        const candidates = ops.filter(guarded)
        const already = heldList()
        const doHold = already.length > 0 || already.length + candidates.length >= GUARD_DELETE_MIN
        for (const op of ops) (doHold && guarded(op) ? hold : keep).push(op)
        return { keep, hold }
      }

      const receive = (p: PairRow, raw: unknown) => {
        const parsed = parseBatch(raw, Date.now())
        if (!parsed) throw invalid()
        if (p.paused) throw new AppError({ code: "paused" })
        if (!p.backed_up || !p.stamped || p.phase === "offering") {
          throw new AppError({ code: "not_ready" })
        }
        if (parsed.snap && p.in_complete === 1 && p.phase === "live") {
          // A part that arrives after the copy ended is a repeat. It does no harm.
        }
        const { keep, hold } = heldFrom(parsed.ops)
        if (hold.length > 0) {
          const list = heldList()
          for (const op of hold) {
            if (!op.deleted) continue
            engine.clock.observe(op.deleted)
            if (!list.some((h) => h.k === op.kind && h.i === op.id)) {
              list.push({
                k: op.kind as "agent" | "channel",
                i: op.id,
                s: [op.deleted.l, op.deleted.c, op.deleted.n],
              })
            }
          }
          setHeld(list)
        }
        const result = engine.apply(keep, {
          force: p.in_force === 1 && parsed.snap !== undefined,
          snapshot: parsed.snap !== undefined,
        })
        let top = p.applied_seq
        for (const op of parsed.ops) if (op.seq !== undefined && op.seq > top) top = op.seq
        const patch: Partial<Record<keyof PairRow, number | string | null>> = {
          applied_seq: top,
          synced_at: Date.now(),
        }
        if (parsed.snap) {
          patch.in_total = parsed.snap.total
          patch.in_done = Math.min(parsed.snap.total, p.in_done + parsed.ops.length)
          patch.in_cursor = parsed.snap.cursor
          if (parsed.snap.done) {
            if (p.in_force === 1) engine.prune()
            patch.in_complete = 1
            patch.in_done = parsed.snap.total
          }
        }
        updatePair(patch)
        const now = pairRow()
        if (now && now.phase === "copying" && now.out_complete === 1 && now.in_complete === 1) {
          finishCopy()
        }
        touched(result.touches, parsed.snap === undefined)
        if (parsed.refused > 0) console.error("sync: refused changes", parsed.refused)
        // Changes that came in are not news to the other computer.
        return { applied: result.applied, dropped: result.dropped, refused: parsed.refused }
      }

      // ------------------------------------------------------------------ requests of the peer
      interface PendingRequest {
        readonly request: SyncRequest
        readonly peerId: string
        readonly mode: SyncMode
        readonly timer: ReturnType<typeof setTimeout>
        resolve(allow: boolean): void
      }
      const pending = new Map<string, PendingRequest>()

      const readAddresses = (v: unknown): string[] | undefined => {
        if (!Array.isArray(v) || v.length === 0 || v.length > 8) return undefined
        const list: string[] = []
        for (const a of v) {
          if (typeof a !== "string" || a.length > 200 || !parseAddress(a)) return undefined
          list.push(a)
        }
        return list
      }

      const offered = async (actorId: string, input: unknown): Promise<{ allow: boolean }> => {
        if (!isObject(input)) throw invalid()
        const link = devices.link(actorId)
        if (link?.kind !== "computer" || !link.inbound) {
          throw new AppError({ code: "not_allowed" })
        }
        const mode = input.mode
        const there = readCounts(input.counts)
        if (
          !SYNC_MODES.includes(mode as SyncMode) ||
          !there ||
          !isCount(input.wire) ||
          !isCount(input.schema) ||
          !isCount(input.drops)
        ) {
          throw invalid()
        }
        if (input.wire !== SYNC_WIRE || input.schema !== SCHEMA) {
          const newer = input.wire > SYNC_WIRE || input.schema > SCHEMA
          throw new AppError({ code: "update_app", detail: newer ? "this" : "other" })
        }
        let reverse: { addresses: string[]; serverId: string } | undefined
        if (input.reverse !== undefined) {
          const r = input.reverse
          const addresses = isObject(r) ? readAddresses(r.addresses) : undefined
          if (
            !isObject(r) ||
            !addresses ||
            typeof r.serverId !== "string" ||
            r.serverId.length === 0 ||
            r.serverId.length > 100
          ) {
            throw invalid()
          }
          reverse = { addresses, serverId: r.serverId }
        }
        if (!link.outbound && !reverse) throw new AppError({ code: "unreachable" })

        const existing = pairRow()
        if (existing && existing.peer_id !== actorId) throw new AppError({ code: "sync_busy" })
        for (const [id, r] of pending) {
          if (r.peerId === actorId) {
            clearTimeout(r.timer)
            r.resolve(false)
            pending.delete(id)
          }
        }
        const id = randomUUID()
        const request: SyncRequest = {
          id,
          name: link.name,
          mode: mode as SyncMode,
          here: counts(),
          there,
          drops: mode === "send" ? input.drops : 0,
        }
        const allow = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), SYNC_DECISION_MS)
          pending.set(id, { request, peerId: actorId, mode: mode as SyncMode, timer, resolve })
          bus.emit("sync.request", { request })
          platform.showWindow()
        })
        const entry = pending.get(id)
        if (entry) clearTimeout(entry.timer)
        pending.delete(id)
        bus.emit("sync.request", { closed: id })
        if (!allow) return { allow: false }
        // The link may have changed while the user decided.
        const now = devices.link(actorId)
        if (!now?.inbound) throw new AppError({ code: "not_allowed" })
        if (!now.outbound && reverse) {
          if (!devices.setOutboundFor(actorId, reverse)) throw new AppError({ code: "unreachable" })
        }
        if (pairRow()) stopLocal("none")
        begin(actorId, now.name, "accept", mode as SyncMode)
        schedule(0)
        return { allow: true }
      }

      const handle = async (method: string, input: unknown, actorId: string): Promise<unknown> => {
        const link = devices.link(actorId)
        if (link?.kind !== "computer" || !link.inbound) {
          throw new AppError({ code: "not_allowed" })
        }
        switch (method) {
          case "sync.hello": {
            if (
              !isObject(input) ||
              !isCount(input.wire) ||
              !isCount(input.schema) ||
              !isCount(input.ctl) ||
              typeof input.paused !== "boolean"
            ) {
              throw invalid()
            }
            const p = pairRow()
            const paired = p?.peer_id === actorId && p.phase !== "offering"
            if (p && paired && input.wire === SYNC_WIRE && input.schema === SCHEMA) {
              if (input.ctl > p.ctl) {
                updatePair({ ctl: input.ctl, paused: input.paused ? 1 : 0 })
                changed()
              }
            }
            return {
              wire: SYNC_WIRE,
              schema: SCHEMA,
              now: wall(),
              ctl: pairRow()?.ctl ?? 0,
              paused: pairRow()?.paused === 1,
              paired,
            } satisfies Hello
          }
          case "sync.counts":
            return counts()
          case "sync.ids": {
            if (!isObject(input) || !isSyncKind(input.kind) || typeof input.after !== "string") {
              throw invalid()
            }
            if (!COUNTED_KINDS.includes(input.kind) || input.after.length > 200) throw invalid()
            const ids = KINDS[input.kind].ids(db, input.after, SYNC_IDS_PAGE + 1)
            return { ids: ids.slice(0, SYNC_IDS_PAGE), more: ids.length > SYNC_IDS_PAGE }
          }
          case "sync.offer":
            return offered(actorId, input)
          case "sync.cancel": {
            for (const [id, r] of pending) {
              if (r.peerId !== actorId) continue
              clearTimeout(r.timer)
              r.resolve(false)
              pending.delete(id)
            }
            return {}
          }
        }
        const p = pairRow()
        if (!p || p.peer_id !== actorId || p.phase === "offering") {
          throw new AppError({ code: "not_allowed" })
        }
        switch (method) {
          case "sync.push":
            return receive(p, input)
          case "sync.control": {
            if (!isObject(input) || typeof input.paused !== "boolean" || !isCount(input.ctl)) {
              throw invalid()
            }
            if (input.ctl > p.ctl) {
              updatePair({ ctl: input.ctl, paused: input.paused ? 1 : 0 })
              changed()
              schedule(0)
            }
            return {}
          }
          case "sync.stop":
            stopLocal("peer")
            return {}
        }
        throw new AppError({ code: "unknown_method" })
      }

      // ------------------------------------------------------------------ the user's side
      const preview = async (linkId: string): Promise<SyncPreview> => {
        const link = outboundLink(linkId)
        if (remote.stateOf(linkId) !== "online") throw new AppError({ code: "offline" })
        const there = readCounts(await remote.request(linkId, "sync.counts"))
        if (!there) throw invalid()
        const { onlyHere, onlyThere } = await diff(linkId)
        return {
          peerName: link.name,
          here: counts(),
          there,
          onlyHere,
          onlyThere,
          oneWay: !link.inbound,
        }
      }

      const startSync = async (linkId: string, mode: SyncMode): Promise<SyncStatus> => {
        const link = outboundLink(linkId)
        if (!SYNC_MODES.includes(mode)) throw invalid()
        if (pairRow()) throw new AppError({ code: "sync_busy" })
        if (remote.stateOf(linkId) !== "online") throw new AppError({ code: "offline" })
        const { onlyThere } = await diff(linkId)
        const wasOn = current().acceptLinks
        const oneWay = !link.inbound
        const revert = async () => {
          if (!oneWay) return
          devices.setInbound(linkId, false)
          if (!wasOn) await devices.setAccept(false)
        }
        let reverse: { addresses: string[]; serverId: string } | undefined
        if (oneWay) {
          await devices.setAccept(true)
          const addresses = devices.addresses().map((a) => a.address)
          if (addresses.length === 0) {
            await revert()
            throw new AppError({ code: "unreachable" })
          }
          devices.setInbound(linkId, true)
          reverse = { addresses, serverId: localServerId() }
        }
        begin(linkId, link.name, "start", mode)
        cancelled.delete(linkId)
        let answer: unknown
        try {
          answer = await remote.request(
            linkId,
            "sync.offer",
            {
              wire: SYNC_WIRE,
              schema: SCHEMA,
              mode,
              counts: counts(),
              drops: onlyThere,
              ...(reverse ? { reverse } : {}),
            },
            SYNC_DECISION_MS + 10_000,
          )
        } catch (error) {
          const wasCancelled = cancelled.delete(linkId)
          if (pairRow()?.phase === "offering") {
            db.run("DELETE FROM sync_pair")
            engine.wipe()
            active = false
          }
          await revert()
          changed()
          if (wasCancelled) return statusOf(linkId)
          if (error instanceof LinkError && error.code === "update_app") {
            versionIssue.set(linkId, error.detail === "this" ? "update_this" : "update_other")
          }
          throw toApp(error)
        }
        const allow = isObject(answer) && answer.allow === true
        const wasCancelled = cancelled.delete(linkId)
        const p = pairRow()
        if (p?.phase !== "offering" || p.peer_id !== linkId || wasCancelled) {
          if (p?.phase === "offering" && p.peer_id === linkId) {
            db.run("DELETE FROM sync_pair")
            engine.wipe()
            active = false
          }
          if (allow) await remote.request(linkId, "sync.stop", {}, 5_000).catch(() => undefined)
          await revert()
          changed()
          return statusOf(linkId)
        }
        if (!allow) {
          db.run("DELETE FROM sync_pair")
          engine.wipe()
          active = false
          stateSet(`denied:${linkId}`, "1")
          await revert()
          changed()
          return statusOf(linkId)
        }
        updatePair({ phase: "copying" })
        needHello.add(linkId)
        changed()
        schedule(0)
        return statusOf(linkId)
      }

      const asEffect = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toApp })

      // Cards of the other computer that wait when the app starts show their notice again.
      attendAll()

      return Sync.of({
        statuses: () =>
          devices
            .outbound()
            .filter((l) => l.kind === "computer")
            .map((l) => statusOf(l.id)),
        preview: (linkId) => asEffect(() => preview(linkId)),
        start: (linkId, mode) => asEffect(() => startSync(linkId, mode)),
        cancelOffer: (linkId) =>
          Effect.promise(async () => {
            const p = pairRow()
            if (!p || p.peer_id !== linkId || p.phase !== "offering") return
            cancelled.add(linkId)
            await remote.request(linkId, "sync.cancel", {}, 5_000).catch(() => undefined)
          }),
        setPaused: (linkId, paused) =>
          asEffect(async () => {
            const p = pairRow()
            if (!p || p.peer_id !== linkId || p.phase === "offering") {
              throw new AppError({ code: "sync_off" })
            }
            const ctl = p.ctl + 1
            updatePair({ paused: paused ? 1 : 0, ctl })
            changed()
            await remote
              .request(linkId, "sync.control", { paused, ctl }, 10_000)
              .catch(() => undefined)
            schedule(0)
          }),
        stop: (linkId) =>
          asEffect(async () => {
            const p = pairRow()
            if (!p || p.peer_id !== linkId) return
            await remote.request(linkId, "sync.stop", {}, 5_000).catch(() => undefined)
            stopLocal("user")
          }),
        dismiss: (linkId) =>
          Effect.sync(() => {
            stateSet(`denied:${linkId}`, null)
            stateSet(`stopped:${linkId}`, null)
            changed()
          }),
        requests: () => [...pending.values()].map((r) => r.request),
        decide: (id, allow) =>
          Effect.suspend(() => {
            const r = pending.get(id)
            if (!r) return Effect.fail(new AppError({ code: "join_gone" }))
            r.resolve(allow)
            return Effect.void
          }),
        changes: () => engine.changes(),
        guard: () => {
          const held = heldList()
          const p = pairRow()
          return held.length > 0 && p ? { peerName: peerName(p), count: held.length } : null
        },
        decideGuard: (remove) =>
          Effect.sync(() => {
            const held = heldList()
            if (held.length === 0) return
            setHeld([])
            if (remove) {
              const ops: ParsedOp[] = held.map((h) => ({
                kind: h.k,
                id: h.i,
                deleted: { l: h.s[0], c: h.s[1], n: h.s[2] },
                fields: new Map(),
                seq: undefined,
                seen: 0,
                origin: undefined,
              }))
              touched(engine.apply(ops, { force: false, snapshot: false }).touches)
            } else {
              for (const h of held) engine.revive(h.k, h.i)
              schedule(0)
            }
            changed()
          }),
        peerId: () => pairRow()?.peer_id,
        respond,
        fileHere,
        picture,
        openFile,
        handle,
        flush: async () => {
          await pump()
        },
      })
    }),
  )
}

export type { WireOp }
