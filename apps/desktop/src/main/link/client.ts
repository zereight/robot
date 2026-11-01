import { type Address, LINK_PROTOCOL, parseAddress, type WireDevice } from "@robot/shared"
import WebSocket from "ws"
import { Conn, pairingCiphers, SecureChannel } from "./channel.ts"
import { NoiseHandshake } from "./crypto/noise.ts"
import { codeToW, Spake2 } from "./crypto/spake2.ts"
import { b64, fromB64, type Identity } from "./identity.ts"
import {
  HANDSHAKE_MS,
  LINK_PROLOGUE,
  type LinkAnswer,
  type LinkHello,
  PAIR_AAD,
  PAIR_IDS,
  type PairMessage,
} from "./protocol.ts"

/** Why a connection did not work. The codes are the ones of the pairing errors in the spec. */
export class LinkError extends Error {
  readonly code: string
  readonly detail: string | undefined
  constructor(code: string, detail?: string) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

const url = (a: Address) => `ws://${a.host.includes(":") ? `[${a.host}]` : a.host}:${a.port}`

/** Opens one socket. Rejects with the error code of the system (for example ECONNREFUSED). */
const open = (address: Address, ms: number) =>
  new Promise<Conn>((resolve, reject) => {
    const ws = new WebSocket(url(address), {
      handshakeTimeout: ms,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    })
    // The wrapper listens from the start, so a frame that comes with the open is not lost.
    const conn = new Conn(ws)
    ws.once("open", () => resolve(conn))
    ws.once("error", (error: NodeJS.ErrnoException) => reject(new LinkError(error.code ?? "ERR")))
    ws.once("unexpected-response", () => {
      ws.terminate()
      reject(new LinkError("ERR"))
    })
  })

export interface Opened {
  readonly conn: Conn
  /** The address that worked, as the user types it. */
  readonly address: string
}

/**
 * Tries the addresses in order and returns the first socket that opens. When every address
 * refuses, the computer is reachable but does not accept connections.
 */
export const openAny = async (addresses: readonly string[], ms = 3_000): Promise<Opened> => {
  const parsed = addresses.flatMap((a) => {
    const p = parseAddress(a)
    return p ? [{ text: a, address: p }] : []
  })
  if (parsed.length === 0) throw new LinkError("invalid_link")
  const errors: string[] = []
  for (const { text, address } of parsed) {
    try {
      return { conn: await open(address, ms), address: text }
    } catch (error) {
      errors.push(error instanceof LinkError ? error.code : "ERR")
    }
  }
  throw new LinkError(errors.every((e) => e === "ECONNREFUSED") ? "not_accepting" : "unreachable")
}

/** Maps an error message of the server to a `LinkError`. */
const fromServer = (message: Record<string, unknown>): LinkError => {
  const code = String(message.code)
  if (code === "version") {
    const server = Number(message.v)
    return new LinkError("update_app", server > LINK_PROTOCOL ? "this" : "server")
  }
  return new LinkError(code)
}

export interface PairedChannel {
  readonly channel: SecureChannel
  readonly hello: Extract<PairMessage, { type: "hello" }>
}

/**
 * Proves the pairing code to the server, then reads the identity of the server. The server
 * does not learn the code unless it already knows it.
 */
export const pairWithCode = async (conn: Conn, code: string): Promise<PairedChannel> => {
  const spake = new Spake2("A", codeToW(code), { ...PAIR_IDS, aad: PAIR_AAD })
  conn.sendText({ robot: "link", v: LINK_PROTOCOL, mode: "pair", a: b64(spake.message) })
  const reply = await conn.nextText(HANDSHAKE_MS)
  if (reply.t === "error") throw fromServer(reply)
  if (reply.t !== "pair-b") throw new LinkError("unreachable")
  let result: ReturnType<Spake2["finish"]>
  try {
    result = spake.finish(fromB64(String(reply.b)))
  } catch {
    throw new LinkError("unreachable")
  }
  conn.sendText({ t: "pair-c", c: b64(result.confirmation) })
  const confirm = await conn.nextText(HANDSHAKE_MS)
  if (confirm.t === "error") throw fromServer(confirm)
  if (confirm.t !== "pair-c" || !result.verify(fromB64(String(confirm.c)))) {
    throw new LinkError("wrong_code")
  }
  const channel = new SecureChannel(conn, pairingCiphers(result.key, true))
  const hello = await new Promise<PairMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LinkError("unreachable")), HANDSHAKE_MS)
    channel.onMessage((m) => {
      clearTimeout(timer)
      resolve(m as PairMessage)
    })
    channel.onClose(() => {
      clearTimeout(timer)
      reject(new LinkError("unreachable"))
    })
  })
  if (hello.type !== "hello") throw new LinkError("unreachable")
  if (hello.v !== LINK_PROTOCOL)
    throw new LinkError("update_app", hello.v > LINK_PROTOCOL ? "this" : "server")
  return { channel, hello }
}

export interface LinkedChannel {
  readonly channel: SecureChannel
  readonly device: WireDevice
  readonly serverId: string
  readonly app: string
}

/**
 * Opens a linked server with the keys of the link. The server answers signed by its key, also
 * when it has removed this device ("not_allowed").
 */
export const openLinked = async (
  conn: Conn,
  identity: Identity,
  server: { readonly publicKey: Buffer },
  self: WireDevice,
): Promise<LinkedChannel> => {
  const noise = new NoiseHandshake({
    pattern: "IK",
    initiator: true,
    prologue: LINK_PROLOGUE,
    staticKey: identity,
    remoteStatic: server.publicKey,
  })
  const hello: LinkHello = { v: LINK_PROTOCOL, device: self }
  conn.sendText({
    robot: "link",
    v: LINK_PROTOCOL,
    mode: "link",
    m: b64(noise.write(Buffer.from(JSON.stringify(hello)))),
  })
  const reply = await conn.nextText(HANDSHAKE_MS)
  if (reply.t === "error") throw fromServer(reply)
  if (reply.t !== "link-2") throw new LinkError("unreachable")
  let answer: LinkAnswer
  try {
    answer = JSON.parse(noise.read(fromB64(String(reply.m))).toString("utf8")) as LinkAnswer
  } catch {
    // The answer did not open: the other side does not hold the key of the server we paired with.
    throw new LinkError("unreachable")
  }
  if (!answer.ok) throw new LinkError(answer.code)
  if (answer.v !== LINK_PROTOCOL) {
    throw new LinkError("update_app", answer.v > LINK_PROTOCOL ? "this" : "server")
  }
  const done = noise.done
  if (!done) throw new LinkError("unreachable")
  return {
    channel: new SecureChannel(conn, { send: done.send, receive: done.receive }),
    device: answer.device,
    serverId: answer.serverId,
    app: answer.app,
  }
}
