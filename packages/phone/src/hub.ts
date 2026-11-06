import {
  type AsyncSecretStore,
  Connection,
  codeToWAsync,
  DECISION_MS,
  DEVICE_NAME_MAX,
  deviceIdOf,
  fromB64,
  type Identity,
  isPairCode,
  LINK_PROTOCOL,
  LinkError,
  type LinkState,
  loadIdentityAsync,
  MAX_SERVERS,
  openAny,
  type PairMessage,
  pairWithCode,
  parseAddress,
  parseLink,
  type RandomBytes,
  type SocketOpener,
  systemRandom,
  toPairDevice,
  type WireDevice,
  type WireNotice,
} from "@robot/link"
import { type PhoneStorage, readJson } from "./storage.ts"

/** A computer that this phone is paired with (spec 011, "Paired server"). */
export interface PairedServer {
  /** The device id of the computer. */
  readonly id: string
  /** The id of the server of that computer, which the requests name. */
  readonly serverId: string
  readonly name: string
  /** The public key of the computer, base64 URL text. */
  readonly publicKey: string
  /** Every address to try, the one that worked last first. */
  readonly addresses: readonly string[]
  readonly pairedAt: number
  /** The computer removed this phone. The Servers screen shows "Pair again" (spec 012). */
  readonly removed: boolean
}

export interface ServerView {
  readonly link: PairedServer
  readonly state: LinkState
  readonly updateSide: "this" | "server" | null
}

export interface HubState {
  readonly deviceName: string | null
  readonly servers: readonly ServerView[]
}

export interface PairInput {
  /** The text of the QR code or a pasted link text. */
  readonly link?: string
  readonly address?: string
  readonly code?: string
}

export interface HubOptions {
  readonly storage: PhoneStorage
  readonly secrets: AsyncSecretStore
  readonly opener: SocketOpener
  readonly random?: RandomBytes
  readonly now?: () => number
  /** How long one address gets to answer. */
  readonly connectMs?: number
  /** The longest wait between two tries to reach a server. */
  readonly maxDelayMs?: number
  /** How often an open connection checks that the server still answers. */
  readonly pingMs?: number
  /** How long the pairing waits for the user of the computer. */
  readonly decisionMs?: number
  /** Turns the pairing code into the number of SPAKE2. Small steps by default. */
  readonly deriveW?: (code: string) => bigint | Promise<bigint>
}

const SERVERS_FILE = "servers.json"
const DEVICE_FILE = "device.json"
const cacheDir = (linkId: string) => `cache/${linkId}`
/** A pairing that runs. `cancel` ends it; the promise then rejects with the code "cancelled". */
export interface PairRun {
  readonly done: Promise<PairedServer>
  cancel(): void
}

/**
 * The phone side of the device link. It keeps the list of paired servers, one connection to each
 * of them, and what each one shows. The app renders `state()` and calls the methods; the tests
 * drive it in Bun against the real server of the desktop.
 */
export class PhoneHub {
  readonly #options: HubOptions
  readonly #identity: Identity
  #deviceName: string | null
  #links: PairedServer[]
  readonly #views = new Map<string, ServerView>()
  readonly #connections = new Map<string, Connection>()
  readonly #listeners = new Set<() => void>()
  readonly #noticeListeners = new Set<(linkId: string, notice: WireNotice) => void>()
  #state: HubState

  private constructor(
    options: HubOptions,
    identity: Identity,
    deviceName: string | null,
    links: PairedServer[],
  ) {
    this.#options = options
    this.#identity = identity
    this.#deviceName = deviceName
    this.#links = links
    this.#state = { deviceName, servers: [] }
  }

  /** Reads the identity, the device name, the servers and their caches, and connects. */
  static async open(options: HubOptions): Promise<PhoneHub> {
    const { identity } = await loadIdentityAsync(options.secrets, options.random ?? systemRandom)
    const device = await readJson<{ name?: unknown }>(options.storage, DEVICE_FILE, {})
    const name =
      typeof device.name === "string" && device.name.trim() ? cleanName(device.name) : null
    const links = await readJson<PairedServer[]>(options.storage, SERVERS_FILE, [])
    const hub = new PhoneHub(options, identity, name, Array.isArray(links) ? links : [])
    for (const link of hub.#links) {
      hub.#views.set(link.id, {
        link,
        state: link.removed ? "not_allowed" : "connecting",
        updateSide: null,
      })
    }
    hub.#publish()
    if (name) hub.#connectAll()
    return hub
  }

  get deviceId() {
    return this.#identity.id
  }

  // ------------------------------------------------------------------ state for the screens

  state(): HubState {
    return this.#state
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Calls `listener` for each notice that a server pushes (spec 011, "Notifications"). */
  onNotice(listener: (linkId: string, notice: WireNotice) => void): () => void {
    this.#noticeListeners.add(listener)
    return () => this.#noticeListeners.delete(listener)
  }

  server(linkId: string): ServerView | undefined {
    return this.#views.get(linkId)
  }

  #publish() {
    this.#state = {
      deviceName: this.#deviceName,
      servers: this.#links.flatMap((l) => {
        const view = this.#views.get(l.id)
        return view ? [view] : []
      }),
    }
    for (const listener of this.#listeners) listener()
  }

  #update(linkId: string, change: (view: ServerView) => ServerView) {
    const view = this.#views.get(linkId)
    if (!view) return
    this.#views.set(linkId, change(view))
    this.#publish()
  }

  // ------------------------------------------------------------------ the device name

  /** The name that the computer shows for this phone. Setting it the first time connects. */
  async setDeviceName(name: string) {
    const clean = cleanName(name)
    if (!clean) throw new LinkError("invalid_name")
    const first = this.#deviceName === null
    this.#deviceName = clean
    await this.#options.storage.write(DEVICE_FILE, JSON.stringify({ name: clean }))
    this.#publish()
    if (first) this.#connectAll()
  }

  #self = (): WireDevice => ({
    id: this.#identity.id,
    name: this.#deviceName ?? "Phone",
    kind: "phone",
  })

  // ------------------------------------------------------------------ pairing

  /**
   * Pairs with a computer (spec 011, "Pairing on the phone"). `onWaiting` is called with the name
   * of the computer once the code is right: the phone then shows "Waiting for <name> to allow…"
   * until the user answers there.
   */
  pair(input: PairInput, onWaiting: (computerName: string) => void): PairRun {
    let cancelled = false
    let close: (() => void) | undefined
    let cancelWait: (() => void) | undefined
    const done = (async () => {
      const invite = input.link ? parseLink(input.link) : null
      if (input.link && !invite) throw new LinkError("invalid_link")
      const code = invite?.code ?? (input.code ?? "").replace(/\s+/g, "")
      if (!invite && !parseAddress(input.address ?? "")) throw new LinkError("invalid_address")
      if (!isPairCode(code)) throw new LinkError("wrong_code")
      const addresses = invite?.addresses ?? [(input.address ?? "").trim()]
      // scrypt is slow on a phone: it runs before the socket opens, so the server does not wait.
      const w = await (this.#options.deriveW ?? codeToWAsync)(code)
      if (cancelled) throw new LinkError("cancelled")
      const { conn, address } = await openAny(
        addresses,
        this.#options.opener,
        this.#options.connectMs ?? 4_000,
      )
      close = () => conn.close()
      if (cancelled) {
        conn.close()
        throw new LinkError("cancelled")
      }
      let paired: Awaited<ReturnType<typeof pairWithCode>>
      try {
        paired = await pairWithCode(conn, code, {
          w,
          ...(this.#options.random ? { random: this.#options.random } : {}),
        })
      } catch (error) {
        conn.close()
        throw error
      }
      const { channel, hello } = paired
      close = () => channel.close()
      const fail = (error: LinkError) => {
        channel.close()
        return error
      }
      if (cancelled) throw fail(new LinkError("cancelled"))
      const d = hello.device
      let valid = false
      try {
        // A phone pairs only with a computer, and the computer must hold the key that it shows.
        valid = deviceIdOf(fromB64(d.publicKey)) === d.id && d.kind === "computer"
      } catch {}
      if (!valid) throw fail(new LinkError("unreachable"))
      if (d.id === this.#identity.id) throw fail(new LinkError("same_device"))
      const replacing = this.#links.some((l) => l.id === d.id)
      if (!replacing && this.#links.length >= MAX_SERVERS) throw fail(new LinkError("limit"))
      onWaiting(d.name)
      const answer = new Promise<PairMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new LinkError("unreachable")),
          (this.#options.decisionMs ?? DECISION_MS) + 15_000,
        )
        cancelWait = () => {
          clearTimeout(timer)
          reject(new LinkError("cancelled"))
        }
        channel.onMessage((m) => {
          clearTimeout(timer)
          resolve(m as PairMessage)
        })
        channel.onClose(() => {
          clearTimeout(timer)
          reject(new LinkError(cancelled ? "cancelled" : "unreachable"))
        })
      })
      // A phone is never a server (spec 012), so it asks for one direction only and has no
      // server id and no addresses of its own.
      channel.send({
        type: "join",
        v: LINK_PROTOCOL,
        device: toPairDevice(this.#self(), this.#identity.publicKey, ""),
        twoWay: false,
        addresses: [],
      } satisfies PairMessage)
      try {
        const reply = await answer
        if (reply.type !== "joined" || reply.v !== LINK_PROTOCOL) throw new LinkError("unreachable")
        if (!reply.ok) throw new LinkError(reply.code)
        const server = reply.device
        if (!server || server.id !== d.id || server.publicKey !== d.publicKey) {
          throw new LinkError("unreachable")
        }
        const list = [address, ...reply.addresses, ...addresses].filter(
          (a, i, all) => parseAddress(a) !== null && all.indexOf(a) === i,
        )
        return await this.#saveLink({
          id: server.id,
          serverId: server.serverId,
          name: cleanName(server.name) || cleanName(invite?.name ?? "") || address,
          publicKey: server.publicKey,
          addresses: list.slice(0, 16),
          pairedAt: this.#now(),
          removed: false,
        })
      } finally {
        channel.close()
      }
    })()
    return {
      done,
      cancel: () => {
        cancelled = true
        cancelWait?.()
        close?.()
      },
    }
  }

  async #saveLink(link: PairedServer): Promise<PairedServer> {
    const old = this.#links.find((l) => l.id === link.id)
    // Pairing the same computer again replaces the old link (spec 012).
    this.#links = old
      ? this.#links.map((l) => (l.id === link.id ? { ...link, pairedAt: old.pairedAt } : l))
      : [...this.#links, link]
    await this.#saveLinks()
    const saved = this.#links.find((l) => l.id === link.id) as PairedServer
    this.#connections.get(link.id)?.stop()
    this.#connections.delete(link.id)
    this.#views.set(link.id, { link: saved, state: "connecting", updateSide: null })
    this.#publish()
    this.#connect(saved)
    return saved
  }

  #saveLinks() {
    return this.#options.storage.write(SERVERS_FILE, JSON.stringify(this.#links))
  }

  /** Ends the link on this phone and deletes the cache of that server (spec 011, "unpair"). */
  async unpair(linkId: string) {
    this.#connections.get(linkId)?.stop()
    this.#connections.delete(linkId)
    this.#links = this.#links.filter((l) => l.id !== linkId)
    this.#views.delete(linkId)
    await this.#saveLinks()
    await this.#options.storage.remove(cacheDir(linkId))
    this.#publish()
  }

  // ------------------------------------------------------------------ connections

  #connectAll() {
    for (const link of this.#links) if (!link.removed) this.#connect(link)
  }

  #connect(link: PairedServer) {
    if (this.#connections.has(link.id) || this.#deviceName === null) return
    const connection = new Connection({
      identity: this.#identity,
      opener: this.#options.opener,
      self: this.#self,
      target: () => {
        const l = this.#links.find((x) => x.id === link.id)
        return l && !l.removed
          ? { id: l.id, publicKey: fromB64(l.publicKey), addresses: l.addresses }
          : undefined
      },
      ...(this.#options.maxDelayMs ? { maxDelayMs: this.#options.maxDelayMs } : {}),
      ...(this.#options.connectMs ? { connectMs: this.#options.connectMs } : {}),
      ...(this.#options.pingMs ? { pingMs: this.#options.pingMs } : {}),
      ...(this.#options.random ? { random: this.#options.random } : {}),
      hooks: {
        onState: (state, side) => this.#update(link.id, (v) => ({ ...v, state, updateSide: side })),
        onEvent: (event, payload) => this.#onEvent(link.id, event, payload),
        onOnline: (info) => void this.#online(link.id, info),
        onRevoked: () => void this.#revoked(link.id),
      },
    })
    this.#connections.set(link.id, connection)
    connection.start()
  }

  async #online(linkId: string, info: { name: string; serverId: string; address: string }) {
    const link = this.#links.find((l) => l.id === linkId)
    if (link) {
      const name = cleanName(info.name) || link.name
      // The address that worked goes first, so the next start tries it first.
      const addresses = [info.address, ...link.addresses.filter((a) => a !== info.address)]
      if (
        name !== link.name ||
        info.serverId !== link.serverId ||
        addresses.join() !== link.addresses.join()
      ) {
        const next = { ...link, name, serverId: info.serverId || link.serverId, addresses }
        this.#links = this.#links.map((l) => (l.id === linkId ? next : l))
        this.#update(linkId, (v) => ({ ...v, link: next }))
        await this.#saveLinks()
      }
    }
  }

  async #revoked(linkId: string) {
    // "Not allowed": the old cache of this server goes.
    this.#connections.get(linkId)?.stop()
    this.#connections.delete(linkId)
    this.#links = this.#links.map((l) => (l.id === linkId ? { ...l, removed: true } : l))
    const link = this.#links.find((l) => l.id === linkId)
    if (link) {
      this.#views.set(linkId, { link, state: "not_allowed", updateSide: null })
    }
    this.#publish()
    await this.#saveLinks()
    await this.#options.storage.remove(cacheDir(linkId))
  }

  /** Tries a server now, when it is not online. */
  reconnect(linkId: string) {
    this.#connections.get(linkId)?.retryNow()
  }

  /**
   * The app came back to the screen (spec 011, "Background"). The system may have cut the
   * sockets: each connection checks at once and reconnects if needed.
   */
  async resume() {
    await Promise.all([...this.#connections.values()].map((connection) => connection.check(3_000)))
  }

  /** Stops all connections. The tests call it at the end. */
  close() {
    for (const c of this.#connections.values()) c.stop()
    this.#connections.clear()
  }

  // ------------------------------------------------------------------ requests

  /** Asks a server. Rejects with a `LinkError`: `offline` when the server is not online. */
  async request<T = unknown>(linkId: string, method: string, input?: unknown, ms?: number) {
    const connection = this.#connections.get(linkId)
    const view = this.#views.get(linkId)
    if (view?.state === "not_allowed") throw new LinkError("not_allowed")
    if (connection?.state !== "online") throw new LinkError("offline")
    return (await connection.request(method, input, ms)) as T
  }

  #onEvent(_linkId: string, event: string, payload: unknown) {
    if (event !== "notice") return
    const notice = payload as WireNotice
    for (const listener of this.#noticeListeners) listener(_linkId, notice)
  }

  #now() {
    return (this.#options.now ?? Date.now)()
  }
}

/** A device name: no spaces at the ends, no control characters, at most 40 characters. */
export const cleanName = (name: string) =>
  [...name.replace(/\p{Cc}/gu, "").trim()].slice(0, DEVICE_NAME_MAX).join("").trim()
