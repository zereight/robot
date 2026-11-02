import { fromUtf8 } from "./bytes.ts"
import type { Address } from "./wire.ts"

/** One frame of a web socket: a text frame is a string, a binary frame is bytes. */
export type SocketData = string | Uint8Array

/**
 * A web socket as the link needs it. Each platform gives its own: the desktop wraps the `ws`
 * package, the phone and Bun wrap the web socket of the browser API (see `browserSocket`).
 *
 * A socket keeps the frames that come before the first `onMessage` handler, so no frame is lost
 * between the open and the start of a handshake.
 */
export interface LinkSocket {
  send(data: SocketData): void
  /** Starts the close handshake. */
  close(code?: number): void
  /** Ends at once, and does not wait for the other side. */
  terminate(): void
  onMessage(handler: (data: SocketData) => void): void
  onClose(handler: (code: number) => void): void
  /** Sends a ping frame. A socket of the browser API cannot, so this is optional. */
  readonly ping?: () => void
  readonly onPong?: (handler: () => void) => void
}

/**
 * Opens a socket to an address. It rejects with a `LinkError` whose code is the system code of
 * the failure when the platform knows it (for example ECONNREFUSED), or "ERR".
 */
export type SocketOpener = (address: Address, ms: number) => Promise<LinkSocket>

/** One frame from the other side: a JSON text for the handshake, or sealed bytes. */
export type Frame = { readonly text: unknown } | { readonly binary: Uint8Array }

/**
 * A socket with a queue of frames, so a handshake can read them one at a time. After the
 * handshake, `SecureChannel` takes over.
 */
export class Conn {
  readonly socket: LinkSocket
  #queue: Frame[] = []
  #waiting: { resolve: (frame: Frame) => void; reject: (error: Error) => void } | undefined
  #closed = false
  #sink: ((frame: Frame) => void) | undefined
  readonly #closeHandlers: ((code: number) => void)[] = []

  constructor(socket: LinkSocket) {
    this.socket = socket
    socket.onMessage((data) => {
      let frame: Frame
      if (typeof data === "string") {
        try {
          frame = { text: JSON.parse(data) }
        } catch {
          this.close(4400)
          return
        }
      } else frame = { binary: data }
      if (this.#sink) this.#sink(frame)
      else if (this.#waiting) {
        const waiting = this.#waiting
        this.#waiting = undefined
        waiting.resolve(frame)
      } else this.#queue.push(frame)
    })
    socket.onClose((code) => {
      if (this.#closed) return
      this.#closed = true
      this.#waiting?.reject(new Error("closed"))
      this.#waiting = undefined
      for (const h of this.#closeHandlers) h(code)
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
    if (!this.#closed) this.socket.send(JSON.stringify(value))
  }

  sendBinary(bytes: Uint8Array) {
    if (!this.#closed) this.socket.send(bytes)
  }

  /** From now on frames go to `sink`; the frames that came early go first. */
  takeOver(sink: (frame: Frame) => void) {
    this.#sink = sink
    for (const frame of this.#queue.splice(0)) sink(frame)
  }

  close(code = 1000) {
    if (this.#closed) return
    try {
      this.socket.close(code)
    } catch {
      this.socket.terminate()
    }
  }

  terminate() {
    this.socket.terminate()
  }
}

/** The part of a web socket of the browser API that `browserSocket` uses. */
export interface BrowserWebSocket {
  binaryType: string
  readonly readyState: number
  send(data: string | ArrayBuffer): void
  close(code?: number): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type BrowserWebSocketClass = new (url: string) => BrowserWebSocket

export const socketUrl = (a: Address) =>
  `ws://${a.host.includes(":") ? `[${a.host}]` : a.host}:${a.port}`

/**
 * A `SocketOpener` for a web socket of the browser API: the one of React Native, of Bun and of a
 * browser. Such a socket reports a failure as an event with no reason, so every failure is "ERR".
 */
export const browserSocket =
  (WebSocketClass: BrowserWebSocketClass): SocketOpener =>
  (address, ms) =>
    new Promise<LinkSocket>((resolve, reject) => {
      const ws = new WebSocketClass(socketUrl(address))
      ws.binaryType = "arraybuffer"
      const early: SocketData[] = []
      let messageHandler: ((data: SocketData) => void) | undefined
      const closeHandlers: ((code: number) => void)[] = []
      let opened = false
      let ended = false
      const end = (code: number) => {
        if (ended) return
        ended = true
        for (const h of closeHandlers) h(code)
      }
      const timer = setTimeout(() => {
        if (opened) return
        ended = true
        try {
          ws.close()
        } catch {}
        reject(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }))
      }, ms)
      ws.onmessage = (event) => {
        const data = event.data
        const frame: SocketData | undefined =
          typeof data === "string"
            ? data
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : undefined
        if (frame === undefined) return
        if (messageHandler) messageHandler(frame)
        else early.push(frame)
      }
      ws.onclose = (event) => {
        clearTimeout(timer)
        if (!opened) {
          ended = true
          reject(Object.assign(new Error("ERR"), { code: "ERR" }))
          return
        }
        end(event.code ?? 1006)
      }
      ws.onerror = () => {
        // A failed socket also closes; the reason is not known in this API.
      }
      ws.onopen = () => {
        clearTimeout(timer)
        if (ended) return
        opened = true
        resolve({
          send: (data) => {
            if (ended || ws.readyState !== 1) return
            if (typeof data === "string") ws.send(data)
            else {
              // A copy, so the socket sends exactly these bytes and not the whole buffer below.
              const copy = new Uint8Array(data.length)
              copy.set(data)
              ws.send(copy.buffer)
            }
          },
          close: (code) => {
            try {
              ws.close(code)
            } catch {
              ws.close()
            }
          },
          terminate: () => {
            try {
              ws.close()
            } catch {}
            end(1006)
          },
          onMessage: (handler) => {
            messageHandler = handler
            for (const frame of early.splice(0)) handler(frame)
          },
          onClose: (handler) => {
            closeHandlers.push(handler)
            if (ended) handler(1006)
          },
        })
      }
    })

/** Text of a frame, for logs and tests. */
export const frameText = (data: SocketData) => (typeof data === "string" ? data : fromUtf8(data))
