import { b64, fromB64, fromUtf8, type RandomBytes, utf8 } from "./bytes.ts"
import { pairingCiphers, SecureChannel } from "./channel.ts"
import { NoiseHandshake } from "./crypto/noise.ts"
import { codeToWAsync, Spake2 } from "./crypto/spake2.ts"
import { LinkError, updateSide } from "./errors.ts"
import type { Identity } from "./identity.ts"
import {
  HANDSHAKE_MS,
  LINK_PROLOGUE,
  type LinkAnswer,
  type LinkHello,
  PAIR_AAD,
  PAIR_IDS,
  type PairMessage,
} from "./protocol.ts"
import { Conn, type SocketOpener } from "./socket.ts"
import { LINK_PROTOCOL, parseAddress, type WireDevice } from "./wire.ts"

export interface Opened {
  readonly conn: Conn
  /** The address that worked, as the user types it. */
  readonly address: string
}

/**
 * Tries the addresses in order and returns the first socket that opens. When every address
 * refuses, the computer is reachable but does not accept connections.
 */
export const openAny = async (
  addresses: readonly string[],
  opener: SocketOpener,
  ms = 3_000,
): Promise<Opened> => {
  const parsed = addresses.flatMap((a) => {
    const p = parseAddress(a)
    return p ? [{ text: a, address: p }] : []
  })
  if (parsed.length === 0) throw new LinkError("invalid_link")
  const errors: string[] = []
  for (const { text, address } of parsed) {
    try {
      return { conn: new Conn(await opener(address, ms)), address: text }
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      errors.push(typeof code === "string" ? code : "ERR")
    }
  }
  throw new LinkError(errors.every((e) => e === "ECONNREFUSED") ? "not_accepting" : "unreachable")
}

/** Maps an error message of the server to a `LinkError`. */
const fromServer = (message: Record<string, unknown>): LinkError => {
  const code = String(message.code)
  if (code === "version") {
    return new LinkError("update_app", updateSide(Number(message.v), LINK_PROTOCOL))
  }
  return new LinkError(code)
}

export interface PairedChannel {
  readonly channel: SecureChannel
  readonly hello: Extract<PairMessage, { type: "hello" }>
}

export interface PairOptions {
  /** Turns the code into the number of SPAKE2. In small steps by default, so a screen draws. */
  readonly deriveW?: (code: string) => bigint | Promise<bigint>
  /**
   * The number of the code, made before the socket opened. A slow device (a phone) makes it first,
   * because the server ends a pairing that sends nothing within `HANDSHAKE_MS`.
   */
  readonly w?: bigint
  readonly random?: RandomBytes
  readonly handshakeMs?: number
}

/**
 * Proves the pairing code to the server, then reads the identity of the server. The server
 * does not learn the code unless it already knows it.
 */
export const pairWithCode = async (
  conn: Conn,
  code: string,
  options: PairOptions = {},
): Promise<PairedChannel> => {
  const ms = options.handshakeMs ?? HANDSHAKE_MS
  const w = options.w ?? (await (options.deriveW ?? codeToWAsync)(code))
  const spake = new Spake2("A", w, {
    ...PAIR_IDS,
    aad: PAIR_AAD,
    ...(options.random ? { random: options.random } : {}),
  })
  conn.sendText({ robot: "link", v: LINK_PROTOCOL, mode: "pair", a: b64(spake.message) })
  const reply = await conn.nextText(ms).catch(() => {
    throw new LinkError("unreachable")
  })
  if (reply.t === "error") throw fromServer(reply)
  if (reply.t !== "pair-b") throw new LinkError("unreachable")
  let result: ReturnType<Spake2["finish"]>
  try {
    result = spake.finish(fromB64(String(reply.b)))
  } catch {
    throw new LinkError("unreachable")
  }
  conn.sendText({ t: "pair-c", c: b64(result.confirmation) })
  const confirm = await conn.nextText(ms).catch(() => {
    throw new LinkError("unreachable")
  })
  if (confirm.t === "error") throw fromServer(confirm)
  if (confirm.t !== "pair-c" || !result.verify(fromB64(String(confirm.c)))) {
    throw new LinkError("wrong_code")
  }
  const channel = new SecureChannel(conn, pairingCiphers(result.key, true))
  const hello = await new Promise<PairMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LinkError("unreachable")), ms)
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
  if (hello.v !== LINK_PROTOCOL) {
    throw new LinkError("update_app", updateSide(hello.v, LINK_PROTOCOL))
  }
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
  server: { readonly publicKey: Uint8Array },
  self: WireDevice,
  options: { readonly random?: RandomBytes; readonly handshakeMs?: number } = {},
): Promise<LinkedChannel> => {
  const noise = new NoiseHandshake({
    pattern: "IK",
    initiator: true,
    prologue: LINK_PROLOGUE,
    staticKey: identity,
    remoteStatic: server.publicKey,
    ...(options.random ? { random: options.random } : {}),
  })
  const hello: LinkHello = { v: LINK_PROTOCOL, device: self }
  conn.sendText({
    robot: "link",
    v: LINK_PROTOCOL,
    mode: "link",
    m: b64(noise.write(utf8(JSON.stringify(hello)))),
  })
  const reply = await conn.nextText(options.handshakeMs ?? HANDSHAKE_MS).catch(() => {
    throw new LinkError("unreachable")
  })
  if (reply.t === "error") throw fromServer(reply)
  if (reply.t !== "link-2") throw new LinkError("unreachable")
  let answer: LinkAnswer
  try {
    answer = JSON.parse(fromUtf8(noise.read(fromB64(String(reply.m))))) as LinkAnswer
  } catch {
    // The answer did not open: the other side does not hold the key of the server we paired with.
    throw new LinkError("unreachable")
  }
  if (!answer.ok) throw new LinkError(answer.code)
  if (answer.v !== LINK_PROTOCOL) {
    throw new LinkError("update_app", updateSide(answer.v, LINK_PROTOCOL))
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
