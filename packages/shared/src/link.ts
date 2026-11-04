/**
 * The device link (spec 012) as the desktop sees it: the shapes that the main process and the
 * window use. The wire protocol itself (constants, addresses, the link text, the requests of a
 * client, the wire messages) is in `@robot/link`, which the phone uses too. It is exported again
 * here, so the desktop imports one package.
 */

import { CLIENT_METHODS, type DeviceKind, type LinkState } from "@robot/link/wire"
import type { ModelInfo, ProviderKind } from "./providers.ts"

export * from "@robot/link/wire"

/**
 * What the window asks a linked server for: the methods the server answers to a client, minus the
 * two that only exist on the link, plus the ones that this computer carries out for the window.
 * The window sends the id of the server with these, and the app sends them over the link.
 */
export const ROUTED_METHODS = [
  ...CLIENT_METHODS.filter(
    (m) =>
      m !== "server.summary" &&
      m !== "attachment.upload" &&
      m !== "attachment.download" &&
      !m.startsWith("sync."),
  ),
  "attachments.save",
] as const
export type RoutedMethod = (typeof ROUTED_METHODS)[number]

export const isRoutedMethod = (method: string): method is RoutedMethod =>
  (ROUTED_METHODS as readonly string[]).includes(method)

/** Reads that a client keeps in its cache, so a server that is offline still shows them. */
export const CACHED_METHODS = [
  "places.list",
  "agents.list",
  "agents.get",
  "channels.list",
  "channels.history",
  "chat.history",
  "tasks.list",
  "tasks.get",
] as const
export const isCachedMethod = (method: string) =>
  (CACHED_METHODS as readonly string[]).includes(method)

/**
 * The first value of the switch "Can create and change agents" in "Allow <name>?" (spec 012, 011).
 * A phone has no screens for it in Phone 1, so it is off for a phone and on for a computer.
 */
export const defaultCanChange = (kind: DeviceKind): boolean => kind !== "phone"

/**
 * Page buttons that a client cannot use on a linked server (spec 012, "What a client can do").
 * The org chart (029) is here until the read of the chart of a linked server comes (S106, part 2):
 * a linked server then shows the line "Open this on <name>", and never the chart of this computer.
 */
export const CLIENT_BLOCKED_PAGES = ["today", "orgchart", "usage"] as const

/** A model that a device with the switch may pick (spec 012). It holds no key. */
export interface ModelChoice {
  readonly accountId: string
  readonly accountName: string
  /** The kind of the account: an API provider or a vendor program (spec 006). */
  readonly kind?: ProviderKind
  /**
   * Whether an agent on this account can be at "Read only" (spec 007). False for a program that has
   * no read-only mode of its own. The server refuses the level for such an agent in any case.
   */
  readonly readOnly?: boolean
  readonly models: readonly ModelInfo[]
}

// ---------------------------------------------------------------------------------------------
// What the window sees
// ---------------------------------------------------------------------------------------------

export interface DeviceSelf {
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
  readonly protocol: number
  /** The name of the computer, used when the user clears the name. */
  readonly computerName: string
}

/** A device that can open this computer. */
export interface ClientEntry {
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
  readonly online: boolean
  readonly since: number
  /** The switch "Can create and change agents". On while the two computers sync. */
  readonly canChange: boolean
  /** True while the user cannot change the switch, because the computers sync (spec 019). */
  readonly canChangeLocked: boolean
}

/** A computer that this computer can open. */
export interface ServerEntry {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly addresses: readonly string[]
  readonly state: LinkState
  /** Which side must update the app, when the state is `update_app`. */
  readonly updateSide: "this" | "server" | null
  readonly since: number
}

export interface DevicesState {
  readonly self: DeviceSelf
  readonly accept: boolean
  /** The port the app listens on, or null while it does not listen. */
  readonly port: number | null
  readonly clients: readonly ClientEntry[]
  readonly servers: readonly ServerEntry[]
}

export type AddressLabel = "local" | "vpn"

export interface PairingAddress {
  readonly address: string
  readonly label: AddressLabel
}

export type PairingEnd = "expired" | "tries" | "used" | "stopped"

export interface PairingState {
  /** True while a code is valid. */
  readonly active: boolean
  readonly code: string
  readonly expiresAt: number
  readonly addresses: readonly PairingAddress[]
  readonly link: string
  /** Why the last code ended, when no code is valid. */
  readonly ended: PairingEnd | null
}

/** A device that asks to join and waits for Allow or Deny. */
export interface JoinRequest {
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
  /** True when this computer can also open the device that asks. */
  readonly twoWay: boolean
}

/** What the connect dialog learns once the code is right. */
export interface ConnectProbe {
  readonly session: string
  readonly name: string
  readonly kind: DeviceKind
}

/** A computer found on the network while it shows a pairing code. */
export interface NearbyComputer {
  readonly name: string
  readonly address: string
}
