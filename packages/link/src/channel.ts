import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concat, fromUtf8, utf8 } from "./bytes.ts"
import { CipherState, NOISE_MAX_MESSAGE } from "./crypto/noise.ts"
import type { Conn, Frame } from "./socket.ts"

/** The largest message, after the records are put together. A larger one closes the channel. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

const PAIRING_CHANNEL_INFO = "ROBot device link: pairing channel"

/** Two keys for the two directions, from the 16-byte key of a SPAKE2 run. */
export const pairingCiphers = (key: Uint8Array, initiator: boolean) => {
  const material = hkdf(sha256, key, new Uint8Array(0), utf8(PAIRING_CHANNEL_INFO), 64)
  const toServer = new CipherState(material.slice(0, 32))
  const toClient = new CipherState(material.slice(32, 64))
  return initiator ? { send: toServer, receive: toClient } : { send: toClient, receive: toServer }
}

const EMPTY = new Uint8Array(0)

/**
 * Messages sealed in both directions. A message is cut into records of at most 65535 bytes. Each
 * record has one flag byte inside the seal: 1 when more records follow, 0 for the last one.
 */
export class SecureChannel {
  readonly conn: Conn
  readonly #send: CipherState
  readonly #receive: CipherState
  #partial: Uint8Array[] = []
  #partialBytes = 0
  #handler: ((message: unknown) => void) | undefined
  /** Messages that came before the first handler. They go to the handler when it is set. */
  #early: unknown[] = []

  constructor(conn: Conn, ciphers: { send: CipherState; receive: CipherState }) {
    this.conn = conn
    this.#send = ciphers.send
    this.#receive = ciphers.receive
    conn.takeOver((frame) => this.#onFrame(frame))
  }

  onMessage(handler: (message: unknown) => void) {
    this.#handler = handler
    // The other side can send its first message together with the last handshake message.
    for (const message of this.#early.splice(0)) handler(message)
  }

  onClose(handler: (code: number) => void) {
    this.conn.onClose(handler)
  }

  #onFrame(frame: Frame) {
    if (!("binary" in frame)) return this.conn.close(4400)
    let plain: Uint8Array
    try {
      plain = this.#receive.open(EMPTY, frame.binary)
    } catch {
      // A record that does not open means a wrong key, a changed record or a repeated one.
      return this.conn.close(4401)
    }
    if (plain.length === 0) return this.conn.close(4400)
    const more = plain[0] === 1
    this.#partial.push(plain.subarray(1))
    this.#partialBytes += plain.length - 1
    if (this.#partialBytes > MAX_MESSAGE_BYTES) return this.conn.close(4413)
    if (more) return
    const body = concat(...this.#partial)
    this.#partial = []
    this.#partialBytes = 0
    let message: unknown
    try {
      message = JSON.parse(fromUtf8(body))
    } catch {
      return this.conn.close(4400)
    }
    if (this.#handler) this.#handler(message)
    else this.#early.push(message)
  }

  send(message: unknown) {
    const body = utf8(JSON.stringify(message))
    const piece = NOISE_MAX_MESSAGE - 1 - 16
    let offset = 0
    do {
      const chunk = body.subarray(offset, offset + piece)
      offset += chunk.length
      const last = offset >= body.length
      this.conn.sendBinary(this.#send.seal(EMPTY, concat(Uint8Array.of(last ? 0 : 1), chunk)))
    } while (offset < body.length)
  }

  close(code = 1000) {
    this.conn.close(code)
  }
}
