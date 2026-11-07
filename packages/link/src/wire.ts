/**
 * The wire protocol of the device link (spec 012): constants, addresses, the link text, the
 * requests that a client may make, the pushed events and the messages inside the encrypted
 * channel. Nothing here assumes that the client is a computer: the phone speaks the same protocol.
 */

/** The version of the wire protocol. Both sides must use the same number. */
export const LINK_PROTOCOL = 1

export const DEVICE_KINDS = ["computer", "phone"] as const
export type DeviceKind = (typeof DEVICE_KINDS)[number]

export const DEVICE_NAME_MAX = 40
export const DEFAULT_LINK_PORT = 47800

export const PAIR_CODE_LENGTH = 6
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000
export const PAIR_CODE_TRIES = 5
/** Devices that can open one computer, and servers that one device can open. */
export const MAX_CLIENTS = 10
export const MAX_SERVERS = 10
/** The longest wait between two tries to reach a server. */
export const RECONNECT_MAX_MS = 30_000

/** `true` for a string of exactly six digits. */
export const isPairCode = (text: string) => /^\d{6}$/.test(text)

export interface Address {
  readonly host: string
  readonly port: number
}

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/
const IPV6 = /^[0-9A-Fa-f:]+$/

/**
 * Reads `host`, `host:port`, `[v6]` or `[v6]:port`. A bare IPv6 address (several colons) counts
 * as a host with no port. Returns null when the text is not an address.
 */
export const parseAddress = (text: string, defaultPort = DEFAULT_LINK_PORT): Address | null => {
  const value = text.trim()
  if (!value) return null
  const bracket = /^\[([0-9A-Fa-f:]+)\](?::(\d{1,5}))?$/.exec(value)
  if (bracket) return withPort(bracket[1] ?? "", bracket[2], defaultPort)
  if ((value.match(/:/g)?.length ?? 0) > 1) {
    return IPV6.test(value) ? withPort(value, undefined, defaultPort) : null
  }
  const [host = "", port] = value.split(":")
  if (port === "") return null
  return HOST.test(host) ? withPort(host, port, defaultPort) : null
}

const withPort = (host: string, port: string | undefined, defaultPort: number): Address | null => {
  const number = port === undefined ? defaultPort : Number(port)
  return Number.isInteger(number) && number > 0 && number < 65536 ? { host, port: number } : null
}

export const formatAddress = (address: Address) =>
  `${address.host.includes(":") ? `[${address.host}]` : address.host}:${address.port}`

/** What the link text holds: the code, the name of the computer, and every address. */
export interface LinkInvite {
  readonly code: string
  readonly name: string
  readonly addresses: readonly string[]
}

export const formatLink = (invite: LinkInvite) => {
  const query = new URLSearchParams()
  query.set("code", invite.code)
  if (invite.name) query.set("name", invite.name)
  for (const address of invite.addresses) query.append("a", address)
  return `robot://pair?${query.toString()}`
}

/** Reads a link text. Returns null when it is not one. */
export const parseLink = (text: string): LinkInvite | null => {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return null
  }
  if (url.protocol !== "robot:" || url.hostname !== "pair") return null
  const code = url.searchParams.get("code") ?? ""
  const addresses = url.searchParams
    .getAll("a")
    .filter((a) => parseAddress(a) !== null)
    .slice(0, 16)
  if (!isPairCode(code) || addresses.length === 0) return null
  return { code, name: (url.searchParams.get("name") ?? "").slice(0, DEVICE_NAME_MAX), addresses }
}

/** How a pairing code shows on screen: `123 456`. */
export const groupCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`

// ---------------------------------------------------------------------------------------------
// What a client may ask of a server.
// ---------------------------------------------------------------------------------------------

/**
 * The requests that a server answers for a linked device. Everything else gets "not allowed"
 * (spec 012, "What a client can do on a server"). A method is on this list only when the server
 * has a handler for it: the server runs the handler of the same name. The list holds what spec
 * 012 states for workflows: read the list, run, stop, see the runs, answer a card, and chat.
 * The old requests of agents, channels, tasks, memory, handbook, organizations, sync and the
 * link-only reads are gone: no handler exists for them (docs/proposal-workflow-first.md, W6).
 */
export const CLIENT_METHODS = [
  // The chat of a workflow (spec 003, 012). Sending and stopping need only the right to send
  // messages.
  "chat.history",
  "chat.send",
  "chat.stop",
  "chat.retry",
  // Workflows of the server (spec 012, "Workflows"). Reading, running and stopping need only the
  // right to send messages. A card of a run is answered with "cards.answer".
  "workflows.list",
  "runs.list",
  "runs.get",
  "runs.start",
  "runs.stop",
  "cards.answer",
  // The list of models is a constant read. It changes nothing and needs only the link (spec 012).
  "models.available",
  // Only with the switch "Can create and change workflows" (spec 010, 012). Each one checks it
  // again (see `CHANGE_METHODS`).
  "workflows.create",
  "workflows.delete",
] as const
export type ClientMethod = (typeof CLIENT_METHODS)[number]

/**
 * The requests that a server answers only when the switch "Can create and change workflows" is on
 * for the device that asks (spec 010, 012). The server reads the switch at each request. Anything
 * that is not here and not in `CLIENT_METHODS` is refused.
 */
export const CHANGE_METHODS = ["workflows.create", "workflows.delete"] as const
export type ChangeMethod = (typeof CHANGE_METHODS)[number]
export const isChangeMethod = (method: string): method is ChangeMethod =>
  (CHANGE_METHODS as readonly string[]).includes(method)

export const isClientMethod = (method: string): method is ClientMethod =>
  (CLIENT_METHODS as readonly string[]).includes(method)

/**
 * The events that a server pushes to every linked device. Each one has an emitter in the server
 * (a test checks it): an event with no emitter is not listed. A client reads a part again when its
 * event comes, and a part that has no event is read when the client opens it. The event "revoked"
 * is not here: the server sends it to the device that it concerns, not to every device.
 */
export const PUSHED_EVENTS = [
  // A message of a chat was made or changed (spec 003).
  "chat.message",
  // The workflows of the server changed (spec 010, 012): a client reads the list again.
  "workflows.changed",
  // A run, a task or a card changed, and the state of a chat changed (spec 010, 003): a client
  // reads the run or the history again.
  "runs.changed",
  "chat.state",
] as const
export type PushedEvent = (typeof PUSHED_EVENTS)[number]

/** Newest messages of one place that a client asks for, and keeps in its cache. */
export const MESSAGE_PAGE = 200

/** Largest piece of a file in one request, before the base64 text. */
export const FILE_CHUNK = 192 * 1024

/**
 * A client cannot name a path on the server. It uploads a file in pieces and gets a token; the
 * token goes in the `files` of "send message", and the server maps it to the stored file.
 */
export const UPLOAD_PREFIX = "upload:"

export interface UploadChunk {
  readonly uploadId: string
  readonly name: string
  /** Bytes already sent. A piece must start where the last one ended. */
  readonly offset: number
  /** The piece as base64 text. */
  readonly data: string
  /** True for the last piece. */
  readonly done: boolean
}

export interface UploadAck {
  readonly size: number
  /** Set after the last piece. */
  readonly token: string | null
}

export interface DownloadRequest {
  readonly agentId: string
  /** The `path` of a file part of a message, for example `attachments/report.pdf`. */
  readonly path: string
  readonly offset: number
}

export interface DownloadChunk {
  readonly size: number
  readonly offset: number
  readonly data: string
  readonly done: boolean
}

// ---------------------------------------------------------------------------------------------
// Wire messages (inside the encrypted channel)
// ---------------------------------------------------------------------------------------------

export interface WireDevice {
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
}

/** A message of the application protocol. `v` is the protocol version, `id` pairs a reply. */
export type WireMessage =
  | {
      readonly v: number
      readonly type: "request"
      readonly id: number
      readonly method: string
      readonly input?: unknown
    }
  | {
      readonly v: number
      readonly type: "response"
      readonly id: number
      readonly ok: true
      readonly value?: unknown
    }
  | {
      readonly v: number
      readonly type: "response"
      readonly id: number
      readonly ok: false
      readonly error: { readonly code: string; readonly message: string }
    }
  | {
      readonly v: number
      readonly type: "event"
      readonly id: number
      readonly event: string
      readonly payload?: unknown
    }

/** A system notice that a server pushes, so a client can show it by its own settings. */
export interface WireNotice {
  readonly kind:
    | "reply"
    | "mention"
    | "approval"
    | "question"
    | "task_failed"
    | "routine_failed"
    | "workflow_notice"
  readonly title: string
  readonly body: string
  /** The place to open on a click. A notice of a workflow has a page instead (spec 010, 015). */
  readonly target?: {
    readonly kind: "agent"
    readonly id: string
    readonly messageId?: string
  }
  readonly page?: "workflows"
  /** For an approval or a question: the call that waits, so one answer ends the notice everywhere. */
  readonly callId?: string
  readonly agentId?: string
}

export interface ServerSummary {
  readonly serverId: string
  readonly deviceId: string
  readonly name: string
  readonly app: string
  readonly protocol: number
  /** True when the server lets the device that asks create and change agents (spec 012). */
  readonly canChange: boolean
}

/**
 * Sent to one device when its switch "Can create and change agents" changes, so that its screens
 * turn editable or read-only at once. It is not in `PUSHED_EVENTS`: it goes to that device only.
 */
export const ACCESS_EVENT = "access"
export interface AccessPayload {
  readonly canChange: boolean
}

/** The state of a linked server on a client (spec 012, States). */
export type LinkState =
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline"
  | "not_allowed"
  | "update_app"

/** A name that is not shared with another device in the list gets no number. */
export const numberedNames = <T extends { readonly id: string; readonly name: string }>(
  devices: readonly T[],
): Map<string, string> => {
  const totals = new Map<string, number>()
  for (const d of devices) totals.set(d.name, (totals.get(d.name) ?? 0) + 1)
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const d of devices) {
    if ((totals.get(d.name) ?? 0) < 2) {
      out.set(d.id, d.name)
      continue
    }
    const n = (seen.get(d.name) ?? 0) + 1
    seen.set(d.name, n)
    out.set(d.id, `${d.name} ${n}`)
  }
  return out
}
