import type { RandomBytes } from "./bytes.ts"
import type { SecureChannel } from "./channel.ts"
import { openAny, openLinked } from "./client.ts"
import { LinkError } from "./errors.ts"
import type { Identity } from "./identity.ts"
import type { SocketOpener } from "./socket.ts"
import { LINK_PROTOCOL, type LinkState, RECONNECT_MAX_MS, type WireDevice } from "./wire.ts"

/** What the connection needs to know about the server it opens. */
export interface ConnectionTarget {
  readonly id: string
  readonly publicKey: Uint8Array
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
  readonly opener: SocketOpener
  /** The longest wait between two tries. */
  readonly maxDelayMs?: number
  /** How many failed tries turn Reconnecting into Offline. */
  readonly offlineAfter?: number
  /** How long one address gets to answer. */
  readonly connectMs?: number
  /** How often the connection checks that the server still answers. */
  readonly pingMs?: number
  readonly random?: RandomBytes
}

const REQUEST_MS = 30_000
const PING_MS = 10_000
/**
 * A socket of the browser API cannot send a ping frame. Then the connection asks for the summary
 * of the server. Any reply shows that the server is still there, also an error reply: the server
 * has no handler for this request, so it answers "not allowed" and does nothing.
 */
const HEARTBEAT_METHOD = "server.summary"

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
  #attempting = false
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
    this.#attempting = false
    clearTimeout(this.#timer)
    this.#drop()
  }

  /** Tries at once, when the connection is not open. Used when the user asks, or the app returns. */
  retryNow() {
    if (this.#stopped || this.#channel || this.#state === "not_allowed") return
    if (this.#attempting) return
    clearTimeout(this.#timer)
    void this.#attempt()
  }

  /**
   * Checks that an open connection still works, at once. A phone calls this when the app comes
   * back: the system may have cut the socket while the app was away, with no sign. A connection
   * that does not answer in `ms` is closed, and the next try starts at once.
   */
  async check(ms = 3_000): Promise<boolean> {
    if (!this.#channel || this.#state !== "online") {
      this.retryNow()
      return false
    }
    const channel = this.#channel
    try {
      await this.request(HEARTBEAT_METHOD, undefined, ms)
      return true
    } catch (error) {
      if (this.#channel === channel && !(error instanceof LinkError && error.code !== "timeout")) {
        channel.conn.terminate()
      }
      return false
    }
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
    if (this.#stopped) channel?.conn.terminate()
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
    this.#attempting = true
    try {
      const opened = await openAny(
        target.addresses,
        this.#options.opener,
        this.#options.connectMs ?? 3_000,
      )
      if (token !== this.#token) return opened.conn.close()
      const linked = await openLinked(
        opened.conn,
        this.#options.identity,
        { publicKey: target.publicKey },
        this.#options.self(),
        this.#options.random ? { random: this.#options.random } : {},
      ).catch((error) => {
        opened.conn.close()
        throw error
      })
      if (token !== this.#token) return linked.channel.close()
      this.#attempting = false
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
      this.#attempting = false
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
    const socket = channel.conn.socket
    const every = this.#options.pingMs ?? PING_MS
    if (socket.ping && socket.onPong) {
      let alive = true
      socket.onPong(() => {
        alive = true
      })
      this.#ping = setInterval(() => {
        if (!alive) return socket.terminate()
        alive = false
        try {
          socket.ping?.()
        } catch {
          socket.terminate()
        }
      }, every)
    } else {
      // No ping frames: a request that the server answers shows that it is still there.
      this.#ping = setInterval(() => {
        if (this.#channel !== channel) return
        void this.request(HEARTBEAT_METHOD, undefined, every).catch((error: unknown) => {
          if (this.#channel === channel && error instanceof LinkError && error.code === "timeout") {
            socket.terminate()
          }
        })
      }, every)
    }
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
