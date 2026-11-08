import { lookup as dnsLookup } from "node:dns/promises"
import {
  authHeader,
  checkRequestAddress,
  classifyIp,
  SECRET_REQUEST_TIMEOUT_MS,
  type SecretAuth,
  type SecretTestResult,
} from "@robot/shared"

/** One address that a name leads to. */
export interface SecretResolved {
  readonly address: string
}

/** Looks up a name. A test gives its own. */
export type SecretLookup = (host: string) => Promise<readonly SecretResolved[]>

/** The look-up of the system. It gives every address of the name. */
export const systemSecretLookup: SecretLookup = (host) =>
  dnsLookup(host, { all: true, verbatim: true })

export interface SecretTestOptions {
  /** The switch "Allow saved secrets on this computer and the local network" (spec 020). */
  readonly allowLocal: boolean
  /** The time limit in milliseconds. The spec says 30 seconds; a test sets less. */
  readonly timeoutMs?: number
  readonly lookup?: SecretLookup
}

/**
 * Test (spec 020, flow 4, "Test"): sends a GET request to the origin with the secret and reads the
 * status code, or the reason. It follows the address rules of a request with a secret: https, the
 * switch for this computer and the local network, no redirect, the refusal of link-local and
 * cloud metadata addresses, and the time limit. It never shows the value, and it never changes
 * the date last used.
 */
export const testSecretRequest = async (
  address: string,
  origin: string,
  auth: SecretAuth,
  value: string,
  options: SecretTestOptions,
): Promise<SecretTestResult> => {
  const checked = checkRequestAddress(address, origin, options.allowLocal)
  if (!checked.ok) return { ok: false, reason: checked.error }
  const url = checked.url
  let resolved: readonly SecretResolved[]
  try {
    resolved = await (options.lookup ?? systemSecretLookup)(url.hostname)
  } catch {
    return { ok: false, reason: "network" }
  }
  if (resolved.some((r) => classifyIp(r.address) === "blocked"))
    return { ok: false, reason: "blocked" }
  const timeoutMs = options.timeoutMs ?? SECRET_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let res: Response | undefined
  try {
    const [name, headerValue] = authHeader(auth, value)
    res = await fetch(url, {
      method: "GET",
      headers: { [name]: headerValue },
      // A redirect ends the request with its status and the new address (spec 020, "Rules").
      redirect: "manual",
      signal: controller.signal,
    })
    const location = res.headers.get("location")
    return location ? { ok: true, status: res.status, location } : { ok: true, status: res.status }
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "network" }
  } finally {
    clearTimeout(timer)
    // The status is all Test shows. The body is dropped at once; it never reaches a log.
    await res?.body?.cancel().catch(() => {})
  }
}
