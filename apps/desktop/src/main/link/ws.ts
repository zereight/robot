import type { LinkSocket, SocketData, SocketOpener } from "@robot/link"
import { LinkError, socketUrl } from "@robot/link"
import WebSocket from "ws"
import { failureCode } from "./client.ts"

/**
 * The link of `@robot/link` on a socket of the `ws` package. It is the socket of both sides on
 * the desktop: the listener gets one for each device, and the client opens one for each server.
 * Frames that come before the first handler wait, so a handshake loses none.
 */
export const wsSocket = (ws: WebSocket): LinkSocket => {
  const early: SocketData[] = []
  let handler: ((data: SocketData) => void) | undefined
  ws.on("message", (data, isBinary) => {
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data)
    const frame: SocketData = isBinary ? new Uint8Array(buffer) : buffer.toString("utf8")
    if (handler) handler(frame)
    else early.push(frame)
  })
  ws.on("error", () => {
    // A failed socket also emits "close"; the reason does not matter to the app.
  })
  return {
    send: (data) => {
      if (typeof data === "string") ws.send(data)
      else ws.send(data, { binary: true })
    },
    close: (code) => ws.close(code),
    terminate: () => ws.terminate(),
    onMessage: (h) => {
      handler = h
      for (const frame of early.splice(0)) h(frame)
    },
    onClose: (h) => {
      ws.on("close", (code) => h(code))
    },
    ping: () => ws.ping(),
    onPong: (h) => {
      ws.on("pong", h)
    },
  }
}

/**
 * Opens one socket with the `ws` package. Rejects with the error code of the system (for example
 * ECONNREFUSED). Then the client can tell a computer that does not accept connections apart
 * from a computer that it cannot reach.
 */
export const wsOpener: SocketOpener = (address, ms) =>
  new Promise<LinkSocket>((resolve, reject) => {
    const ws = new WebSocket(socketUrl(address), {
      handshakeTimeout: ms,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    })
    // The wrapper listens from the start, so a frame that comes with the open is not lost.
    const socket = wsSocket(ws)
    ws.once("open", () => resolve(socket))
    ws.once("error", (error: unknown) => {
      void failureCode(error, address, ms).then((code) => reject(new LinkError(code)))
    })
    ws.once("unexpected-response", () => {
      ws.terminate()
      reject(new LinkError("ERR"))
    })
  })
