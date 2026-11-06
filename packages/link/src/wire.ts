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
 * (spec 012, "What a client can do on a server"). `server.summary`, `chat.page`,
 * `attachment.upload`, `attachment.download` and `attention.list` exist only on the link.
 */
export const CLIENT_METHODS = [
  "server.summary",
  "places.list",
  "agents.list",
  "agents.get",
  "channels.list",
  "channels.history",
  "channels.send",
  "channels.assign",
  "channels.stop",
  "channels.activity",
  "channels.markRead",
  "chat.history",
  "messages.search",
  "chat.send",
  "chat.stop",
  "chat.retry",
  "chat.edit",
  "chat.queue.update",
  "chat.queue.remove",
  "chat.queue.sendNow",
  "chat.unread.delete",
  "chat.markRead",
  "tools.respond",
  // The skills that an agent may use now, for the command list of the message box (spec 003, 017).
  // A client gets the name and the description, never the instructions.
  "skills.forAgent",
  // The organizations of the server, the part "Tools" of an organization, and the lines "From
  // <organization>" of a profile (spec 030, 012). A client reads them and changes none of them with
  // these; to make, edit or delete an organization it needs the switch (see `CHANGE_METHODS`).
  "organizations.list",
  // The daily token limit of an organization with the tokens used today (spec 030, 012).
  "organizations.limit",
  "orgTools.list",
  "orgTools.forAgent",
  "tasks.list",
  "tasks.get",
  "tasks.recent",
  "tasks.stop",
  // The follow-ups in the details of a task (spec 005, 012). They stay on this computer.
  "followups.list",
  "followups.remove",
  "attachment.upload",
  "attachment.download",
  "attention.list",
  // The turns that are quiet now (spec 005, "Quiet line", 012): read when a client connects.
  "quiet.list",
  // Workflows of the server (spec 012, "Workflows"). Reading, running and stopping need only the
  // right to send messages.
  "workflows.list",
  "workflows.runs",
  "workflows.runDetail",
  "workflows.run",
  "workflows.stop",
  "workflows.approve",
  // The org chart of the server (spec 029, 012), as a ready model. It needs only the link: it is
  // read only, and a phone asks for it the same way (spec 011).
  "orgChart.model",
  // The hand-off rule of the server (spec 030, 012). A client reads the part "Organization" and
  // never changes it: there is no change request for it, with or without the switch.
  "organization.get",
  // The handbook of the server (spec 002, 012). A client reads it and its history with no switch.
  "handbook.get",
  "handbook.history",
  // Only with the switch "Can create and change agents" (spec 012). Each one checks it again.
  "agents.create",
  "agents.update",
  "agents.duplicate",
  "agents.archive",
  // "Use the main model now": ends the hold of the main model (spec 006, 012).
  "agents.useMain",
  "channels.create",
  "channels.update",
  // The picture of a channel (spec 004, 012): a client sends a square PNG of at most 256 px.
  "channels.setPicture",
  // Make, edit and delete an organization (spec 012, 030).
  "organizations.create",
  "organizations.update",
  "organizations.delete",
  "memory.list",
  // The channels for the filter and for a move of a channel note (spec 008, 012).
  "memory.scopes",
  "memory.move",
  "memory.add",
  "memory.update",
  "memory.delete",
  // The memory check of an agent (spec 008, 012): a client sees the choice with the link only, and
  // changes it only with the switch.
  "memory.check",
  "memory.check.set",
  // Change the handbook (spec 002, 012): save a text, or restore a version.
  "handbook.save",
  "handbook.restore",
  // The list of models is a constant read. It changes nothing and needs only the link (spec 012).
  "models.available",
  "workflows.create",
  "workflows.update",
  "workflows.delete",
  // Sync between two computers (spec 019). Only the computer that is the sync peer may use them.
  "sync.hello",
  "sync.counts",
  "sync.ids",
  "sync.names",
  "sync.offer",
  "sync.cancel",
  "sync.push",
  "sync.control",
  "sync.stop",
] as const
export type ClientMethod = (typeof CLIENT_METHODS)[number]

/**
 * The requests that a server answers only when the switch "Can create and change workflows" is on
 * for the device that asks (spec 010, 012). The server reads the switch at each request. Anything
 * that is not here and not in `CLIENT_METHODS` is refused.
 */
export const CHANGE_METHODS = ["workflows.create", "workflows.update", "workflows.delete"] as const
export type ChangeMethod = (typeof CHANGE_METHODS)[number]
export const isChangeMethod = (method: string): method is ChangeMethod =>
  (CHANGE_METHODS as readonly string[]).includes(method)

export const isClientMethod = (method: string): method is ClientMethod =>
  (CLIENT_METHODS as readonly string[]).includes(method)

/** The events that a server pushes to every linked device. */
export const PUSHED_EVENTS = [
  "chat.message",
  "chat.removed",
  "chat.queue",
  "channel.message",
  "channel.removed",
  "channels.changed",
  "places.changed",
  "agents.changed",
  "tasks.changed",
  // A follow-up was made, deleted, or started its task (spec 005, 012).
  "followups.changed",
  "notice",
  "revoked",
  "memory.changed",
  // The handbook of the server changed (spec 002, 012): a client that shows it reads it again.
  "handbook.changed",
  "workflows.changed",
  "workflows.run",
  // The part "Organization" changed (spec 030, 012): a client that shows it reads it again.
  "organization.changed",
  // An organization was made, changed or deleted (spec 030, 012): a client reads the list again.
  "organizations.changed",
  // The org chart changed (spec 029, 012): the whole ready model, so a client reads nothing again.
  "orgChart.model",
  // A turn became quiet, went on, or ended (spec 005, "Quiet line", 012). The start and the end
  // only: a client counts the seconds itself.
  "quiet.changed",
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
