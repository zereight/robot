import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import type { LookupFunction } from "node:net"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import { classifyHostWriting, kindOfAddress, ruleHost, worstKind } from "@robot/shared"

/** One address that a name leads to. */
export interface Resolved {
  readonly address: string
  readonly family: number
}

/** Looks up a name. A test gives its own. */
export type Resolver = (host: string) => Promise<readonly Resolved[]>

/** The look-up of the system. It gives every address of the name. */
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true })

/** A connection that would reach a local address. The user decides before it goes on. */
export interface LocalAsk {
  /** The host as a rule for a web page names it. */
  readonly host: string
  /** The address of this step, with the path. */
  readonly url: string
  /**
   * True when the host is a name that leads to a local address. A rule for such a name does not
   * count, so the question always asks (spec 007). False when the host is written as numbers,
   * `localhost` or a name that ends in `.local`: a rule for that host can allow it.
   */
  readonly byName: boolean
}

export interface CheckedFetch {
  readonly url: string
  readonly signal: AbortSignal
  /** Asked before a connection reaches a local address. Resolves true to go on. */
  readonly allowLocal: (ask: LocalAsk) => Promise<boolean>
  readonly resolve?: Resolver
  /** The time limit of one step, without the time that the user takes to answer. */
  readonly timeoutMs?: number
  /** At most this many bytes of a page are read. */
  readonly readBytes?: number
  readonly maxRedirects?: number
}

export type CheckedResult =
  | {
      readonly kind: "page"
      readonly status: number
      readonly ok: boolean
      readonly contentType: string
      readonly body: string
      /** The address of the last step, after the redirects. */
      readonly url: string
    }
  /** An address that is never allowed: a link-local or a cloud metadata address. */
  | { readonly kind: "refused"; readonly host: string }
  /** The user denied a local address. */
  | { readonly kind: "denied"; readonly host: string }
  | {
      readonly kind: "failed"
      readonly reason: "invalid" | "scheme" | "redirects" | "timeout" | "network" | "stopped"
    }

/** The look-up found an address that is never allowed. */
class AddressRefused extends Error {}
/** The user denied a local address. */
class LocalDenied extends Error {}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_REDIRECTS = 10

/**
 * A look-up that checks the addresses that the connection really uses. The connection gets only
 * the list that was checked, so a name cannot lead somewhere else between the check and the
 * connection. One address that is never allowed refuses the whole list. A list with a local
 * address asks the user first, unless the host was allowed already as written.
 */
const checkedLookup = (
  resolve: Resolver,
  host: string,
  approved: boolean,
  ask: (byName: boolean) => Promise<boolean>,
): LookupFunction =>
  ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    const decide = async () => {
      const list = await resolve(hostname)
      if (list.length === 0) throw new Error("no address")
      const kind = worstKind(list.map((a) => kindOfAddress(a.address)))
      if (kind === "never") throw new AddressRefused(host)
      if (kind === "local" && !approved && !(await ask(true))) throw new LocalDenied(host)
      return list
    }
    decide().then(
      (list) => {
        if (options?.all) return callback(null, list)
        const first = list[0] as Resolved
        callback(null, first.address, first.family)
      },
      (error) => callback(error),
    )
  }) as LookupFunction

type Hop =
  | { readonly kind: "response"; readonly res: IncomingMessage }
  | { readonly kind: "refused" | "denied" }
  | { readonly kind: "failed"; readonly reason: "timeout" | "network" | "stopped" }

/** One request, with no redirect followed. The address is checked at the connection. */
const once = (url: URL, input: CheckedFetch, approved: boolean): Promise<Hop> =>
  new Promise<Hop>((done) => {
    const host = ruleHost(url.hostname)
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (hop: Hop) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal.removeEventListener("abort", onAbort)
      done(hop)
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        finish({ kind: "failed", reason: "timeout" })
        req.destroy()
      }, timeoutMs)
    }
    const onAbort = () => {
      finish({ kind: "failed", reason: "stopped" })
      req.destroy()
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest
    const req = send(url, {
      method: "GET",
      headers: {
        "user-agent": "ROBot",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      },
      lookup: checkedLookup(input.resolve ?? systemResolver, host, approved, async (byName) => {
        // The time that the user takes to answer is not a time limit of the fetch.
        clearTimeout(timer)
        const yes = await input.allowLocal({ host, url: url.toString(), byName })
        if (!settled) arm()
        return yes
      }),
      // A pooled socket could reach another address than the one that was checked.
      agent: false,
    })
    if (input.signal.aborted) return onAbort()
    input.signal.addEventListener("abort", onAbort, { once: true })
    arm()
    req.on("error", (error) => {
      if (error instanceof AddressRefused) finish({ kind: "refused" })
      else if (error instanceof LocalDenied) finish({ kind: "denied" })
      else if (input.signal.aborted) finish({ kind: "failed", reason: "stopped" })
      else finish({ kind: "failed", reason: "network" })
    })
    req.on("response", (res) => finish({ kind: "response", res }))
    req.end()
  })

/** Reads the body of an answer, decoded and cut at `max` bytes, within the time limit. */
const readBody = (
  res: IncomingMessage,
  max: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: "timeout" | "network" | "stopped" }> =>
  new Promise((done) => {
    const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase()
    const stream =
      encoding === "gzip" || encoding === "x-gzip"
        ? res.pipe(createGunzip())
        : encoding === "deflate"
          ? res.pipe(createInflate())
          : encoding === "br"
            ? res.pipe(createBrotliDecompress())
            : res
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    let settled = false
    const end = (result: Parameters<typeof done>[0]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      done(result)
    }
    const text = () => ({ ok: true as const, text: Buffer.concat(chunks).toString("utf8") })
    const onAbort = () => {
      res.destroy()
      end({ ok: false, reason: "stopped" })
    }
    const timer = setTimeout(() => {
      res.destroy()
      end({ ok: false, reason: "timeout" })
    }, timeoutMs)
    signal.addEventListener("abort", onAbort, { once: true })
    stream.on("data", (chunk: Buffer) => {
      if (over) return
      const room = max - size
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room))
        size = max
        over = true
        res.destroy()
        end(text())
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    stream.on("end", () => end(text()))
    stream.on("error", () => end(over ? text() : { ok: false, reason: "network" }))
    res.on("error", () => end(over ? text() : { ok: false, reason: "network" }))
  })

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * Fetches a web page with GET (spec 007, "Addresses of a web page fetch"). The app checks the
 * address that the connection really uses: before the first connection, after the look-up of a
 * name, and after each redirect.
 *
 * - An address that is never allowed (link-local, cloud metadata) is refused, with no question.
 * - An address written as numbers, `localhost` or a name that ends in `.local`, and that is local,
 *   asks the user through `allowLocal` before the connection.
 * - A name that leads to a local address asks too, with `byName` set.
 */
export const checkedFetch = async (input: CheckedFetch): Promise<CheckedResult> => {
  let address = input.url
  const limit = input.maxRedirects ?? DEFAULT_REDIRECTS
  for (let hop = 0; hop <= limit; hop++) {
    let url: URL
    try {
      url = new URL(address)
    } catch {
      return { kind: "failed", reason: "invalid" }
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { kind: "failed", reason: "scheme" }
    if (url.username || url.password) return { kind: "failed", reason: "invalid" }
    const host = ruleHost(url.hostname)
    const writing = classifyHostWriting(url.hostname)
    if (writing.kind === "never") return { kind: "refused", host }
    if (writing.kind === "local") {
      if (!(await input.allowLocal({ host, url: url.toString(), byName: false })))
        return { kind: "denied", host }
    }
    const step = await once(url, input, writing.kind === "local")
    if (step.kind !== "response") return step.kind === "failed" ? step : { kind: step.kind, host }
    const res = step.res
    const status = res.statusCode ?? 0
    const location = res.headers.location
    if (REDIRECTS.has(status) && typeof location === "string" && location) {
      res.destroy()
      try {
        address = new URL(location, url).toString()
      } catch {
        return { kind: "failed", reason: "invalid" }
      }
      continue
    }
    const body = await readBody(
      res,
      input.readBytes ?? DEFAULT_READ_BYTES,
      input.signal,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (!body.ok) return { kind: "failed", reason: body.reason }
    return {
      kind: "page",
      status,
      ok: status >= 200 && status < 300,
      contentType: String(res.headers["content-type"] ?? ""),
      body: body.text,
      url: url.toString(),
    }
  }
  return { kind: "failed", reason: "redirects" }
}
