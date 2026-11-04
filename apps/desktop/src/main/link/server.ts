import {
  Conn,
  DECISION_MS,
  fromUtf8,
  HANDSHAKE_MS,
  type JoinResult,
  LINK_PROLOGUE,
  LINK_PROTOCOL,
  type LinkAnswer,
  type LinkHello,
  NoiseHandshake,
  PAIR_AAD,
  PAIR_IDS,
  type PairDevice,
  type PairMessage,
  pairingCiphers,
  SecureChannel,
  Spake2,
  toPairDevice,
  utf8,
  type WireDevice,
} from "@robot/link"
import type { WebSocket } from "ws"
import { WebSocketServer } from "ws"
import { b64, fromB64, type Identity } from "./identity.ts"
import { wsSocket } from "./ws.ts"

/** A pairing code that the server shows. `w` is the number that SPAKE2 makes from the code. */
export interface ServerOffer {
  readonly w: bigint
  readonly ended: boolean
}

export interface ClientSession {
  readonly device: WireDevice
  readonly channel: SecureChannel
}

/** What the listener needs from the app. */
export interface LinkHost {
  readonly identity: Identity
  /** The name and kind of this device, now. */
  device(): WireDevice
  serverId(): string
  appVersion(): string
  /** False when "Let other devices connect" is off. */
  accepting(): boolean
  offer(): ServerOffer | undefined
  /** A client sent a wrong code. */
  wrongCode(offer: ServerOffer): void
  /** A client proved the code. Returns false when the code was used or ended meanwhile. */
  useCode(offer: ServerOffer): boolean
  /** A device that proved the code asks to join. Resolves when the user decided. */
  join(request: {
    device: PairDevice
    twoWay: boolean
    addresses: readonly string[]
  }): Promise<JoinResult>
  /** The linked client with this public key, or undefined. */
  client(publicKey: Uint8Array): WireDevice | undefined
  session(session: ClientSession): void
}

const MAX_HANDSHAKES = 32

export class LinkServer {
  readonly #host: LinkHost
  readonly #handshakeMs: number
  #wss: WebSocketServer | undefined
  #handshakes = 0
  readonly #open = new Set<Conn>()

  constructor(host: LinkHost, options: { handshakeMs?: number } = {}) {
    this.#host = host
    this.#handshakeMs = options.handshakeMs ?? HANDSHAKE_MS
  }

  get port(): number | null {
    const address = this.#wss?.address()
    return address && typeof address === "object" ? address.port : null
  }

  /**
   * Starts to listen. Resolves with the port. `host` is the address to listen on; with none, the
   * listener takes all addresses of this computer.
   */
  listen(port: number, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port,
        ...(host ? { host } : {}),
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
      })
      wss.once("error", reject)
      wss.once("listening", () => {
        wss.off("error", reject)
        wss.on("error", () => {})
        this.#wss = wss
        wss.on("connection", (ws) => void this.#accept(ws))
        resolve(this.port ?? port)
      })
    })
  }

  /** Stops to listen and closes every connection, also those of linked devices. */
  close() {
    const wss = this.#wss
    this.#wss = undefined
    for (const conn of this.#open) conn.terminate()
    this.#open.clear()
    wss?.close()
  }

  async #accept(ws: WebSocket) {
    const conn = new Conn(wsSocket(ws))
    this.#open.add(conn)
    conn.onClose(() => this.#open.delete(conn))
    if (this.#handshakes >= MAX_HANDSHAKES || !this.#host.accepting()) {
      // A short pause keeps the answer apart from the upgrade reply, which some web socket
      // clients do not read when both come in one packet.
      return void setTimeout(() => {
        conn.sendText({ t: "error", code: "not_accepting" })
        conn.close(4403)
      }, 30)
    }
    this.#handshakes++
    let handed = false
    try {
      const hello = await conn.nextText(this.#handshakeMs)
      if (hello.robot !== "link") return conn.close(4400)
      if (hello.v !== LINK_PROTOCOL) {
        conn.sendText({ t: "error", code: "version", v: LINK_PROTOCOL })
        return conn.close(4426)
      }
      if (hello.mode === "pair") {
        handed = true
        this.#handshakes--
        await this.#pair(conn, hello)
      } else if (hello.mode === "link") {
        handed = true
        this.#handshakes--
        await this.#link(conn, hello)
      } else conn.close(4400)
    } catch {
      conn.close(4400)
    } finally {
      if (!handed) this.#handshakes--
    }
  }

  async #pair(conn: Conn, hello: Record<string, unknown>) {
    const offer = this.#host.offer()
    if (!offer || offer.ended) {
      conn.sendText({ t: "error", code: "code_ended" })
      return conn.close(4403)
    }
    const spake = new Spake2("B", offer.w, { ...PAIR_IDS, aad: PAIR_AAD })
    let result: ReturnType<Spake2["finish"]>
    try {
      result = spake.finish(fromB64(String(hello.a)))
    } catch {
      return conn.close(4400)
    }
    conn.sendText({ t: "pair-b", b: b64(spake.message) })
    const confirm = await conn.nextText(this.#handshakeMs)
    const current = this.#host.offer()
    if (current !== offer || offer.ended) {
      conn.sendText({ t: "error", code: "code_ended" })
      return conn.close(4403)
    }
    if (confirm.t !== "pair-c" || !result.verify(fromB64(String(confirm.c)))) {
      this.#host.wrongCode(offer)
      conn.sendText({ t: "error", code: "wrong_code" })
      return conn.close(4403)
    }
    if (!this.#host.useCode(offer)) {
      conn.sendText({ t: "error", code: "code_ended" })
      return conn.close(4403)
    }
    conn.sendText({ t: "pair-c", c: b64(result.confirmation) })
    const channel = new SecureChannel(conn, pairingCiphers(result.key, false))
    const identity = this.#host.identity
    const self = this.#host.device()
    channel.send({
      type: "hello",
      v: LINK_PROTOCOL,
      device: toPairDevice(self, identity.publicKey, this.#host.serverId()),
      app: this.#host.appVersion(),
    } satisfies PairMessage)
    // The device now has up to two minutes for its user and ours to answer.
    const timer = setTimeout(() => channel.close(4408), DECISION_MS + HANDSHAKE_MS)
    channel.onClose(() => clearTimeout(timer))
    channel.onMessage(async (message) => {
      const join = message as PairMessage
      if (join.type !== "join" || join.v !== LINK_PROTOCOL) return channel.close(4400)
      try {
        const answer = await this.#host.join({
          device: join.device,
          twoWay: join.twoWay === true,
          addresses: join.addresses ?? [],
        })
        channel.send({
          type: "joined",
          v: LINK_PROTOCOL,
          ...answer,
          ...(answer.ok
            ? { device: toPairDevice(self, identity.publicKey, this.#host.serverId()) }
            : {}),
        } satisfies PairMessage)
      } catch {
        channel.send({ type: "joined", v: LINK_PROTOCOL, ok: false, code: "denied" })
      }
      setTimeout(() => channel.close(), 500)
    })
  }

  async #link(conn: Conn, hello: Record<string, unknown>) {
    const identity = this.#host.identity
    const noise = new NoiseHandshake({
      pattern: "IK",
      initiator: false,
      prologue: LINK_PROLOGUE,
      staticKey: identity,
    })
    let first: LinkHello
    try {
      first = JSON.parse(fromUtf8(noise.read(fromB64(String(hello.m))))) as LinkHello
    } catch {
      // A device that does not hold our public key cannot make a message that opens.
      return conn.close(4400)
    }
    const remote = noise.remoteStatic
    const known = remote ? this.#host.client(remote) : undefined
    const send = (answer: LinkAnswer) =>
      conn.sendText({ t: "link-2", m: b64(noise.write(utf8(JSON.stringify(answer)))) })
    if (!known || !this.#host.accepting()) {
      send({
        ok: false,
        v: LINK_PROTOCOL,
        code: this.#host.accepting() ? "not_allowed" : "not_accepting",
      })
      return setTimeout(() => conn.close(4403), 200)
    }
    send({
      ok: true,
      v: LINK_PROTOCOL,
      device: this.#host.device(),
      serverId: this.#host.serverId(),
      app: this.#host.appVersion(),
    })
    const done = noise.done
    if (!done) return conn.close(4400)
    const channel = new SecureChannel(conn, { send: done.send, receive: done.receive })
    // The name in the message is the newest name of the device; the key decides who it is.
    const name = typeof first.device?.name === "string" ? first.device.name : known.name
    this.#host.session({ device: { ...known, name }, channel })
  }
}
