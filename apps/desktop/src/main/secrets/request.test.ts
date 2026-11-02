import { afterAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { checkRequestAddress, type SecretAuth } from "@robot/shared"
import { type SecretRequest, sendWithSecret } from "./request.ts"

const VALUE = "tok-AbC123xyz789-secret"
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

/** What the test service got last. */
let last: { headers: IncomingMessage["headers"]; method: string; body: string } | undefined

/** A small test web service, written for these tests (spec 020, "Acceptance"). */
const service = createServer((req, res) => {
  let body = ""
  req.on("data", (c) => {
    body += c
  })
  req.on("end", () => {
    last = { headers: req.headers, method: req.method ?? "", body }
    const url = new URL(req.url ?? "/", "http://x")
    const auth = String(req.headers.authorization ?? "")
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth
    switch (url.pathname) {
      case "/echo":
        res.writeHead(200, { "content-type": "text/plain", "x-private": "header-text" })
        res.end(`plain ${token} base64 ${b64(token)} hex ${Buffer.from(token).toString("hex")}`)
        return
      case "/basic":
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(`you sent ${auth}`)
        return
      case "/redirect":
        res.writeHead(302, { location: `/next?key=${encodeURIComponent(token)}` })
        res.end("moved")
        return
      case "/next":
        res.writeHead(200)
        res.end("followed")
        return
      case "/slow":
        setTimeout(() => {
          res.writeHead(200)
          res.end("late")
        }, 2000)
        return
      case "/big":
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("a".repeat(3 * 1024 * 1024))
        return
      case "/long":
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("b".repeat(30_000))
        return
      default:
        res.writeHead(404, { "content-type": "application/json" })
        res.end('{"error":"none"}')
    }
  })
})
await new Promise<void>((done) => service.listen(0, "127.0.0.1", done))
const port = (service.address() as AddressInfo).port
const origin = `http://127.0.0.1:${port}`
afterAll(() => service.close())

const bearer: SecretAuth = { kind: "bearer" }
const send = (path: string, extra: Partial<SecretRequest> = {}) =>
  sendWithSecret({
    url: new URL(`${origin}${path}`),
    method: "GET",
    auth: bearer,
    value: VALUE,
    allowLocal: true,
    signal: new AbortController().signal,
    ...extra,
  })

describe("a request with a saved secret", () => {
  test("the service gets the header with the value, and the agent gets the body", async () => {
    const result = await send("/missing")
    expect(last?.headers.authorization).toBe(`Bearer ${VALUE}`)
    expect(result).toEqual({
      kind: "answer",
      status: 404,
      contentType: "application/json",
      body: '{"error":"none"}',
      cut: false,
    })
  })

  test("the value in the answer is redacted, also as base64 and hex; no header comes back", async () => {
    const result = await send("/echo")
    expect(result.kind).toBe("answer")
    if (result.kind !== "answer") return
    expect(result.body).toBe("plain [redacted] base64 [redacted] hex [redacted]")
    expect(JSON.stringify(result)).not.toContain(VALUE)
    expect(JSON.stringify(result)).not.toContain("header-text")
  })

  test("a basic sign-in sends user:password, and the echo of it is redacted", async () => {
    const auth: SecretAuth = { kind: "basic", user: "ada" }
    const result = await send("/basic", { auth })
    expect(last?.headers.authorization).toBe(`Basic ${b64(`ada:${VALUE}`)}`)
    expect(result.kind === "answer" && result.body).toBe("you sent Basic [redacted]")
  })

  test("a named header carries the value", async () => {
    await send("/missing", { auth: { kind: "header", header: "X-Api-Key" } })
    expect(last?.headers["x-api-key"]).toBe(VALUE)
    expect(last?.headers.authorization).toBeUndefined()
  })

  test("a POST sends its body and extra headers, and the agent cannot replace the value", async () => {
    await send("/missing", {
      method: "POST",
      body: { kind: "json", text: '{"a":1}' },
      headers: { "X-Trace": "1", Authorization: "Bearer stolen", Host: "evil" },
    })
    expect(last?.method).toBe("POST")
    expect(last?.body).toBe('{"a":1}')
    expect(last?.headers["content-type"]).toBe("application/json")
    expect(last?.headers["x-trace"]).toBe("1")
    expect(last?.headers.authorization).toBe(`Bearer ${VALUE}`)
    expect(last?.headers.host).toBe(`127.0.0.1:${port}`)
  })

  test("a redirect is not followed: the agent gets the status and the new address", async () => {
    const result = await send("/redirect")
    expect(result).toEqual({
      kind: "redirect",
      status: 302,
      location: `${origin}/next?key=[redacted]`,
    })
    expect(last?.headers.authorization).toBe(`Bearer ${VALUE}`)
  })

  test("the request stops at the time limit", async () => {
    const started = Date.now()
    const result = await send("/slow", { timeoutMs: 300 })
    expect(result).toEqual({ kind: "failed", reason: "timeout" })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  test("the app reads at most 1 MB, and the agent gets at most 20000 characters", async () => {
    const big = await send("/big")
    expect(big.kind === "answer" && big.body.length).toBe(20_000)
    expect(big.kind === "answer" && big.cut).toBe(true)
    const long = await send("/long")
    expect(long.kind === "answer" && long.body.length).toBe(20_000)
    expect(long.kind === "answer" && long.cut).toBe(true)
    const small = await send("/long", { bodyChars: 40_000 })
    expect(small.kind === "answer" && small.cut).toBe(false)
    const capped = await send("/big", { readBytes: 1000, bodyChars: 5000 })
    expect(capped.kind === "answer" && capped.body.length).toBe(1000)
    expect(capped.kind === "answer" && capped.cut).toBe(true)
  })

  test("Stop ends the request", async () => {
    const controller = new AbortController()
    const pending = send("/slow", { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toEqual({ kind: "failed", reason: "stopped" })
  })
})

describe("the look-up of a host name", () => {
  // A name that leads to an address of the test service, through the look-up of the test.
  const named = (address: string, allowLocal: boolean) =>
    sendWithSecret({
      url: new URL(`http://service.test:${port}/missing`),
      method: "GET",
      auth: bearer,
      value: VALUE,
      allowLocal,
      signal: new AbortController().signal,
      resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    })

  test("a name that leads to a link-local or metadata address is refused", async () => {
    last = undefined
    expect(await named("169.254.169.254", true)).toEqual({ kind: "refused", error: "blocked" })
    expect(await named("fe80::1", true)).toEqual({ kind: "refused", error: "blocked" })
    expect(last).toBeUndefined()
  })

  test("a name that leads to this computer needs the switch", async () => {
    last = undefined
    expect(await named("127.0.0.1", false)).toEqual({ kind: "refused", error: "local_off" })
    expect(last).toBeUndefined()
    const allowed = await named("127.0.0.1", true)
    expect(allowed.kind).toBe("answer")
    const seen = last as { headers: IncomingMessage["headers"] } | undefined
    expect(seen?.headers.authorization).toBe(`Bearer ${VALUE}`)
  })
})

describe("the address check before a request", () => {
  test("another port of the same host is refused", () => {
    expect(checkRequestAddress(`http://127.0.0.1:${port + 1}/x`, origin, true)).toEqual({
      ok: false,
      error: "other_origin",
    })
  })

  test("with the switch off, 127.0.0.1 is refused with the reason", () => {
    expect(checkRequestAddress(`${origin}/x`, origin, false)).toEqual({
      ok: false,
      error: "local_off",
    })
  })
})
