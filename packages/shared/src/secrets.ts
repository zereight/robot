/**
 * Saved secrets (spec 020): an API key or a password that an agent uses for a web service. The
 * value is in the system keychain. The model never sees it.
 */

/** The name of a secret: 1 to 40 letters, digits, `-` and `_`. Unique for its agent, any case. */
export const SECRET_NAME = /^[A-Za-z0-9_-]{1,40}$/
export const SECRET_LABEL_MAX = 80
export const SECRET_REASON_MAX = 500
/** A value holds at most this many characters. */
export const SECRET_VALUE_MAX = 16_384
/** An agent holds at most this many saved secrets. */
export const SECRETS_PER_AGENT = 100
/** A workflow holds at most this many saved logins (spec 020, "Saved logins"). */
export const LOGINS_PER_WORKFLOW = 50
/** The name of a header or a user name for a basic sign-in. */
export const SECRET_FIELD_MAX = 200

/** A request has this time limit. */
export const SECRET_REQUEST_TIMEOUT_MS = 30_000
/** The app reads at most this much of the answer. */
export const SECRET_READ_BYTES = 1024 * 1024
/** The agent gets at most this many characters of the body. */
export const SECRET_BODY_CHARS = 20_000
/** A body that the agent sends holds at most this many characters. */
export const SECRET_SEND_CHARS = 1_000_000

export const SECRET_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
export type SecretMethod = (typeof SECRET_METHODS)[number]

/** How the app sends the value. For a basic sign-in, the value is the password. */
export type SecretAuth =
  | { readonly kind: "bearer" }
  | { readonly kind: "header"; readonly header: string }
  | { readonly kind: "basic"; readonly user: string }

/** One saved secret as the settings page and the agent see it. It never holds the value. */
export interface SavedSecret {
  readonly id: string
  readonly workflowId: string
  readonly name: string
  readonly origin: string
  readonly auth: SecretAuth
  readonly savedAt: number
  readonly lastUsedAt: number | null
  /** True when the keychain of this computer holds no value for it (spec 020, after an import). */
  readonly valueMissing: boolean
}

/**
 * One saved login as the vault shows it (spec 020, "Saved logins"). It holds no value: the user
 * name and the password are in the system keychain. A login has no way to send: the browser of
 * the workflow fills both values into the sign-in form of the origin.
 */
export interface SavedLogin {
  readonly id: string
  readonly workflowId: string
  readonly name: string
  readonly origin: string
  readonly user: string
  readonly savedAt: number
  readonly lastUsedAt: number | null
  /** True when the keychain of this computer holds no value for it (spec 020, after an import). */
  readonly valueMissing: boolean
}

/** The card with a hidden field (spec 020, "Protected card"). */
export interface SecretAsk {
  readonly kind: "secret"
  readonly name: string
  readonly label: string
  readonly reason: string
  readonly origin: string
  readonly auth: SecretAuth
  /** True when the new value replaces a saved one. */
  readonly replace?: boolean
  readonly askedAt?: number
}

/** The answers of a protected card that reach the tool. The value never goes this way. */
export const SECRET_SAVED = "saved"
export const SECRET_CANCELLED = "cancelled"

/** A token of a header name (RFC 9110). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** Headers that the agent may not set or use for a secret: the app sets them itself. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "expect",
])

export const isSecretName = (name: string) => SECRET_NAME.test(name)

/** The key for "unique for its agent, any case". */
export const secretNameKey = (name: string) => name.toLowerCase()

/** True when the header name is valid and the app does not set it itself. */
export const isUsableHeader = (name: string) =>
  name.length <= SECRET_FIELD_MAX &&
  HEADER_NAME.test(name) &&
  !RESERVED_HEADERS.has(name.toLowerCase())

/** True when a text holds no line break or other control character, so it can go in a header. */
export const isPlainField = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}
const plainField = isPlainField

/** The way to send, from the arguments of the agent, or null when it is not valid. */
export const parseSecretAuth = (
  kind: unknown,
  header: unknown,
  user: unknown,
): SecretAuth | null => {
  if (kind === "bearer") return { kind: "bearer" }
  if (kind === "header") {
    if (typeof header !== "string" || !isUsableHeader(header)) return null
    if (header.toLowerCase() === "authorization") return null
    return { kind: "header", header }
  }
  if (kind === "basic") {
    if (typeof user !== "string" || user.length === 0 || user.length > SECRET_FIELD_MAX) return null
    if (user.includes(":") || !plainField(user)) return null
    return { kind: "basic", user }
  }
  return null
}

/** True when two ways to send are the same. A header name ignores case. */
export const sameAuth = (a: SecretAuth, b: SecretAuth) => {
  if (a.kind === "header" && b.kind === "header")
    return a.header.toLowerCase() === b.header.toLowerCase()
  if (a.kind === "basic" && b.kind === "basic") return a.user === b.user
  return a.kind === b.kind
}

/** The name of the header that carries the value. */
export const authHeaderName = (auth: SecretAuth) =>
  auth.kind === "header" ? auth.header : "Authorization"

/** The header that carries the value. */
export const authHeader = (auth: SecretAuth, value: string): [string, string] => {
  if (auth.kind === "bearer") return ["Authorization", `Bearer ${value}`]
  if (auth.kind === "header") return [auth.header, value]
  return ["Authorization", `Basic ${toBase64(`${auth.user}:${value}`)}`]
}

/** True when a value can go in a header: no line breaks and no control characters. */
export const isSecretValue = (value: string) =>
  value.length > 0 && value.length <= SECRET_VALUE_MAX && plainField(value)

/** True when a user name of a saved login is valid: plain text of 1 to 200 characters. */
export const isLoginUser = (user: string) =>
  user.length > 0 && user.length <= SECRET_FIELD_MAX && plainField(user)

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const ipv4Parts = (host: string): number[] | null => {
  const m = IPV4.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null
}

/** The host without the brackets of an IPv6 address, in lower case. */
const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase()

/** An IPv6 address written as IPv4 in IPv6 (`::ffff:1.2.3.4`), as IPv4; else null. */
const mappedV4 = (host: string): number[] | null => {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (m) return ipv4Parts(m[1] as string)
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!hex) return null
  const hi = Number.parseInt(hex[1] as string, 16)
  const lo = Number.parseInt(hex[2] as string, 16)
  return [hi >> 8, hi & 255, lo >> 8, lo & 255]
}

/**
 * What an address is, for the rules of spec 020:
 * - `blocked`: a link-local address or a cloud metadata address. Always refused.
 * - `local`: this computer or the local network. Allowed only with the switch on.
 * - `public`: anything else.
 */
export type AddressClass = "blocked" | "local" | "public"

/** The class of one IP address (IPv4 or IPv6). A text that is not an IP address is "public". */
export const classifyIp = (address: string): AddressClass => {
  const host = bare(address)
  const v4 = ipv4Parts(host) ?? mappedV4(host)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    // Link-local, which holds the metadata address of most clouds (169.254.169.254).
    if (a === 169 && b === 254) return "blocked"
    // The metadata address of one cloud.
    if (host.endsWith("100.100.100.200")) return "blocked"
    if (a === 0) return "blocked"
    if (a === 127) return "local"
    if (a === 10) return "local"
    if (a === 172 && b >= 16 && b <= 31) return "local"
    if (a === 192 && b === 168) return "local"
    // Shared address space, often a VPN or a carrier network.
    if (a === 100 && b >= 64 && b <= 127) return "local"
    return "public"
  }
  if (!host.includes(":")) return "public"
  if (host === "::1") return "local"
  if (host === "::") return "blocked"
  // The metadata address of one cloud over IPv6.
  if (/^fd00:ec2::254$/.test(host)) return "blocked"
  // Link-local: fe80::/10.
  if (/^fe[89ab][0-9a-f]:/.test(host)) return "blocked"
  // Unique local: fc00::/7.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return "local"
  return "public"
}

/** Host names of cloud metadata services. */
const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "instance-data"])

/**
 * The class of a host as it is written in an address, before a name is looked up. A name of
 * this computer or of the local network counts as local.
 */
export const classifyHost = (hostname: string): AddressClass => {
  const host = bare(hostname).replace(/\.$/, "")
  if (METADATA_NAMES.has(host) || host.endsWith(".metadata.google.internal")) return "blocked"
  if (host === "localhost" || host.endsWith(".localhost")) return "local"
  if (host.endsWith(".local") || host.endsWith(".home.arpa")) return "local"
  return classifyIp(host)
}

/** Why an origin or an address is refused. */
export type SecretAddressError =
  | "invalid"
  | "scheme"
  | "http_public"
  | "parts"
  | "blocked"
  | "local_off"
  | "other_origin"

/**
 * The origin of a secret from the text of the agent: the scheme, the host and the port, as the
 * URL standard writes it. It must use https; http only for a local host. No sign-in part, path,
 * query or fragment.
 */
export const parseOrigin = (
  text: string,
): { ok: true; origin: string; local: boolean } | { ok: false; error: SecretAddressError } => {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return { ok: false, error: "invalid" }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "scheme" }
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: "parts" }
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false, error: "parts" }
  const kind = classifyHost(url.hostname)
  if (kind === "blocked") return { ok: false, error: "blocked" }
  if (url.protocol === "http:" && kind !== "local") return { ok: false, error: "http_public" }
  return { ok: true, origin: url.origin, local: kind === "local" }
}

/**
 * The checks of an address of a request before any name lookup: same origin as the secret, no
 * sign-in part, and the switch for local addresses. The lookup checks the addresses again.
 */
export const checkRequestAddress = (
  address: string,
  origin: string,
  allowLocal: boolean,
): { ok: true; url: URL } | { ok: false; error: SecretAddressError } => {
  let url: URL
  try {
    url = new URL(address.trim())
  } catch {
    return { ok: false, error: "invalid" }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "scheme" }
  if (url.username || url.password) return { ok: false, error: "parts" }
  if (url.origin !== origin) return { ok: false, error: "other_origin" }
  const kind = classifyHost(url.hostname)
  if (kind === "blocked") return { ok: false, error: "blocked" }
  if (kind === "local" && !allowLocal) return { ok: false, error: "local_off" }
  if (url.protocol === "http:" && kind !== "local") return { ok: false, error: "http_public" }
  url.hash = ""
  return { ok: true, url }
}

/** Why Test (spec 020, flow 4) shows a reason instead of a status code. */
export type SecretTestReason =
  | "value_missing"
  | "keychain"
  | SecretAddressError
  | "timeout"
  | "network"

/**
 * The answer of Test: the status code of the GET request to the origin, or the reason. It never
 * holds the value.
 */
export type SecretTestResult =
  | { readonly ok: true; readonly status: number; readonly location?: string }
  | { readonly ok: false; readonly reason: SecretTestReason }

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const urlSafe = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_")

/**
 * The base64 text of the value inside a longer base64 text. The value can start at any of three
 * byte offsets, so each offset gives one text: the characters that depend only on the value.
 */
const base64Cores = (value: string): string[] => {
  const bytes = new TextEncoder().encode(value)
  const out: string[] = []
  for (let shift = 0; shift < 3; shift++) {
    const padded = new Uint8Array(shift + bytes.length)
    padded.set(bytes, shift)
    const full = bytesToBase64(padded).replace(/=+$/, "")
    // Characters that hold bits of the pad bytes, at the start.
    const head = shift === 0 ? 0 : shift === 1 ? 2 : 3
    // The last character can hold bits of the next byte, unless the value ends a group.
    const total = shift + bytes.length
    const tail = total % 3 === 0 ? 0 : 1
    const core = full.slice(head, full.length - tail)
    if (core.length >= 4) out.push(core)
  }
  return out
}

const hexOf = (value: string) =>
  [...new TextEncoder().encode(value)].map((b) => b.toString(16).padStart(2, "0")).join("")

/** The texts that stand for the value in an answer: as it is, and in its common encodings. */
export const secretForms = (value: string, auth?: SecretAuth): string[] => {
  if (!value) return []
  const forms = new Set<string>([value])
  const add = (text: string) => {
    if (text) forms.add(text)
  }
  const full = toBase64(value)
  add(full)
  add(full.replace(/=+$/, ""))
  add(urlSafe(full))
  add(urlSafe(full).replace(/=+$/, ""))
  for (const core of base64Cores(value)) {
    add(core)
    add(urlSafe(core))
  }
  add(encodeURIComponent(value))
  add(encodeURIComponent(value).replace(/%20/g, "+"))
  add(encodeURI(value))
  const hex = hexOf(value)
  add(hex)
  add(hex.toUpperCase())
  // A basic sign-in sends "user:password" in base64. A service that sends it back sends that.
  if (auth?.kind === "basic") {
    const pair = toBase64(`${auth.user}:${value}`)
    add(pair)
    add(pair.replace(/=+$/, ""))
  }
  // The longest first, so a longer form is not cut by a shorter one inside it.
  return [...forms].sort((a, b) => b.length - a.length)
}

export const SECRET_REDACTED = "[redacted]"

/**
 * Replaces the value, and its base64, URL and hex forms, with `[redacted]` (spec 020). Hex and
 * the percent signs of URL encoding match in any case.
 */
export const redactSecretValue = (text: string, value: string, auth?: SecretAuth): string => {
  let out = text
  for (const form of secretForms(value, auth)) {
    const caseless = /^[0-9a-fA-F]+$/.test(form) || form.includes("%")
    if (caseless) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      out = out.replace(new RegExp(escaped, "gi"), SECRET_REDACTED)
    } else out = out.split(form).join(SECRET_REDACTED)
  }
  return out
}
