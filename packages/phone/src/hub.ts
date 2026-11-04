import {
  type AsyncSecretStore,
  b64,
  Connection,
  codeToWAsync,
  DECISION_MS,
  DEVICE_NAME_MAX,
  type DownloadChunk,
  deviceIdOf,
  FILE_CHUNK,
  fromB64,
  fromBase64,
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
  toBase64,
  toPairDevice,
  UPLOAD_PREFIX,
  type UploadAck,
  type WireDevice,
  type WireNotice,
} from "@robot/link"
import type {
  Agent,
  Channel,
  ChannelMessage,
  ChartModel,
  ChatHistory,
  ChatMessage,
  PlaceSection,
  QueuedMessage,
  QueueHold,
} from "@robot/shared"
import { type OrgChartPhase, OrgFeed } from "./orgChart.ts"
import { newest, removeMessage, upsertMessage } from "./places.ts"
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

export type PlaceKind = "agent" | "channel"
export interface PlaceRef {
  readonly kind: PlaceKind
  readonly id: string
}

export interface ChatView {
  readonly messages: readonly ChatMessage[]
  readonly queue: readonly QueuedMessage[]
  readonly hold: QueueHold | null
}

/** What the phone knows of one server: live while it is online, from the cache when it is not. */
export interface ServerData {
  readonly places: readonly PlaceSection[] | null
  readonly agents: readonly Agent[] | null
  readonly channels: readonly Channel[] | null
  /** The chats that were opened, by agent. */
  readonly chats: Readonly<Record<string, ChatView>>
  /** The channels that were opened, by channel. */
  readonly channelMessages: Readonly<Record<string, readonly ChannelMessage[]>>
  /** Approvals and questions that wait (the "Needs you" list of spec 011). Never from the cache. */
  readonly attention: readonly WireNotice[]
}

export interface ServerView {
  readonly link: PairedServer
  readonly state: LinkState
  readonly updateSide: "this" | "server" | null
  readonly data: ServerData
}

export interface HubState {
  readonly deviceName: string | null
  readonly servers: readonly ServerView[]
}

/** A file that the user picked, read in pieces, so a large file does not fill the memory. */
export interface UploadSource {
  readonly name: string
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
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

/** The limits of files in one message (spec 003). The tests check that they match the server. */
export const ATTACH_MAX = 10
export const ATTACH_BYTES = 20 * 1024 * 1024

const SERVERS_FILE = "servers.json"
const DEVICE_FILE = "device.json"
const cacheDir = (linkId: string) => `cache/${linkId}`
const SAVE_MS = 400
const EMPTY: ServerData = {
  places: null,
  agents: null,
  channels: null,
  chats: {},
  channelMessages: {},
  attention: [],
}

/** The ids of a server come from the computer. They must not leave the folder of its cache. */
const safeName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)

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
  readonly #saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #pendingSaves = new Map<string, () => string>()
  readonly #refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The screens that watch the org chart of a server, by server (spec 029). Memory only. */
  readonly #orgWatches = new Map<string, Set<(model: ChartModel) => void>>()
  #state: HubState
  /** The place that shows on the screen now, per server, so new messages are read at once. */
  readonly #focus = new Map<string, PlaceRef>()
  #active = true

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
        data: link.removed ? EMPTY : await hub.#readCache(link.id),
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

  #setData(linkId: string, change: (data: ServerData) => ServerData) {
    this.#update(linkId, (v) => ({ ...v, data: change(v.data) }))
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
    this.#views.set(link.id, { link: saved, state: "connecting", updateSide: null, data: EMPTY })
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
    this.#focus.delete(linkId)
    this.#dropSaves(linkId)
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
        onState: (state, side) => {
          this.#update(link.id, (v) => ({ ...v, state, updateSide: side }))
        },
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
    // What happened while the server was away is not known: read it all again (spec 011).
    await this.refresh(linkId)
  }

  async #revoked(linkId: string) {
    // "Not allowed": the cache goes, and the place list and the conversation are cleared.
    this.#dropSaves(linkId)
    this.#focus.delete(linkId)
    this.#connections.get(linkId)?.stop()
    this.#connections.delete(linkId)
    this.#links = this.#links.map((l) => (l.id === linkId ? { ...l, removed: true } : l))
    const link = this.#links.find((l) => l.id === linkId)
    if (link) {
      this.#views.set(linkId, { link, state: "not_allowed", updateSide: null, data: EMPTY })
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
   * sockets: each connection checks at once, reconnects if needed, and reads what it missed.
   */
  async resume() {
    this.#active = true
    await Promise.all(
      [...this.#connections.entries()].map(async ([linkId, connection]) => {
        const alive = await connection.check(3_000)
        // A connection that was cut reads again when it is online (see #online).
        if (alive) await this.refresh(linkId)
      }),
    )
  }

  /** The app left the screen. Nothing is marked as read until it comes back. */
  pause() {
    this.#active = false
  }

  /** Stops all connections. The tests call it at the end. */
  close() {
    for (const c of this.#connections.values()) c.stop()
    this.#connections.clear()
    for (const timer of this.#saveTimers.values()) clearTimeout(timer)
    for (const timer of this.#refreshTimers.values()) clearTimeout(timer)
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

  /** Reads the places, the agents, the channels, what waits, and the open place again. */
  async refresh(linkId: string) {
    const view = this.#views.get(linkId)
    if (view?.state !== "online") return
    const serverId = view.link.serverId
    const read = <T>(method: string, input: unknown) =>
      this.request<T>(linkId, method, input).catch(() => undefined)
    const [places, agents, channels, attention] = await Promise.all([
      read<PlaceSection[]>("places.list", { serverId }),
      read<Agent[]>("agents.list", { serverId, archived: false }),
      read<Channel[]>("channels.list", { serverId }),
      read<WireNotice[]>("attention.list", undefined),
    ])
    this.#setData(linkId, (d) => ({
      ...d,
      places: places ?? d.places,
      agents: agents ?? d.agents,
      channels: channels ?? d.channels,
      attention: attention ?? d.attention,
    }))
    if (places) this.#save(linkId, "places", () => JSON.stringify(places))
    if (agents) this.#save(linkId, "agents", () => JSON.stringify(agents))
    if (channels) this.#save(linkId, "channels", () => JSON.stringify(channels))
    const focus = this.#focus.get(linkId)
    if (focus) await this.#loadPlace(linkId, focus)
  }

  /** Reads one list again, a moment later, so a burst of events makes one request. */
  #refreshSoon(linkId: string, what: "places" | "agents" | "channels" | "attention") {
    const key = `${linkId}\u0000${what}`
    if (this.#refreshTimers.has(key)) return
    this.#refreshTimers.set(
      key,
      setTimeout(() => {
        this.#refreshTimers.delete(key)
        void this.#refreshOne(linkId, what)
      }, 150),
    )
  }

  async #refreshOne(linkId: string, what: "places" | "agents" | "channels" | "attention") {
    const view = this.#views.get(linkId)
    if (view?.state !== "online") return
    const serverId = view.link.serverId
    try {
      if (what === "places") {
        const places = await this.request<PlaceSection[]>(linkId, "places.list", { serverId })
        this.#setData(linkId, (d) => ({ ...d, places }))
        this.#save(linkId, "places", () => JSON.stringify(places))
      } else if (what === "agents") {
        const agents = await this.request<Agent[]>(linkId, "agents.list", {
          serverId,
          archived: false,
        })
        this.#setData(linkId, (d) => ({ ...d, agents }))
        this.#save(linkId, "agents", () => JSON.stringify(agents))
      } else if (what === "channels") {
        const channels = await this.request<Channel[]>(linkId, "channels.list", { serverId })
        this.#setData(linkId, (d) => ({ ...d, channels }))
        this.#save(linkId, "channels", () => JSON.stringify(channels))
      } else {
        const attention = await this.request<WireNotice[]>(linkId, "attention.list")
        this.#setData(linkId, (d) => ({ ...d, attention }))
      }
    } catch {
      // The next event or the next connection reads it again.
    }
  }

  #onEvent(linkId: string, event: string, payload: unknown) {
    const p = (payload ?? {}) as Record<string, unknown>
    if (event === "chat.message") {
      const message = payload as ChatMessage
      this.#setData(linkId, (d) => {
        const chat = d.chats[message.agentId]
        if (!chat) return d
        return {
          ...d,
          chats: {
            ...d.chats,
            [message.agentId]: { ...chat, messages: upsertMessage(chat.messages, message) },
          },
        }
      })
      this.#saveChat(linkId, message.agentId)
      this.#readIfFocused(linkId, { kind: "agent", id: message.agentId })
      if (message.parts.some((part) => part.kind === "tool")) this.#refreshSoon(linkId, "attention")
    } else if (event === "chat.removed") {
      const agentId = String(p.agentId)
      this.#setData(linkId, (d) => {
        const chat = d.chats[agentId]
        if (!chat) return d
        const messages = removeMessage(chat.messages, String(p.messageId))
        return { ...d, chats: { ...d.chats, [agentId]: { ...chat, messages } } }
      })
      this.#saveChat(linkId, agentId)
    } else if (event === "chat.queue") {
      const agentId = String(p.agentId)
      this.#setData(linkId, (d) => {
        const chat = d.chats[agentId]
        if (!chat) return d
        const queue = (p.queue as QueuedMessage[] | undefined) ?? []
        const hold = (p.hold as QueueHold | null | undefined) ?? null
        return { ...d, chats: { ...d.chats, [agentId]: { ...chat, queue, hold } } }
      })
      this.#saveChat(linkId, agentId)
    } else if (event === "channel.message") {
      const message = payload as ChannelMessage
      this.#setData(linkId, (d) => {
        const list = d.channelMessages[message.channelId]
        if (!list) return d
        return {
          ...d,
          channelMessages: {
            ...d.channelMessages,
            [message.channelId]: upsertMessage(list, message),
          },
        }
      })
      this.#saveChannel(linkId, message.channelId)
      this.#readIfFocused(linkId, { kind: "channel", id: message.channelId })
      if (message.parts.some((part) => part.kind === "tool")) this.#refreshSoon(linkId, "attention")
    } else if (event === "channel.removed") {
      const channelId = String(p.channelId)
      this.#setData(linkId, (d) => {
        const list = d.channelMessages[channelId]
        if (!list) return d
        const next = removeMessage(list, String(p.messageId))
        return { ...d, channelMessages: { ...d.channelMessages, [channelId]: next } }
      })
      this.#saveChannel(linkId, channelId)
    } else if (event === "orgChart.model") {
      // The whole ready model (spec 029, 012). Only a screen that watches the chart gets it; the
      // phone keeps it nowhere else and never writes it to disk.
      for (const watch of this.#orgWatches.get(linkId) ?? []) watch(payload as ChartModel)
    } else if (event === "places.changed") {
      this.#refreshSoon(linkId, "places")
    } else if (event === "agents.changed") {
      this.#refreshSoon(linkId, "agents")
    } else if (event === "channels.changed") {
      this.#refreshSoon(linkId, "channels")
    } else if (event === "tasks.changed") {
      this.#refreshSoon(linkId, "attention")
    } else if (event === "notice") {
      const notice = payload as WireNotice
      if (notice.kind === "approval" || notice.kind === "question") {
        this.#refreshSoon(linkId, "attention")
      }
      for (const listener of this.#noticeListeners) listener(linkId, notice)
    }
  }

  // ------------------------------------------------------------------ the org chart

  /**
   * Watches the org chart of a server for the screen "Org chart" (spec 029, "Phone"; spec 011).
   * While the server is online it asks for the ready model once and then follows the pushes of the
   * server. The model lives in memory only: `listener` gets the phase, and the phase `off` (no
   * model) whenever the server is not online. When the server comes back online it is asked
   * again, because the pushes of the time away were not seen. `stop` ends the watch and drops the
   * model. Nothing of the chart is written to the cache.
   */
  watchOrgChart(
    linkId: string,
    listener: (phase: OrgChartPhase) => void,
  ): { readonly stop: () => void; readonly refresh: () => void } {
    const feed = new OrgFeed(listener)
    let live = true
    let asking = false
    const ask = (again = false) => {
      const view = this.#views.get(linkId)
      if (!live || view?.state !== "online") return
      asking = true
      const question = again ? feed.again() : feed.begin()
      this.request<ChartModel>(linkId, "orgChart.model", { serverId: view.link.serverId }).then(
        (model) => void feed.answered(question, model),
        (error: unknown) => feed.failed(question, error),
      )
    }
    const follow = () => {
      if (!live) return
      const online = this.#views.get(linkId)?.state === "online"
      if (online && !asking) ask()
      else if (!online && asking) {
        asking = false
        feed.stop()
      }
    }
    const unfollow = this.subscribe(follow)
    const watches = this.#orgWatches.get(linkId) ?? new Set()
    const push = (model: ChartModel) => {
      if (asking) feed.pushed(model)
    }
    watches.add(push)
    this.#orgWatches.set(linkId, watches)
    follow()
    return {
      stop: () => {
        if (!live) return
        live = false
        asking = false
        unfollow()
        watches.delete(push)
        if (watches.size === 0) this.#orgWatches.delete(linkId)
        feed.discard()
      },
      // The user asked again (pull to refresh).
      refresh: () => {
        if (live && asking) ask(true)
      },
    }
  }

  // ------------------------------------------------------------------ places

  /**
   * The user opened a place. It loads its messages (from the cache while the server is offline)
   * and marks it as read on the server.
   */
  async openPlace(linkId: string, place: PlaceRef) {
    this.#focus.set(linkId, place)
    const view = this.#views.get(linkId)
    if (!view) return
    if (view.state !== "online") {
      await this.#loadCachedPlace(linkId, place)
      return
    }
    await this.#loadPlace(linkId, place)
  }

  /** The user left the place. */
  closePlace(linkId: string, place: PlaceRef) {
    const focus = this.#focus.get(linkId)
    if (focus?.kind === place.kind && focus.id === place.id) this.#focus.delete(linkId)
  }

  async #loadCachedPlace(linkId: string, place: PlaceRef) {
    const dir = cacheDir(linkId)
    if (place.kind === "agent") {
      if (this.#views.get(linkId)?.data.chats[place.id]) return
      const chat = await readJson<ChatView | null>(
        this.#options.storage,
        `${dir}/chat-${safeName(place.id)}.json`,
        null,
      )
      if (chat) this.#setData(linkId, (d) => ({ ...d, chats: { ...d.chats, [place.id]: chat } }))
    } else {
      if (this.#views.get(linkId)?.data.channelMessages[place.id]) return
      const list = await readJson<ChannelMessage[] | null>(
        this.#options.storage,
        `${dir}/channel-${safeName(place.id)}.json`,
        null,
      )
      if (list) {
        this.#setData(linkId, (d) => ({
          ...d,
          channelMessages: { ...d.channelMessages, [place.id]: list },
        }))
      }
    }
  }

  async #loadPlace(linkId: string, place: PlaceRef) {
    try {
      if (place.kind === "agent") {
        const history = await this.request<ChatHistory>(linkId, "chat.history", {
          agentId: place.id,
        })
        const chat: ChatView = {
          messages: history.messages,
          queue: history.queue,
          hold: history.hold,
        }
        this.#setData(linkId, (d) => ({ ...d, chats: { ...d.chats, [place.id]: chat } }))
        this.#saveChat(linkId, place.id)
      } else {
        const list = await this.request<ChannelMessage[]>(linkId, "channels.history", {
          channelId: place.id,
        })
        this.#setData(linkId, (d) => ({
          ...d,
          channelMessages: { ...d.channelMessages, [place.id]: list },
        }))
        this.#saveChannel(linkId, place.id)
      }
      await this.markRead(linkId, place)
    } catch {
      // The connection broke: what the cache holds still shows.
      await this.#loadCachedPlace(linkId, place)
    }
  }

  /** Clears the unread count of a place on the server, and so on every device (spec 012). */
  async markRead(linkId: string, place: PlaceRef) {
    if (place.kind === "agent") {
      await this.request(linkId, "chat.markRead", { agentId: place.id }).catch(() => undefined)
    } else {
      await this.request(linkId, "channels.markRead", { channelId: place.id }).catch(
        () => undefined,
      )
    }
  }

  #readTimers = new Map<string, ReturnType<typeof setTimeout>>()

  #readIfFocused(linkId: string, place: PlaceRef) {
    const focus = this.#focus.get(linkId)
    if (!this.#active || focus?.kind !== place.kind || focus.id !== place.id) return
    const key = `${linkId}\u0000${place.kind}:${place.id}`
    if (this.#readTimers.has(key)) return
    this.#readTimers.set(
      key,
      setTimeout(() => {
        this.#readTimers.delete(key)
        void this.markRead(linkId, place)
      }, 500),
    )
  }

  // ------------------------------------------------------------------ actions in a place

  /**
   * Sends a message to an agent. The files go first, in pieces, through the upload of the link;
   * the message names them by the tokens that the server gave (spec 012).
   */
  async send(
    linkId: string,
    input: {
      readonly agentId: string
      readonly text: string
      readonly replyTo: string | null
      readonly files?: readonly UploadSource[]
    },
    onProgress?: (sent: number, total: number) => void,
  ): Promise<{ queued: boolean }> {
    const files = input.files ?? []
    if (files.length > ATTACH_MAX) throw new LinkError("too_many_files")
    for (const f of files) if (f.size > ATTACH_BYTES) throw new LinkError("file_too_large", f.name)
    const total = files.reduce((sum, f) => sum + f.size, 0)
    let sent = 0
    const tokens: string[] = []
    for (const file of files) {
      const uploadId = b64(this.#random(16))
      let offset = 0
      let token: string | null = null
      for (;;) {
        const length = Math.min(FILE_CHUNK, file.size - offset)
        const bytes = length > 0 ? await file.read(offset, length) : new Uint8Array(0)
        if (bytes.length !== length) throw new LinkError("file_unreadable", file.name)
        const done = offset + length >= file.size
        const ack = await this.request<UploadAck>(linkId, "attachment.upload", {
          uploadId,
          name: file.name,
          offset,
          data: toBase64(bytes),
          done,
        })
        offset += length
        sent += length
        onProgress?.(sent, total)
        token = ack.token
        if (done) break
      }
      if (!token?.startsWith(UPLOAD_PREFIX)) throw new LinkError("internal")
      tokens.push(token)
    }
    return this.request<{ queued: boolean }>(linkId, "chat.send", {
      agentId: input.agentId,
      text: input.text,
      replyTo: input.replyTo,
      ...(tokens.length > 0 ? { files: tokens } : {}),
    })
  }

  sendToChannel(linkId: string, channelId: string, text: string) {
    return this.request<{ awaiting: boolean }>(linkId, "channels.send", { channelId, text })
  }

  /** Names the member who takes a job that waits for a pick (spec 004). */
  assign(linkId: string, channelId: string, messageId: string, agentId: string) {
    return this.request(linkId, "channels.assign", { channelId, messageId, agentId })
  }

  stop(linkId: string, place: PlaceRef) {
    return place.kind === "agent"
      ? this.request(linkId, "chat.stop", { agentId: place.id })
      : this.request(linkId, "channels.stop", { channelId: place.id })
  }

  /** Tries a failed reply again. The answer can be the retry note of spec 005. */
  retryReply(linkId: string, agentId: string, messageId: string, confirmed = false) {
    return this.request(linkId, "chat.retry", {
      agentId,
      messageId,
      ...(confirmed ? { confirmed: true } : {}),
    })
  }

  /**
   * Answers an approval card ("allow" or "deny") or a question card (the text). A client has no
   * "Always allow" (spec 012), so the phone never sends it.
   */
  async respond(linkId: string, agentId: string, callId: string, answer: string) {
    if (answer === "always") throw new LinkError("not_allowed")
    await this.request(linkId, "tools.respond", { agentId, callId, answer })
    this.#setData(linkId, (d) => ({
      ...d,
      attention: d.attention.filter((n) => !(n.callId === callId && n.agentId === agentId)),
    }))
    this.#refreshSoon(linkId, "attention")
  }

  /** Reads a file of a message from the server, piece by piece. `write` gets each piece. */
  async download(
    linkId: string,
    file: { readonly agentId: string; readonly path: string },
    write: (bytes: Uint8Array, offset: number, size: number) => Promise<void> | void,
  ) {
    let offset = 0
    for (;;) {
      const chunk = await this.request<DownloadChunk>(linkId, "attachment.download", {
        agentId: file.agentId,
        path: file.path,
        offset,
      })
      const bytes = fromBase64(chunk.data)
      await write(bytes, offset, chunk.size)
      offset += bytes.length
      if (chunk.done || bytes.length === 0) return chunk.size
    }
  }

  // ------------------------------------------------------------------ the cache

  async #readCache(linkId: string): Promise<ServerData> {
    const dir = cacheDir(linkId)
    const storage = this.#options.storage
    const [places, agents, channels] = await Promise.all([
      readJson<PlaceSection[] | null>(storage, `${dir}/places.json`, null),
      readJson<Agent[] | null>(storage, `${dir}/agents.json`, null),
      readJson<Channel[] | null>(storage, `${dir}/channels.json`, null),
    ])
    return { ...EMPTY, places, agents, channels }
  }

  #saveChat(linkId: string, agentId: string) {
    this.#save(linkId, `chat-${safeName(agentId)}`, () => {
      const chat = this.#views.get(linkId)?.data.chats[agentId]
      return JSON.stringify(chat ? { ...chat, messages: newest(chat.messages) } : null)
    })
  }

  #saveChannel(linkId: string, channelId: string) {
    this.#save(linkId, `channel-${safeName(channelId)}`, () => {
      const list = this.#views.get(linkId)?.data.channelMessages[channelId]
      return JSON.stringify(list ? newest(list) : null)
    })
  }

  /** Writes a file of the cache a moment later, so a streamed reply writes once in a while. */
  #save(linkId: string, name: string, text: () => string) {
    const path = `${cacheDir(linkId)}/${name}.json`
    this.#pendingSaves.set(path, text)
    if (this.#saveTimers.has(path)) return
    this.#saveTimers.set(
      path,
      setTimeout(() => {
        this.#saveTimers.delete(path)
        const make = this.#pendingSaves.get(path)
        this.#pendingSaves.delete(path)
        if (!make || !this.#views.has(linkId)) return
        if (this.#views.get(linkId)?.state === "not_allowed") return
        void this.#options.storage.write(path, make()).catch(() => undefined)
      }, SAVE_MS),
    )
  }

  /** Writes every waiting file of the cache now, for example before the app goes away. */
  async flush() {
    const todo = [...this.#pendingSaves.entries()]
    this.#pendingSaves.clear()
    for (const timer of this.#saveTimers.values()) clearTimeout(timer)
    this.#saveTimers.clear()
    await Promise.all(
      todo.map(([path, make]) => this.#options.storage.write(path, make()).catch(() => undefined)),
    )
  }

  #dropSaves(linkId: string) {
    const prefix = `${cacheDir(linkId)}/`
    for (const [path, timer] of this.#saveTimers) {
      if (!path.startsWith(prefix)) continue
      clearTimeout(timer)
      this.#saveTimers.delete(path)
      this.#pendingSaves.delete(path)
    }
  }

  #random(length: number) {
    return (this.#options.random ?? systemRandom)(length)
  }

  #now() {
    return (this.#options.now ?? Date.now)()
  }
}

/** A device name: no spaces at the ends, no control characters, at most 40 characters. */
export const cleanName = (name: string) =>
  [...name.replace(/\p{Cc}/gu, "").trim()].slice(0, DEVICE_NAME_MAX).join("").trim()
