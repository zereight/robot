import { randomUUID } from "node:crypto"
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import {
  ACCESS_EVENT,
  ATTACH_BYTES,
  ATTACH_MAX,
  type ConnectProbe,
  type DownloadChunk,
  FILE_CHUNK,
  isCachedMethod,
  isPairCode,
  isRoutedMethod,
  LINK_PROTOCOL,
  type LinkState,
  MAX_SERVERS,
  numberedNames,
  parseAddress,
  parseLink,
  type RpcResult,
  type Server,
  type ServerEntry,
  UPLOAD_PREFIX,
  type UploadAck,
  type WireNotice,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { cacheKey, LinkCache } from "../link/cache.ts"
import type { Conn, SecureChannel } from "../link/channel.ts"
import { LinkError, openAny, pairWithCode } from "../link/client.ts"
import { Connection } from "../link/connection.ts"
import { deviceIdOf, fromB64 } from "../link/identity.ts"
import { DECISION_MS, type PairMessage, toPairDevice } from "../link/protocol.ts"
import { Devices, type LinkRow } from "./Devices.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Notifier } from "./Notifier.ts"
import { Platform } from "./Platform.ts"
import { Servers } from "./Servers.ts"

export interface RemoteService {
  /** Step one of "Connect to a computer": proves the code and shows who answers. */
  probe(input: {
    link?: string | undefined
    address?: string | undefined
    code?: string | undefined
  }): Effect.Effect<ConnectProbe, AppError>
  /** Step two: asks the computer to allow this device. */
  finish(session: string, twoWay: boolean): Effect.Effect<ServerEntry, AppError>
  cancel(session: string): Effect.Effect<void>
  /** The computers this computer can open, with their connection states. */
  entries(): readonly ServerEntry[]
  /** The linked computers as servers of the rail. */
  servers(): readonly Server[]
  /** Ends the link and closes the connection. */
  remove(linkId: string): Effect.Effect<void>
  /** Tries to reach a server now, when it is not online. */
  retry(serverId: string): void
  /** The link of a server id, if this computer can open it. */
  linkOfServer(serverId: string): LinkRow | undefined
  stateOf(linkId: string): LinkState
  /** Asks a linked server. Rejects with a `LinkError`. */
  request(linkId: string, method: string, input?: unknown, ms?: number): Promise<unknown>
  /**
   * A call of the window for a linked server. It goes over the link when the server is online,
   * and reads come from the cache when it is not. Never rejects.
   */
  invoke(serverId: string, method: string, input: unknown): Promise<RpcResult<unknown>>
  /** Calls `handler` for every event that a linked server pushes. */
  onEvent(handler: (linkId: string, event: string, payload: unknown) => void): void
  /** Calls `handler` when a link ends, so its cache can go. */
  onRemoved(handler: (linkId: string) => void): void
  /** Calls `handler` when a server goes online. */
  onOnline(handler: (linkId: string) => void): void
}

interface Probe {
  readonly conn: Conn
  readonly channel: SecureChannel
  readonly hello: Extract<PairMessage, { type: "hello" }>
  readonly address: string
  readonly invited: readonly string[]
  readonly timer: ReturnType<typeof setTimeout>
  answer?: Promise<PairMessage>
}

const toAppError = (error: unknown) =>
  error instanceof AppError
    ? error
    : error instanceof LinkError
      ? new AppError({ code: error.code, ...(error.detail ? { detail: error.detail } : {}) })
      : new AppError({ code: "unreachable" })

export class Remote extends Context.Service<Remote, RemoteService>()("robot/main/Remote") {
  static readonly layer = Layer.effect(
    Remote,
    Effect.gen(function* () {
      const devices = yield* Devices
      const bus = yield* EventBus
      const servers = yield* Servers
      const platform = yield* Platform
      const notifier = yield* Notifier
      const identity = devices.identity
      const cache = new LinkCache(join(platform.dataDir, "link-cache"))

      const connections = new Map<string, Connection>()
      const sides = new Map<string, "this" | "server" | null>()
      const eventHandlers: ((linkId: string, event: string, payload: unknown) => void)[] = []
      const removedHandlers: ((linkId: string) => void)[] = []
      const onlineHandlers: ((linkId: string) => void)[] = []
      const probes = new Map<string, Probe>()
      const maxDelay = Number(process.env.ROBOT_LINK_RETRY_MAX_MS) || undefined

      const serversChanged = () => {
        bus.emit("servers.changed", {})
        bus.emit("devices.changed", {})
      }

      /** A notice of a linked server shows by the settings of this computer, and names the server. */
      const showNotice = (linkId: string, notice: WireNotice) => {
        const link = devices.link(linkId)
        if (!link?.serverId) return
        const name = numberedNames(devices.outbound()).get(linkId) ?? link.name
        notifier.notifyLinked({ linkId, serverId: link.serverId, serverName: name }, notice)
      }

      /** What waited while this computer was away still notifies, once, when the link is back. */
      const catchUp = async (linkId: string) => {
        try {
          const waiting = (await connections.get(linkId)?.request("attention.list")) as
            | WireNotice[]
            | undefined
          for (const notice of waiting ?? []) showNotice(linkId, notice)
        } catch {
          // A server that does not answer has nothing to catch up on.
        }
      }

      const connect = (row: LinkRow) => {
        const connection = new Connection({
          identity,
          self: devices.self,
          target: () => {
            const link = devices.link(row.id)
            return link?.outbound
              ? { id: link.id, publicKey: link.publicKey, addresses: link.addresses }
              : undefined
          },
          ...(maxDelay ? { maxDelayMs: maxDelay } : {}),
          hooks: {
            onState: (_state, side) => {
              sides.set(row.id, side)
              serversChanged()
            },
            onEvent: (event, payload) => {
              if (event === "notice") showNotice(row.id, payload as WireNotice)
              cache.applyEvent(row.id, event, payload)
              // The window shows these. They do not go to the devices of this computer.
              if (event !== "notice" && event !== "revoked" && event !== ACCESS_EVENT) {
                bus.window(event as never, payload)
              }
              for (const h of eventHandlers) h(row.id, event, payload)
            },
            onOnline: (info) => {
              devices.touchServer(row.id, info)
              // What happened while the server was away is not known: the window reads again.
              const serverId = devices.link(row.id)?.serverId
              if (serverId) {
                for (const event of [
                  "places.changed",
                  "agents.changed",
                  "tasks.changed",
                ] as const) {
                  bus.window(event, { serverId })
                }
              }
              void catchUp(row.id)
              for (const h of onlineHandlers) h(row.id)
            },
            onRevoked: () => {
              // "Not allowed": the cache of the server goes with the link.
              cache.delete(row.id)
              for (const h of removedHandlers) h(row.id)
              serversChanged()
              // The window drops what it shows of that server: the lists read again and fail.
              const serverId = devices.link(row.id)?.serverId
              if (serverId) {
                for (const event of ["places.changed", "agents.changed", "tasks.changed"] as const)
                  bus.window(event, { serverId })
                bus.window("channels.changed", { channelId: "" })
              }
            },
          },
        })
        connections.set(row.id, connection)
        connection.start()
      }

      const sync = () => {
        const wanted = new Map(devices.outbound().map((r) => [r.id, r]))
        for (const [id, connection] of connections) {
          if (wanted.has(id)) continue
          connection.stop()
          connections.delete(id)
          sides.delete(id)
          cache.delete(id)
        }
        for (const row of wanted.values()) if (!connections.has(row.id)) connect(row)
        serversChanged()
      }
      devices.onLinks(sync)
      // Computers that were linked before the app closed open again at start.
      for (const row of devices.outbound()) connect(row)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          cache.flush()
          for (const c of connections.values()) c.stop()
          for (const p of probes.values()) {
            clearTimeout(p.timer)
            p.channel.close()
          }
        }),
      )

      const stateOf = (id: string): LinkState => connections.get(id)?.state ?? "offline"

      const entries = (): ServerEntry[] => {
        const rows = devices.outbound()
        const names = numberedNames(rows)
        return rows.map((r) => ({
          id: r.id,
          serverId: r.serverId ?? "",
          name: names.get(r.id) ?? r.name,
          addresses: r.addresses,
          state: stateOf(r.id),
          updateSide: sides.get(r.id) ?? null,
          since: r.createdAt,
        }))
      }

      const entryOf = (id: string) => entries().find((e) => e.id === id)

      const ok = (value: unknown): RpcResult<unknown> => ({ ok: true, value })
      const failure = (code: string, message = code): RpcResult<unknown> => ({
        ok: false,
        error: { code, message },
      })

      /** Sends the files of a message to the server in pieces, and gives the tokens back. */
      const uploadFiles = async (connection: Connection, input: unknown) => {
        const paths = (input as { files?: readonly string[] }).files ?? []
        if (paths.length === 0) return input
        if (paths.length > ATTACH_MAX) throw new LinkError("too_many_files")
        const tokens: string[] = []
        for (const path of paths) {
          let size = 0
          try {
            const info = statSync(path)
            if (!info.isFile()) throw new Error("not a file")
            size = info.size
          } catch {
            throw new LinkError("file_unreadable", basename(path))
          }
          if (size > ATTACH_BYTES) throw new LinkError("file_too_large", basename(path))
          const uploadId = randomUUID()
          const fd = openSync(path, "r")
          try {
            let offset = 0
            let token: string | null = null
            for (;;) {
              const length = Math.min(FILE_CHUNK, size - offset)
              const buffer = Buffer.alloc(length)
              if (length > 0) readSync(fd, buffer, 0, length, offset)
              const done = offset + length >= size
              const ack = (await connection.request("attachment.upload", {
                uploadId,
                name: basename(path),
                offset,
                data: buffer.toString("base64"),
                done,
              })) as UploadAck
              offset += length
              token = ack.token
              if (done) break
            }
            if (!token?.startsWith(UPLOAD_PREFIX)) throw new LinkError("internal")
            tokens.push(token)
          } finally {
            closeSync(fd)
          }
        }
        return { ...(input as object), files: tokens }
      }

      /** "Save as": asks where, then pulls the file from the server piece by piece. */
      const saveFile = async (linkId: string, input: unknown): Promise<RpcResult<unknown>> => {
        const { agentId, path, name } = input as { agentId: string; path: string; name: string }
        const connection = connections.get(linkId)
        if (!connection || stateOf(linkId) !== "online") return failure("offline")
        const target = await platform.pickSavePath(String(name))
        if (!target) return ok({ saved: false })
        const parts: Buffer[] = []
        let offset = 0
        for (;;) {
          const chunk = (await connection.request("attachment.download", {
            agentId,
            path,
            offset,
          })) as DownloadChunk
          const bytes = Buffer.from(chunk.data, "base64")
          parts.push(bytes)
          offset += bytes.length
          if (chunk.done || bytes.length === 0) break
        }
        writeFileSync(target, Buffer.concat(parts))
        return ok({ saved: true })
      }

      const invoke = async (
        serverId: string,
        method: string,
        input: unknown,
      ): Promise<RpcResult<unknown>> => {
        const link = devices.outbound().find((r) => r.serverId === serverId)
        if (!link) return failure("server_not_found")
        if (!isRoutedMethod(method)) return failure("not_allowed")
        const key = isCachedMethod(method) ? cacheKey(method, input) : undefined
        const connection = connections.get(link.id)
        if (connection && stateOf(link.id) === "online") {
          try {
            if (method === "attachments.save") return await saveFile(link.id, input)
            const payload = method === "chat.send" ? await uploadFiles(connection, input) : input
            const value = await connection.request(method, payload)
            if (key) cache.set(link.id, key, value)
            if (method === "tools.respond") {
              // Answered here: a notice for it must not show again (spec 015).
              const { agentId, callId } = input as { agentId: string; callId: string }
              notifier.answeredLinked(link.id, agentId, callId)
            }
            return ok(value)
          } catch (error) {
            if (
              error instanceof LinkError &&
              error.code !== "offline" &&
              error.code !== "timeout"
            ) {
              // "<server name> does not let this device change agents": the name is the one that
              // this device shows for the server (the server sent its own name).
              if (error.code === "change_off") {
                return failure(error.code, entryOf(link.id)?.name ?? error.detail ?? error.code)
              }
              return failure(error.code, error.detail ?? error.code)
            }
            // The connection broke during the call: a read can still come from the cache.
          }
        }
        if (key) {
          const hit = cache.get(link.id, key)
          if (hit !== undefined) return ok(hit)
        }
        return failure(stateOf(link.id) === "not_allowed" ? "not_allowed" : "offline")
      }

      return Remote.of({
        probe: (input) =>
          Effect.tryPromise({
            try: async () => {
              const invite = input.link ? parseLink(input.link) : null
              if (input.link && !invite) throw new LinkError("invalid_link")
              const code = invite?.code ?? (input.code ?? "").replace(/\s+/g, "")
              if (!isPairCode(code)) throw new LinkError("wrong_code")
              const addresses = invite?.addresses ?? [input.address ?? ""]
              if (!invite && !parseAddress(input.address ?? ""))
                throw new LinkError("invalid_address")
              const { conn, address } = await openAny(addresses)
              let paired: Awaited<ReturnType<typeof pairWithCode>>
              try {
                paired = await pairWithCode(conn, code)
              } catch (error) {
                conn.close()
                throw error
              }
              const { channel, hello } = paired
              const fail = (error: LinkError) => {
                channel.close()
                return error
              }
              const d = hello.device
              let valid = false
              try {
                valid = deviceIdOf(fromB64(d.publicKey)) === d.id && d.kind === "computer"
              } catch {}
              if (!valid) throw fail(new LinkError("unreachable"))
              if (d.id === identity.id) throw fail(new LinkError("same_device"))
              const replacing = devices.link(d.id)?.outbound === true
              if (!replacing && devices.outbound().length >= MAX_SERVERS) {
                throw fail(new LinkError("limit"))
              }
              const session = randomUUID()
              const timer = setTimeout(() => {
                probes.delete(session)
                channel.close()
              }, 5 * 60_000)
              channel.onClose(() => {
                clearTimeout(timer)
                probes.delete(session)
              })
              probes.set(session, { conn, channel, hello, address, invited: addresses, timer })
              return { session, name: d.name, kind: d.kind } satisfies ConnectProbe
            },
            catch: toAppError,
          }),
        finish: (session, twoWay) =>
          Effect.tryPromise({
            try: async () => {
              const probe = probes.get(session)
              if (!probe) throw new LinkError("session_gone")
              const wasListening = devices.listening()
              const wasOn = devices.state().accept
              let addresses: readonly string[] = []
              if (twoWay) {
                await devices.setAccept(true)
                addresses = devices.addresses().map((a) => a.address)
                if (addresses.length === 0) throw new LinkError("unreachable")
              }
              const answer = new Promise<PairMessage>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new LinkError("unreachable")),
                  DECISION_MS + 15_000,
                )
                probe.channel.onMessage((m) => {
                  clearTimeout(timer)
                  resolve(m as PairMessage)
                })
                probe.channel.onClose(() => {
                  clearTimeout(timer)
                  reject(new LinkError("unreachable"))
                })
              })
              probe.channel.send({
                type: "join",
                v: LINK_PROTOCOL,
                device: toPairDevice(
                  devices.self(),
                  identity.publicKey,
                  Effect.runSync(servers.local).id,
                ),
                twoWay,
                addresses,
              } satisfies PairMessage)
              try {
                const reply = await answer
                if (reply.type !== "joined" || reply.v !== LINK_PROTOCOL) {
                  throw new LinkError("unreachable")
                }
                if (!reply.ok) throw new LinkError(reply.code)
                const server = reply.device
                if (
                  !server ||
                  server.id !== probe.hello.device.id ||
                  server.publicKey !== probe.hello.device.publicKey
                ) {
                  throw new LinkError("unreachable")
                }
                const list = [probe.address, ...reply.addresses, ...probe.invited].filter(
                  (a, i, all) => all.indexOf(a) === i,
                )
                const row = devices.saveOutbound({
                  device: server,
                  addresses: list,
                  reverse: twoWay,
                })
                const existing = connections.get(row.id)
                if (existing) existing.restart()
                return entryOf(row.id) as ServerEntry
              } catch (error) {
                if (twoWay && !wasOn) await devices.setAccept(false)
                else if (twoWay && !wasListening) await devices.setAccept(true)
                throw error
              } finally {
                clearTimeout(probe.timer)
                probes.delete(session)
                probe.channel.close()
              }
            },
            catch: toAppError,
          }),
        cancel: (session) =>
          Effect.sync(() => {
            const probe = probes.get(session)
            if (!probe) return
            clearTimeout(probe.timer)
            probes.delete(session)
            probe.channel.close()
          }),
        entries,
        servers: () =>
          devices
            .outbound()
            .filter((r) => r.serverId)
            .map((r) => {
              const names = numberedNames(devices.outbound())
              const state = stateOf(r.id)
              return {
                id: r.serverId as string,
                linkId: r.id,
                name: names.get(r.id) ?? r.name,
                kind: "linked" as const,
                state,
                updateSide: sides.get(r.id) ?? null,
              }
            }),
        remove: (linkId) =>
          Effect.sync(() => {
            if (!devices.link(linkId)?.outbound) return
            connections.get(linkId)?.stop()
            connections.delete(linkId)
            sides.delete(linkId)
            cache.delete(linkId)
            for (const h of removedHandlers) h(linkId)
            devices.removeOutbound(linkId)
          }),
        retry: (serverId) => {
          const row = devices.outbound().find((r) => r.serverId === serverId)
          if (row) connections.get(row.id)?.retryNow()
        },
        linkOfServer: (serverId) => devices.outbound().find((r) => r.serverId === serverId),
        stateOf,
        invoke,
        request: (linkId, method, input, ms) => {
          const connection = connections.get(linkId)
          if (!connection) return Promise.reject(new LinkError("offline"))
          return connection.request(method, input, ms)
        },
        onEvent: (handler) => {
          eventHandlers.push(handler)
        },
        onRemoved: (handler) => {
          removedHandlers.push(handler)
        },
        onOnline: (handler) => {
          onlineHandlers.push(handler)
        },
      })
    }),
  )
}
