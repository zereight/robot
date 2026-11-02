import { LINK_PROTOCOL, type LinkState, RECONNECT_MAX_MS, type WireDevice } from "@robot/shared"
import type { SecureChannel } from "./channel.ts"
import { LinkError, openAny, openLinked } from "./client.ts"
import type { Identity } from "./identity.ts"

/** What the connection needs to know about the server it opens. */
export interface ConnectionTarget {
  readonly id: string
  readonly publicKey: Buffer
  readonly addresses: readonly string[]
}

export interface ConnectionHooks {
  onState(state: LinkState, updateSide: "this" | "server" | null): void
  /** An event that the server pushed. */
  onEvent(event: string, payload: unknown): void
  /** The server said hello: its name, its server id and the address that worked. */
  onOnline(info: { name: string; serverId: string; address: string }): void
  /** The server does not know this device any more. The link is over until the user pairs again. */
  onRevoked(): void
}

export interface ConnectionOptions {
  readonly identity: Identity
  readonly self: () => WireDevice
  /** The newest data of the link, or undefined when the link was removed. */
  readonly target: () => ConnectionTarget | undefined
  readonly hooks: ConnectionHooks
  /** The longest wait between two tries. */
  readonly maxDelayMs?: number
  /** How many failed tries turn Reconnecting into Offline. */
  readonly offlineAfter?: number
  /** How long one address gets to answer. */
  readonly connectMs?: number
}

const REQUEST_MS = 30_000
const PING_MS = 10_000

/**
 * One linked server, seen from the client. It opens the server, keeps the connection, and tries
 * again with a growing wait when the connection is lost (spec 012, States).
 */
export class Connection {
  readonly #options: ConnectionOptions
  #state: LinkState = "connecting"
  #updateSide: "this" | "server" | null = null
  #channel: SecureChannel | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #ping: ReturnType<typeof setInterval> | undefined
  #failures = 0
  #wasOnline = false
  #stopped = true
  #token = 0
  #nextId = 1
  readonly #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(options: ConnectionOptions) {
    this.#options = options
  }

  get state() {
    return this.#state
  }

  get updateSide() {
    return this.#updateSide
  }

  #set(state: LinkState, side: "this" | "server" | null = null) {
    if (state === this.#state && side === this.#updateSide) return
    this.#state = state
    this.#updateSide = side
    this.#options.hooks.onState(state, side)
  }

  /** Opens the server now, and keeps it open. */
  start() {
    this.#stopped = false
    this.#failures = 0
    this.#set("connecting")
    void this.#attempt()
  }

  /** Closes the connection and stops all tries. */
  stop() {
    this.#stopped = true
    this.#token++
    clearTimeout(this.#timer)
    this.#drop()
  }

  /** Tries at once, when the connection is not open. Used when the user clicks the tile. */
  retryNow() {
    if (this.#stopped || this.#channel || this.#state === "not_allowed") return
    clearTimeout(this.#timer)
    void this.#attempt()
  }

  /** Starts again after the user paired again. */
  restart() {
    this.stop()
    this.#wasOnline = false
    this.start()
  }

  #drop() {
    clearInterval(this.#ping)
    const channel = this.#channel
    this.#channel = undefined
    channel?.close(1000)
    // The socket of a connection that was stopped does not wait for the other side to answer
    // the close: the app can end at once (a quit must not wait for a computer that is away).
    if (this.#stopped) channel?.conn.ws.terminate()
    for (const [id, request] of this.#pending) {
      clearTimeout(request.timer)
      request.reject(new LinkError("offline"))
      this.#pending.delete(id)
    }
  }

  async #attempt() {
    const target = this.#options.target()
    if (this.#stopped || !target) return
    const token = ++this.#token
    try {
      const opened = await openAny(target.addresses, this.#options.connectMs ?? 3_000)
      if (token !== this.#token) return opened.conn.close()
      const linked = await openLinked(
        opened.conn,
        this.#options.identity,
        { publicKey: target.publicKey },
        this.#options.self(),
      )
      if (token !== this.#token) return linked.channel.close()
      this.#attach(linked.channel)
      this.#failures = 0
      this.#wasOnline = true
      this.#set("online")
      this.#options.hooks.onOnline({
        name: linked.device.name,
        serverId: linked.serverId,
        address: opened.address,
      })
    } catch (error) {
      if (token !== this.#token) return
      this.#failed(error)
    }
  }

  #failed(error: unknown) {
    const code = error instanceof LinkError ? error.code : "unreachable"
    if (code === "not_allowed") {
      this.#stopped = true
      this.#set("not_allowed")
      this.#options.hooks.onRevoked()
      return
    }
    if (code === "update_app") {
      const side = (error as LinkError).detail === "this" ? "this" : "server"
      this.#set("update_app", side)
      this.#schedule(this.#options.maxDelayMs ?? RECONNECT_MAX_MS)
      return
    }
    this.#failures++
    const limit = this.#options.offlineAfter ?? 3
    this.#set(this.#wasOnline && this.#failures < limit ? "reconnecting" : "offline")
    // 0.5 s, 1 s, 2 s, 4 s ... up to the longest wait.
    const wait = Math.min(
      this.#options.maxDelayMs ?? RECONNECT_MAX_MS,
      500 * 2 ** (this.#failures - 1),
    )
    this.#schedule(wait)
  }

  #schedule(ms: number) {
    clearTimeout(this.#timer)
    if (this.#stopped) return
    this.#timer = setTimeout(() => void this.#attempt(), ms)
  }

  #attach(channel: SecureChannel) {
    this.#channel = channel
    // A message that comes while the channel closes, or after the connection stopped, is dropped.
    channel.onMessage((message) => {
      if (this.#channel === channel) this.#onMessage(message)
    })
    channel.onClose(() => {
      if (this.#channel !== channel) return
      this.#drop()
      if (this.#stopped) return
      this.#failures = 0
      this.#set("reconnecting")
      this.#schedule(500)
    })
    let alive = true
    const ws = channel.conn.ws
    ws.on("pong", () => {
      alive = true
    })
    this.#ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }, PING_MS)
  }

  #onMessage(message: unknown) {
    const m = message as {
      type?: string
      id?: number
      ok?: boolean
      value?: unknown
      error?: { code: string; message: string }
      event?: string
      payload?: unknown
    }
    if (m.type === "response" && typeof m.id === "number") {
      const request = this.#pending.get(m.id)
      if (!request) return
      this.#pending.delete(m.id)
      clearTimeout(request.timer)
      if (m.ok) request.resolve(m.value)
      else request.reject(new LinkError(m.error?.code ?? "internal", m.error?.message))
      return
    }
    if (m.type === "event" && typeof m.event === "string") {
      if (m.event === "revoked") {
        this.#stopped = true
        clearTimeout(this.#timer)
        this.#drop()
        this.#set("not_allowed")
        this.#options.hooks.onRevoked()
        return
      }
      this.#options.hooks.onEvent(m.event, m.payload)
    }
  }

  /** Asks the server. Rejects with a `LinkError`: `offline` when the connection is not open. */
  request(method: string, input?: unknown, ms = REQUEST_MS): Promise<unknown> {
    const channel = this.#channel
    if (!channel || this.#state !== "online") return Promise.reject(new LinkError("offline"))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new LinkError("timeout"))
      }, ms)
      this.#pending.set(id, { resolve, reject, timer })
      channel.send({ v: LINK_PROTOCOL, type: "request", id, method, input })
    })
  }
}
