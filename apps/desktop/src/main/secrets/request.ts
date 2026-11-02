import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { LookupFunction } from "node:net"
import {
  type AddressClass,
  authHeader,
  authHeaderName,
  classifyIp,
  isUsableHeader,
  redactSecretValue,
  SECRET_BODY_CHARS,
  SECRET_READ_BYTES,
  SECRET_REQUEST_TIMEOUT_MS,
  type SecretAddressError,
  type SecretAuth,
  type SecretMethod,
} from "@robot/shared"

export type SecretBody =
  | { readonly kind: "json"; readonly text: string }
  | { readonly kind: "form"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }

export interface SecretRequest {
  /** The address, checked against the origin of the secret already. */
  readonly url: URL
  readonly method: SecretMethod
  readonly body?: SecretBody
  readonly headers?: Readonly<Record<string, string>>
  readonly auth: SecretAuth
  readonly value: string
  readonly allowLocal: boolean
  readonly signal: AbortSignal
  /** For tests. The defaults are those of spec 020. */
  readonly timeoutMs?: number
  readonly readBytes?: number
  readonly bodyChars?: number
  /** Looks up a host name. Tests give their own. */
  readonly resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>
}

export type SecretResult =
  /** The service answered. The body is redacted and cut. */
  | {
      readonly kind: "answer"
      readonly status: number
      readonly contentType: string
      readonly body: string
      /** True when the body was longer than the agent gets. */
      readonly cut: boolean
    }
  /** The service answered with a redirect. The app did not follow it. */
  | { readonly kind: "redirect"; readonly status: number; readonly location: string }
  /** The app refused the address before it sent anything with the value. */
  | { readonly kind: "refused"; readonly error: SecretAddressError }
  | { readonly kind: "failed"; readonly reason: "timeout" | "network" | "stopped" }

/** The error of the look-up of an address that the rules refuse. */
class AddressRefused extends Error {
  constructor(readonly error: SecretAddressError) {
    super(error)
  }
}

/** The worst class of a list of addresses: one blocked address blocks all. */
const worst = (classes: readonly AddressClass[]): AddressClass =>
  classes.includes("blocked") ? "blocked" : classes.includes("local") ? "local" : "public"

/**
 * A look-up that refuses link-local and metadata addresses, and local ones when the switch is
 * off. The connection uses only the addresses that it checked, so a name cannot change between
 * the check and the connection.
 */
const checkedLookup = (
  allowLocal: boolean,
  resolve: NonNullable<SecretRequest["resolve"]>,
): LookupFunction =>
  ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (list) => {
        if (list.length === 0) return callback(new Error("no address"))
        const kind = worst(list.map((a) => classifyIp(a.address)))
        if (kind === "blocked") return callback(new AddressRefused("blocked"))
        if (kind === "local" && !allowLocal) return callback(new AddressRefused("local_off"))
        if (options?.all) return callback(null, list)
        const first = list[0] as { address: string; family: number }
        callback(null, first.address, first.family)
      },
      (error) => callback(error),
    )
  }) as LookupFunction

const defaultResolve = (host: string) => dnsLookup(host, { all: true, verbatim: true })

const contentTypes: Record<SecretBody["kind"], string> = {
  json: "application/json",
  form: "application/x-www-form-urlencoded",
  text: "text/plain; charset=utf-8",
}

/**
 * Sends one request with a saved secret (spec 020). It follows no redirect, stops after the time
 * limit, reads at most 1 MB, and gives back no header of the answer but the content type. The
 * value is replaced with `[redacted]` in the body and in a redirect address.
 */
export const sendWithSecret = (input: SecretRequest): Promise<SecretResult> => {
  const timeoutMs = input.timeoutMs ?? SECRET_REQUEST_TIMEOUT_MS
  const readBytes = input.readBytes ?? SECRET_READ_BYTES
  const bodyChars = input.bodyChars ?? SECRET_BODY_CHARS
  const redact = (text: string) => redactSecretValue(text, input.value, input.auth)
  const [authName, authValue] = authHeader(input.auth, input.value)
  const headers: Record<string, string> = {
    "user-agent": "ROBot",
    accept: "*/*",
    // The app reads the bytes as they come: no compressed answer.
    "accept-encoding": "identity",
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!isUsableHeader(name) || name.toLowerCase() === authHeaderName(input.auth).toLowerCase())
      continue
    headers[name.toLowerCase()] = value
  }
  const payload = input.body ? Buffer.from(input.body.text, "utf8") : undefined
  if (input.body && payload) {
    headers["content-type"] = contentTypes[input.body.kind]
    headers["content-length"] = String(payload.length)
  }
  headers[authName.toLowerCase()] = authValue

  return new Promise<SecretResult>((done) => {
    let settled = false
    const finish = (result: SecretResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener("abort", onAbort)
      done(result)
    }
    const send = input.url.protocol === "https:" ? httpsRequest : httpRequest
    const req = send(input.url, {
      method: input.method,
      headers,
      lookup: checkedLookup(input.allowLocal, input.resolve ?? defaultResolve),
      // A pooled socket could reach another address than the one that was checked.
      agent: false,
    })
    const timer = setTimeout(() => {
      finish({ kind: "failed", reason: "timeout" })
      req.destroy()
    }, timeoutMs)
    const onAbort = () => {
      finish({ kind: "failed", reason: "stopped" })
      req.destroy()
    }
    if (input.signal.aborted) {
      onAbort()
      return
    }
    input.signal.addEventListener("abort", onAbort, { once: true })
    req.on("error", (error) => {
      if (error instanceof AddressRefused) finish({ kind: "refused", error: error.error })
      else finish({ kind: "failed", reason: "network" })
    })
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        let next = location
        try {
          next = new URL(location, input.url).toString()
        } catch {}
        res.destroy()
        finish({ kind: "redirect", status, location: redact(next) })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let full = false
      const end = () => {
        const text = Buffer.concat(chunks).toString("utf8")
        // The value is hidden before the cut, so that a cut never leaves part of it.
        const clean = redact(text)
        const cut = full || clean.length > bodyChars
        finish({
          kind: "answer",
          status,
          contentType: String(res.headers["content-type"] ?? ""),
          body: clean.length > bodyChars ? clean.slice(0, bodyChars) : clean,
          cut,
        })
      }
      res.on("data", (chunk: Buffer) => {
        if (full) return
        const room = readBytes - size
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room))
          size = readBytes
          full = true
          end()
          res.destroy()
          return
        }
        chunks.push(chunk)
        size += chunk.length
      })
      res.on("end", end)
      res.on("error", () => {
        if (!full) finish({ kind: "failed", reason: "network" })
      })
    })
    req.end(payload)
  })
}
