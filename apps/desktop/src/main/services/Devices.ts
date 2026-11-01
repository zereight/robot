import { randomInt, randomUUID } from "node:crypto"
import { networkInterfaces } from "node:os"
import {
  type ClientEntry,
  DEFAULT_LINK_PORT,
  DEVICE_KINDS,
  DEVICE_NAME_MAX,
  type DeviceKind,
  type DevicesState,
  formatLink,
  isClientMethod,
  type JoinRequest,
  LINK_PROTOCOL,
  MAX_CLIENTS,
  MAX_SERVERS,
  numberedNames,
  PAIR_CODE_LENGTH,
  PAIR_CODE_TRIES,
  PAIR_CODE_TTL_MS,
  type PairingAddress,
  type PairingEnd,
  type PairingState,
  PUSHED_EVENTS,
  type RpcEvent,
  type RpcResult,
  type WireDevice,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { codeToW } from "../link/crypto/spake2.ts"
import { deviceIdOf, fromB64, type Identity, loadIdentity } from "../link/identity.ts"
import { DECISION_MS, type JoinResult, type PairDevice } from "../link/protocol.ts"
import { type ClientSession, type LinkHost, LinkServer, type ServerOffer } from "../link/server.ts"
import type { Actor } from "./actor.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"

/** A row of the table of linked devices. */
export interface LinkRow {
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
  readonly publicKey: Buffer
  /** The device can open this computer. */
  readonly inbound: boolean
  /** This computer can open the device. */
  readonly outbound: boolean
  readonly addresses: readonly string[]
  /** The id of the server that the device is, when this computer can open it. */
  readonly serverId: string | null
  readonly position: number
  readonly createdAt: number
}

interface LinkDbRow {
  id: string
  name: string
  kind: DeviceKind
  public_key: string
  inbound: number
  outbound: number
  addresses: string
  server_id: string | null
  position: number
  created_at: number
}

const toRow = (r: LinkDbRow): LinkRow => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  publicKey: fromB64(r.public_key),
  inbound: r.inbound === 1,
  outbound: r.outbound === 1,
  addresses: JSON.parse(r.addresses) as string[],
  serverId: r.server_id,
  position: r.position,
  createdAt: r.created_at,
})

/** Runs a request of a linked device and returns plain data. The app sets it at start. */
export type LinkDispatcher = (
  method: string,
  input: unknown,
  actor: Actor,
) => Promise<RpcResult<unknown>>

export interface DevicesOptions {
  /** The name of the computer. */
  readonly computerName: string
  /** The port to listen on. 0 lets the system choose. Without it: the saved port, then the default. */
  readonly port?: number
}

export interface DevicesService {
  readonly identity: Identity
  readonly selfId: string
  /** The name that linked devices see. */
  deviceName(): string
  self(): WireDevice
  /** The state for the Devices page, without the connection states of the servers. */
  state(): DevicesState
  update(patch: { name?: string; accept?: boolean }): Effect.Effect<DevicesState, AppError>
  /** Turns on "Let other devices connect" when needed, and shows a new code. */
  pairStart(): Effect.Effect<PairingState, AppError>
  pairing(): PairingState
  pairStop(): PairingState
  joins(): readonly JoinRequest[]
  decide(id: string, allow: boolean): Effect.Effect<void, AppError>
  /** Ends the access of a device that can open this computer. */
  removeClient(id: string): Effect.Effect<void>
  /** True while the listener is open. */
  listening(): boolean
  /** Turns the switch on or off, and opens or closes the listener. */
  setAccept(on: boolean): Promise<void>
  // The client side reads and writes the table too.
  links(): readonly LinkRow[]
  link(id: string): LinkRow | undefined
  outbound(): readonly LinkRow[]
  /** Saves a computer that this device can open, after a pairing. Replaces an older link. */
  saveOutbound(input: {
    device: { id: string; name: string; kind: DeviceKind; publicKey: string; serverId: string }
    addresses: readonly string[]
    reverse: boolean
  }): LinkRow
  setAddresses(id: string, addresses: readonly string[]): Effect.Effect<LinkRow, AppError>
  /** Remembers the name, the server id and the address that worked when a server connected. */
  touchServer(id: string, info: { name: string; serverId: string; address?: string }): void
  removeOutbound(id: string): void
  /** The addresses of this computer that other devices can use now. */
  addresses(): readonly PairingAddress[]
  /** Calls `handler` when the table of links changed. */
  onLinks(handler: () => void): void
  bindDispatcher(dispatcher: LinkDispatcher): void
  /** Which linked devices have an open session on this computer. */
  online(): ReadonlySet<string>
  /** Sends an event to every linked device that is connected. */
  push(event: string, payload: unknown): void
  /** Calls `handler` when a linked device opens a session. */
  onSession(handler: (device: WireDevice) => void): void
}

export class Devices extends Context.Service<Devices, DevicesService>()("robot/main/Devices") {
  static readonly layer = (options: DevicesOptions) =>
    Layer.effect(
      Devices,
      Effect.gen(function* () {
        const db = yield* Database
        const bus = yield* EventBus
        const secrets = yield* Secrets
        const settings = yield* SettingsStore
        const platform = yield* Platform
        const servers = yield* Servers

        const { identity, created } = loadIdentity(secrets)
        // A new identity means the keychain was empty (a copied data folder, a new computer).
        // Links made with the old keys cannot work, so they go.
        if (created) db.run("DELETE FROM device_link")

        const current = () => Effect.runSync(settings.get)
        const computerName = options.computerName
        const deviceName = () => current().deviceName.trim() || computerName
        const self = (): WireDevice => ({ id: identity.id, name: deviceName(), kind: "computer" })
        const localServerId = () => Effect.runSync(servers.local).id
        const clean = (name: string) => name.trim().slice(0, DEVICE_NAME_MAX)

        const changed = () => bus.emit("devices.changed", {})
        const linkHandlers: (() => void)[] = []
        const linksChanged = () => {
          for (const h of linkHandlers) h()
          changed()
          bus.emit("servers.changed", {})
        }

        // ---------------------------------------------------------------- the table of links
        const rows = () =>
          db.all<LinkDbRow>("SELECT * FROM device_link ORDER BY position, created_at").map(toRow)
        const rowOf = (id: string) => {
          const r = db.get<LinkDbRow>("SELECT * FROM device_link WHERE id = ?", id)
          return r ? toRow(r) : undefined
        }
        const nextPosition = () =>
          (db.get<{ n: number | null }>("SELECT MAX(position) AS n FROM device_link")?.n ?? -1) + 1
        const mutate = (id: string, column: "name" | "addresses" | "server_id", value: string) =>
          db.run(`UPDATE device_link SET ${column} = ? WHERE id = ?`, value, id)

        // ---------------------------------------------------------------- sessions of clients
        const sessions = new Map<string, ClientSession>()
        const sessionHandlers: ((device: WireDevice) => void)[] = []
        let dispatcher: LinkDispatcher | undefined
        let eventId = 0

        const fail = (session: ClientSession, id: number, code: string, message: string) =>
          session.channel.send({
            v: LINK_PROTOCOL,
            type: "response",
            id,
            ok: false,
            error: { code, message },
          })

        const handleMessage = async (session: ClientSession, message: unknown) => {
          const m = message as {
            type?: string
            id?: number
            method?: string
            input?: unknown
            v?: number
          }
          if (m.type !== "request" || typeof m.id !== "number" || typeof m.method !== "string") {
            return
          }
          if (m.v !== LINK_PROTOCOL) return fail(session, m.id, "update_app", "Update the app")
          // The link and the switch are checked at each request, so a request after "Remove
          // access" fails also on a connection that was open before.
          const link = rowOf(session.device.id)
          if (!link?.inbound || !current().acceptLinks) {
            return fail(session, m.id, "not_allowed", "Not allowed")
          }
          if (!isClientMethod(m.method)) return fail(session, m.id, "not_allowed", "Not allowed")
          if (!dispatcher) return fail(session, m.id, "internal", "Unexpected error")
          const result = await dispatcher(m.method, m.input, { id: link.id, name: link.name })
          session.channel.send({
            v: LINK_PROTOCOL,
            type: "response",
            id: m.id,
            ...(result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }),
          })
        }

        const closeSession = (id: string, code = 4403) => {
          const s = sessions.get(id)
          sessions.delete(id)
          s?.channel.close(code)
        }

        function push(event: string, payload: unknown) {
          for (const session of sessions.values()) {
            session.channel.send({ v: LINK_PROTOCOL, type: "event", id: ++eventId, event, payload })
          }
        }

        // ---------------------------------------------------------------- the pairing code
        interface Offer extends ServerOffer {
          readonly code: string
          readonly expiresAt: number
          tries: number
          ended: boolean
          readonly timer: ReturnType<typeof setTimeout>
        }
        let offer: Offer | undefined
        let lastEnded: PairingEnd | null = null
        let server: LinkServer

        const addresses = (): PairingAddress[] => {
          const port = server.port ?? options.port ?? DEFAULT_LINK_PORT
          const forced = process.env.ROBOT_LINK_ADDRESSES
          if (forced) {
            return forced
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean)
              .map((host) => ({ address: `${host}:${port}`, label: "local" as const }))
          }
          const local: PairingAddress[] = []
          const vpn: PairingAddress[] = []
          const v6: PairingAddress[] = []
          for (const [name, list] of Object.entries(networkInterfaces())) {
            for (const a of list ?? []) {
              if (a.internal) continue
              const isVpn =
                /^(utun|tun|tap|wg|tailscale|ts|zt|ppp)/i.test(name) ||
                /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) ||
                /^fd7a:115c:a1e0:/i.test(a.address)
              const label = isVpn ? ("vpn" as const) : ("local" as const)
              if (a.family === "IPv4") {
                ;(isVpn ? vpn : local).push({ address: `${a.address}:${port}`, label })
              } else if (!/^fe80:/i.test(a.address)) {
                v6.push({ address: `[${a.address}]:${port}`, label })
              }
            }
          }
          return [...local, ...vpn, ...v6].slice(0, 8)
        }

        const pairing = (): PairingState => {
          const o = offer
          if (o && !o.ended && Date.now() >= o.expiresAt) endOffer("expired")
          if (!o || o.ended) {
            return {
              active: false,
              code: "",
              expiresAt: 0,
              addresses: [],
              link: "",
              ended: lastEnded,
            }
          }
          const list = addresses()
          return {
            active: true,
            code: o.code,
            expiresAt: o.expiresAt,
            addresses: list,
            link: formatLink({
              code: o.code,
              name: deviceName(),
              addresses: list.map((a) => a.address),
            }),
            ended: null,
          }
        }

        function endOffer(reason: PairingEnd) {
          const o = offer
          if (!o || o.ended) return
          o.ended = true
          lastEnded = reason
          clearTimeout(o.timer)
          bus.emit("devices.pairing", pairing())
        }

        const newOffer = (): Offer => {
          const code = String(randomInt(0, 10 ** PAIR_CODE_LENGTH)).padStart(PAIR_CODE_LENGTH, "0")
          const ttl = Number(process.env.ROBOT_LINK_CODE_TTL_MS) || PAIR_CODE_TTL_MS
          return {
            code,
            w: codeToW(code),
            expiresAt: Date.now() + ttl,
            tries: 0,
            ended: false,
            timer: setTimeout(() => endOffer("expired"), ttl),
          }
        }

        // ---------------------------------------------------------------- join requests
        const pending = new Map<
          string,
          {
            request: JoinRequest
            resolve: (allow: boolean) => void
            timer: ReturnType<typeof setTimeout>
          }
        >()

        const validDevice = (d: PairDevice) => {
          try {
            const key = fromB64(d.publicKey)
            return (
              key.length === 32 &&
              deviceIdOf(key) === d.id &&
              (DEVICE_KINDS as readonly string[]).includes(d.kind) &&
              typeof d.name === "string" &&
              clean(d.name).length > 0
            )
          } catch {
            return false
          }
        }

        const join = async (request: {
          device: PairDevice
          twoWay: boolean
          addresses: readonly string[]
        }): Promise<JoinResult> => {
          const device = request.device
          if (!validDevice(device)) return { ok: false, code: "denied" }
          if (device.id === identity.id) return { ok: false, code: "same_device" }
          const twoWay =
            request.twoWay && device.kind === "computer" && request.addresses.length > 0
          const others = rows().filter((r) => r.id !== device.id)
          if (
            others.filter((r) => r.inbound).length >= MAX_CLIENTS ||
            (twoWay && others.filter((r) => r.outbound).length >= MAX_SERVERS)
          ) {
            return { ok: false, code: "limit" }
          }
          const id = randomUUID()
          const asked: JoinRequest = { id, name: clean(device.name), kind: device.kind, twoWay }
          const allow = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), DECISION_MS)
            pending.set(id, { request: asked, resolve, timer })
            bus.emit("devices.join", { request: asked })
            platform.showWindow()
          })
          const entry = pending.get(id)
          if (entry) clearTimeout(entry.timer)
          pending.delete(id)
          bus.emit("devices.join", { closed: id })
          if (!allow) return { ok: false, code: "denied" }
          // "Pairing the same device again replaces the old link."
          const old = rowOf(device.id)
          db.run("DELETE FROM device_link WHERE id = ?", device.id)
          db.run(
            `INSERT INTO device_link (id, name, kind, public_key, inbound, outbound, addresses, server_id, position, created_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
            device.id,
            clean(device.name),
            device.kind,
            device.publicKey,
            twoWay ? 1 : 0,
            JSON.stringify(twoWay ? request.addresses : []),
            twoWay ? device.serverId : null,
            old?.position ?? nextPosition(),
            old?.createdAt ?? Date.now(),
          )
          closeSession(device.id)
          linksChanged()
          return { ok: true, addresses: addresses().map((a) => a.address) }
        }

        // ---------------------------------------------------------------- the listener
        const host: LinkHost = {
          identity,
          device: self,
          serverId: localServerId,
          appVersion: () => platform.appVersion,
          accepting: () => current().acceptLinks,
          offer: () => (offer && !offer.ended && Date.now() < offer.expiresAt ? offer : undefined),
          wrongCode: (o) => {
            const own = o as Offer
            own.tries++
            if (own.tries >= PAIR_CODE_TRIES) endOffer("tries")
          },
          useCode: (o) => {
            const own = o as Offer
            if (own.ended || Date.now() >= own.expiresAt) return false
            endOffer("used")
            return true
          },
          join,
          client: (publicKey) => {
            const row = rowOf(deviceIdOf(publicKey))
            if (!row?.inbound || !row.publicKey.equals(publicKey)) return undefined
            return { id: row.id, name: row.name, kind: row.kind }
          },
          session: (session) => {
            const old = sessions.get(session.device.id)
            sessions.set(session.device.id, session)
            old?.channel.close(4409)
            const name = clean(session.device.name)
            if (name && name !== rowOf(session.device.id)?.name) {
              mutate(session.device.id, "name", name)
            }
            session.channel.onMessage((m) => void handleMessage(session, m))
            session.channel.onClose(() => {
              if (sessions.get(session.device.id) === session) {
                sessions.delete(session.device.id)
                changed()
              }
            })
            for (const h of sessionHandlers) h(session.device)
            changed()
          },
        }
        server = new LinkServer(host)

        // The port of the last time the listener ran, so a switch off and on keeps the address.
        let lastPort = 0
        const choosePort = () => {
          if (lastPort) return lastPort
          if (options.port !== undefined) return options.port
          const fromEnv = process.env.ROBOT_LINK_PORT
          if (fromEnv !== undefined && fromEnv !== "" && Number.isInteger(Number(fromEnv))) {
            return Number(fromEnv)
          }
          return current().linkPort || DEFAULT_LINK_PORT
        }

        let starting: Promise<void> | undefined
        const startListening = (): Promise<void> => {
          if (server.port !== null) return Promise.resolve()
          if (starting) return starting
          const wanted = choosePort()
          starting = server
            .listen(wanted)
            .catch((error: NodeJS.ErrnoException) => {
              // The usual port is taken (a second copy of the app): take any free port.
              if (error.code === "EADDRINUSE" && wanted !== 0) return server.listen(0)
              throw error
            })
            .then((port) => {
              lastPort = port
              const fixed = options.port !== undefined || process.env.ROBOT_LINK_PORT !== undefined
              if (!fixed && current().linkPort !== port) {
                void Effect.runPromise(settings.update({ linkPort: port }))
              }
              changed()
            })
            .catch((error) => {
              console.error("link listener failed", error)
            })
            .finally(() => {
              starting = undefined
            })
          return starting
        }

        const stopListening = () => {
          server.close()
          for (const id of [...sessions.keys()]) closeSession(id, 1001)
          if (offer && !offer.ended) endOffer("stopped")
          changed()
        }

        const setAccept = async (on: boolean) => {
          if (on !== current().acceptLinks)
            await Effect.runPromise(settings.update({ acceptLinks: on }))
          if (on) await startListening()
          else stopListening()
        }

        if (current().acceptLinks) void startListening()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (offer) clearTimeout(offer.timer)
            for (const p of pending.values()) clearTimeout(p.timer)
            server.close()
          }),
        )

        // Events that linked devices see.
        bus.tap((event: RpcEvent, payload: unknown) => {
          if ((PUSHED_EVENTS as readonly string[]).includes(event)) push(event, payload)
        })

        const state = (): DevicesState => {
          const all = rows()
          const names = numberedNames(all)
          const clients: ClientEntry[] = all
            .filter((r) => r.inbound)
            .map((r) => ({
              id: r.id,
              name: names.get(r.id) ?? r.name,
              kind: r.kind,
              online: sessions.has(r.id),
              since: r.createdAt,
            }))
          return {
            self: {
              id: identity.id,
              name: deviceName(),
              kind: "computer",
              protocol: LINK_PROTOCOL,
              computerName,
            },
            accept: current().acceptLinks,
            port: server.port,
            clients,
            servers: [],
          }
        }

        return Devices.of({
          identity,
          selfId: identity.id,
          deviceName,
          self,
          state,
          update: (patch) =>
            Effect.gen(function* () {
              if (patch.name !== undefined) {
                const name = clean(patch.name)
                yield* settings.update({ deviceName: name === computerName ? "" : name })
              }
              if (patch.accept !== undefined) {
                yield* Effect.promise(() => setAccept(patch.accept === true))
              }
              linksChanged()
              return state()
            }),
          pairStart: () =>
            Effect.gen(function* () {
              yield* Effect.promise(() => setAccept(true))
              if (server.port === null) return yield* new AppError({ code: "listen_failed" })
              if (offer) clearTimeout(offer.timer)
              offer = newOffer()
              lastEnded = null
              const p = pairing()
              bus.emit("devices.pairing", p)
              changed()
              return p
            }),
          pairing,
          pairStop: () => {
            endOffer("stopped")
            return pairing()
          },
          joins: () => [...pending.values()].map((p) => p.request),
          decide: (id, allow) =>
            Effect.suspend(() => {
              const entry = pending.get(id)
              if (!entry) return Effect.fail(new AppError({ code: "join_gone" }))
              entry.resolve(allow)
              return Effect.void
            }),
          removeClient: (id) =>
            Effect.sync(() => {
              const row = rowOf(id)
              if (!row) return
              // A connected device learns it at once; any other learns it at its next try.
              const s = sessions.get(id)
              s?.channel.send({
                v: LINK_PROTOCOL,
                type: "event",
                id: ++eventId,
                event: "revoked",
                payload: {},
              })
              if (row.outbound) db.run("UPDATE device_link SET inbound = 0 WHERE id = ?", id)
              else db.run("DELETE FROM device_link WHERE id = ?", id)
              sessions.delete(id)
              if (s) setTimeout(() => s.channel.close(4403), 150)
              linksChanged()
            }),
          listening: () => server.port !== null,
          setAccept,
          links: rows,
          link: rowOf,
          outbound: () => rows().filter((r) => r.outbound),
          saveOutbound: ({ device, addresses: list, reverse }) => {
            const old = rowOf(device.id)
            db.run("DELETE FROM device_link WHERE id = ?", device.id)
            db.run(
              `INSERT INTO device_link (id, name, kind, public_key, inbound, outbound, addresses, server_id, position, created_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
              device.id,
              clean(device.name),
              device.kind,
              device.publicKey,
              reverse ? 1 : 0,
              JSON.stringify(list),
              device.serverId,
              old?.position ?? nextPosition(),
              old?.createdAt ?? Date.now(),
            )
            if (!reverse) closeSession(device.id)
            linksChanged()
            return rowOf(device.id) as LinkRow
          },
          setAddresses: (id, list) =>
            Effect.suspend(() => {
              const row = rowOf(id)
              if (!row?.outbound) return Effect.fail(new AppError({ code: "server_not_found" }))
              mutate(id, "addresses", JSON.stringify(list))
              linksChanged()
              return Effect.succeed(rowOf(id) as LinkRow)
            }),
          touchServer: (id, info) => {
            const row = rowOf(id)
            if (!row) return
            let dirty = false
            const name = clean(info.name)
            if (name && name !== row.name) {
              mutate(id, "name", name)
              dirty = true
            }
            if (info.serverId && info.serverId !== row.serverId) {
              mutate(id, "server_id", info.serverId)
              dirty = true
            }
            if (info.address && info.address !== row.addresses[0]) {
              // The address that worked goes first.
              const list = [info.address, ...row.addresses.filter((a) => a !== info.address)]
              mutate(id, "addresses", JSON.stringify(list))
              dirty = true
            }
            if (dirty) linksChanged()
          },
          removeOutbound: (id) => {
            const row = rowOf(id)
            if (!row) return
            if (row.inbound) {
              db.run("UPDATE device_link SET outbound = 0, server_id = NULL WHERE id = ?", id)
            } else db.run("DELETE FROM device_link WHERE id = ?", id)
            linksChanged()
          },
          addresses,
          onLinks: (handler) => {
            linkHandlers.push(handler)
          },
          bindDispatcher: (d) => {
            dispatcher = d
          },
          online: () => new Set(sessions.keys()),
          push,
          onSession: (handler) => {
            sessionHandlers.push(handler)
          },
        })
      }),
    )
}
