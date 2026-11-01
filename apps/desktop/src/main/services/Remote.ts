import { randomUUID } from "node:crypto"
import {
  type ConnectProbe,
  isPairCode,
  LINK_PROTOCOL,
  type LinkState,
  MAX_SERVERS,
  numberedNames,
  parseAddress,
  parseLink,
  type Server,
  type ServerEntry,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { Conn, SecureChannel } from "../link/channel.ts"
import { LinkError, openAny, pairWithCode } from "../link/client.ts"
import { Connection } from "../link/connection.ts"
import { deviceIdOf, fromB64 } from "../link/identity.ts"
import { DECISION_MS, type PairMessage, toPairDevice } from "../link/protocol.ts"
import { Devices, type LinkRow } from "./Devices.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
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
  request(linkId: string, method: string, input?: unknown): Promise<unknown>
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
      const identity = devices.identity

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
              for (const h of eventHandlers) h(row.id, event, payload)
            },
            onOnline: (info) => {
              devices.touchServer(row.id, info)
              for (const h of onlineHandlers) h(row.id)
            },
            onRevoked: () => {
              for (const h of removedHandlers) h(row.id)
              serversChanged()
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
        }
        for (const row of wanted.values()) if (!connections.has(row.id)) connect(row)
        serversChanged()
      }
      devices.onLinks(sync)
      // Computers that were linked before the app closed open again at start.
      for (const row of devices.outbound()) connect(row)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
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
            for (const h of removedHandlers) h(linkId)
            devices.removeOutbound(linkId)
          }),
        retry: (serverId) => {
          const row = devices.outbound().find((r) => r.serverId === serverId)
          if (row) connections.get(row.id)?.retryNow()
        },
        linkOfServer: (serverId) => devices.outbound().find((r) => r.serverId === serverId),
        stateOf,
        request: (linkId, method, input) => {
          const connection = connections.get(linkId)
          if (!connection) return Promise.reject(new LinkError("offline"))
          return connection.request(method, input)
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
