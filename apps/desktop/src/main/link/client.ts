import { scryptSync } from "node:crypto"
import { connect } from "node:net"
import {
  type Address,
  type Conn,
  openAny as openAnyWith,
  PAIR_SCRYPT,
  type PairedChannel,
  pairWithCode as pairWith,
  wFromScrypt,
} from "@robot/link"
import { wsOpener } from "./ws.ts"

// The client side of the link is `@robot/link`, which the phone uses too. This file gives it what
// only the desktop has: the sockets of the `ws` package, the codes of the system for a failed
// connection, and the scrypt of Node, which is faster than the one in plain JavaScript.
export { LinkError, type LinkedChannel, type Opened, openLinked } from "@robot/link"

/**
 * The system code of a failed connection (for example ECONNREFUSED). The error of the `ws`
 * package has the code. A web socket that follows the browser API, such as the one that is built
 * into Bun 1.4.2, reports a failure as an event with no code, so "refused", "no such host" and
 * "no route" look the same. Then one plain connect to the same address gives the real code.
 * An error with no code (for example a handshake that timed out) is not probed: it stays "ERR".
 */
export const failureCode = (error: unknown, address: Address, ms: number): Promise<string> => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code) return Promise.resolve(code)
  if (error instanceof Error) return Promise.resolve("ERR")
  return new Promise((resolve) => {
    const socket = connect({ host: address.host, port: address.port })
    const end = (result: string) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(ms, () => end("ETIMEDOUT"))
    // The port accepts a connection, so the reason is not a refusal.
    socket.once("connect", () => end("ERR"))
    socket.once("error", (reason: NodeJS.ErrnoException) => end(reason.code ?? "ERR"))
  })
}

/** The number that SPAKE2 makes from a pairing code, with the scrypt of Node. */
export const codeToW = (code: string): bigint =>
  wFromScrypt(
    scryptSync(code, PAIR_SCRYPT.salt, PAIR_SCRYPT.dkLen, {
      N: PAIR_SCRYPT.N,
      r: PAIR_SCRYPT.r,
      p: PAIR_SCRYPT.p,
      maxmem: 64 * 1024 * 1024,
    }),
  )

/** Tries the addresses in order with sockets of the `ws` package. */
export const openAny = (addresses: readonly string[], ms = 3_000) =>
  openAnyWith(addresses, wsOpener, ms)

/** Proves the pairing code to the server, then reads the identity of the server. */
export const pairWithCode = (conn: Conn, code: string): Promise<PairedChannel> =>
  pairWith(conn, code, { deriveW: codeToW })
