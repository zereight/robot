import { LINK_PROTOCOL, type WireDevice } from "@robot/shared"
import { b64 } from "./identity.ts"

/** Mixed into every linked handshake, so a handshake of another version or purpose fails. */
export const LINK_PROLOGUE = Buffer.from(`ROBot device link v${LINK_PROTOCOL}`)

/** Names of the two sides in the pairing run (the identities of RFC 9382). */
export const PAIR_IDS = { idA: "ROBot client", idB: "ROBot server" } as const
export const PAIR_AAD = Buffer.from(`ROBot device link v${LINK_PROTOCOL}`)

/** How long a side waits for the other side in a handshake. */
export const HANDSHAKE_MS = 8_000
/** How long a server waits for its user to allow a new device. */
export const DECISION_MS = 120_000

/** The public identity of a device, as it travels in the pairing run. */
export interface PairDevice extends WireDevice {
  readonly publicKey: string
  /** The id of the server that this device is, so the other side can show its tile. */
  readonly serverId: string
}

export type JoinResult =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly code: "denied" | "limit" | "same_device" | "not_accepting" }

/** Messages inside the pairing channel, after the code was proved. */
export type PairMessage =
  | {
      readonly type: "hello"
      readonly v: number
      readonly device: PairDevice
      readonly app: string
    }
  | {
      readonly type: "join"
      readonly v: number
      readonly device: PairDevice
      readonly twoWay: boolean
      readonly addresses: readonly string[]
    }
  | ({ readonly type: "joined"; readonly v: number; readonly device?: PairDevice } & JoinResult)

export const toPairDevice = (
  device: WireDevice,
  publicKey: Buffer,
  serverId: string,
): PairDevice => ({ ...device, publicKey: b64(publicKey), serverId })

/** What the first message of a linked connection holds, and what the answer holds. */
export interface LinkHello {
  readonly v: number
  readonly device: WireDevice
}
export type LinkAnswer =
  | {
      readonly ok: true
      readonly v: number
      readonly device: WireDevice
      readonly serverId: string
      readonly app: string
    }
  | { readonly ok: false; readonly v: number; readonly code: "not_allowed" | "not_accepting" }
