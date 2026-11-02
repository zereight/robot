import { hkdfSync } from "node:crypto"
import type WebSocket from "ws"
import { CipherState, NOISE_MAX_MESSAGE } from "./crypto/noise.ts"

/** One frame from the other side: a JSON text for the handshake, or sealed bytes. */
export type Frame = { readonly text: unknown } | { readonly binary: Buffer }

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/**
 * A web socket with a queue of frames, so a handshake can read them one at a time. After the
 * handshake, `SecureChannel` takes over.
 */
export class Conn {
  readonly ws: WebSocket
  #queue: Frame[] = []
  #waiting: { resolve: (frame: Frame) => void; reject: (error: Error) => void } | undefined
  #closed = false
  #sink: ((frame: Frame) => void) | undefined
  readonly #closeHandlers: ((code: number) => void)[] = []

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on("message", (data, isBinary) => {
      const buffer = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data)
      let frame: Frame
      if (isBinary) {
        frame = { binary: buffer }
      } else {
        try {
          frame = { text: JSON.parse(buffer.toString("utf8")) }
        } catch {
          this.close(4400)
          return
        }
      }
      if (this.#sink) this.#sink(frame)
      else if (this.#waiting) {
        const waiting = this.#waiting
        this.#waiting = undefined
        waiting.resolve(frame)
      } else this.#queue.push(frame)
    })
    ws.on("close", (code) => {
      this.#closed = true
      this.#waiting?.reject(new Error("closed"))
      this.#waiting = undefined
      for (const h of this.#closeHandlers) h(code)
    })
    ws.on("error", () => {
      // A failed socket also emits "close"; the reason does not matter to the app.
    })
  }

  get closed() {
    return this.#closed
  }

  onClose(handler: (code: number) => void) {
    this.#closeHandlers.push(handler)
  }

  /** The next frame, or a rejection when the socket closes or `ms` pass. */
  next(ms: number): Promise<Frame> {
    const queued = this.#queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.#closed) return Promise.reject(new Error("closed"))
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = undefined
        reject(new Error("timeout"))
      }, ms)
      this.#waiting = {
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

  /** The next text frame as an object. Any other frame is an error. */
  async nextText(ms: number): Promise<Record<string, unknown>> {
    const frame = await this.next(ms)
    if (!("text" in frame) || typeof frame.text !== "object" || frame.text === null) {
      throw new Error("unexpected frame")
    }
    return frame.text as Record<string, unknown>
  }

  sendText(value: unknown) {
    if (!this.#closed) this.ws.send(JSON.stringify(value))
  }

  sendBinary(bytes: Buffer) {
    if (!this.#closed) this.ws.send(bytes, { binary: true })
  }

  /** From now on frames go to `sink`; the frames that came early go first. */
  takeOver(sink: (frame: Frame) => void) {
    this.#sink = sink
    for (const frame of this.#queue.splice(0)) sink(frame)
  }

  close(code = 1000) {
    if (this.#closed) return
    try {
      this.ws.close(code)
    } catch {
      this.ws.terminate()
    }
  }
}

const PAIRING_CHANNEL_INFO = "ROBot device link: pairing channel"

/** Two keys for the two directions, from the 16-byte key of a SPAKE2 run. */
export const pairingCiphers = (key: Buffer, initiator: boolean) => {
  const material = Buffer.from(
    hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(PAIRING_CHANNEL_INFO), 64),
  )
  const toServer = new CipherState(material.subarray(0, 32))
  const toClient = new CipherState(material.subarray(32, 64))
  return initiator ? { send: toServer, receive: toClient } : { send: toClient, receive: toServer }
}

/**
 * Messages sealed in both directions. A message is cut into records of at most 65535 bytes. Each
 * record has one flag byte inside the seal: 1 when more records follow, 0 for the last one.
 */
export class SecureChannel {
  readonly conn: Conn
  readonly #send: CipherState
  readonly #receive: CipherState
  #partial: Buffer[] = []
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
    let plain: Buffer
    try {
      plain = this.#receive.open(Buffer.alloc(0), frame.binary)
    } catch {
      // A record that does not open means a wrong key, a changed record or a repeated one.
      return this.conn.close(4401)
    }
    const more = plain[0] === 1
    this.#partial.push(plain.subarray(1))
    this.#partialBytes += plain.length - 1
    if (this.#partialBytes > MAX_MESSAGE_BYTES) return this.conn.close(4413)
    if (more) return
    const body = Buffer.concat(this.#partial)
    this.#partial = []
    this.#partialBytes = 0
    let message: unknown
    try {
      message = JSON.parse(body.toString("utf8"))
    } catch {
      return this.conn.close(4400)
    }
    if (this.#handler) this.#handler(message)
    else this.#early.push(message)
  }

  send(message: unknown) {
    const body = Buffer.from(JSON.stringify(message))
    const piece = NOISE_MAX_MESSAGE - 1 - 16
    let offset = 0
    do {
      const chunk = body.subarray(offset, offset + piece)
      offset += chunk.length
      const last = offset >= body.length
      this.conn.sendBinary(
        this.#send.seal(Buffer.alloc(0), Buffer.concat([Buffer.from([last ? 0 : 1]), chunk])),
      )
    } while (offset < body.length)
  }

  close(code = 1000) {
    this.conn.close(code)
  }
}
