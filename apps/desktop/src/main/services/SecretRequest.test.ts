import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { testSecretRequest } from "./SecretRequest.ts"

const VALUE = "tok-Zq81xVb27mW0-secret"
const bearer = { kind: "bearer" } as const

/** A test web service, written for the test. */
let server: Server
let port = 0
const origin = () => `http://127.0.0.1:${port}`
/** The requests that reached the service: the path and the header that carried the secret. */
const seen: { path: string; auth: string | string[] | undefined }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "/", auth: req.headers.authorization })
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `${origin()}/ok` })
      res.end()
    } else if (req.url === "/hang") {
      // No answer: the request ends at the time limit.
    } else if (req.url === "/echo") {
      // The service sends the value back in its body.
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(`you sent ${VALUE}`)
    } else if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("fine")
    } else {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("missing")
    }
  })
  const { promise, resolve } = Promise.withResolvers<void>()
  server.on("listening", () => resolve())
  server.listen(0, "127.0.0.1")
  await promise
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  const { promise, resolve } = Promise.withResolvers<void>()
  server.close(() => resolve())
  return promise
})

describe("Test of a saved secret (spec 020, flow 4)", () => {
  test("a GET request carries the secret and the row shows the status code", async () => {
    seen.length = 0
    const result = await testSecretRequest(`${origin()}/ok`, origin(), bearer, VALUE, {
      allowLocal: true,
    })
    expect(result).toEqual({ ok: true, status: 200 })
    expect(seen).toEqual([{ path: "/ok", auth: `Bearer ${VALUE}` }])
  })

  test("the answer never shows the value, also when the service echoes it", async () => {
    const result = await testSecretRequest(`${origin()}/echo`, origin(), bearer, VALUE, {
      allowLocal: true,
    })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(VALUE)
  })

  test("a redirect is not followed: the row shows the status and the new address", async () => {
    seen.length = 0
    const result = await testSecretRequest(`${origin()}/redirect`, origin(), bearer, VALUE, {
      allowLocal: true,
    })
    expect(result).toEqual({ ok: true, status: 302, location: `${origin()}/ok` })
    expect(seen.map((s) => s.path)).toEqual(["/redirect"])
  })

  test("a request with the secret to another port is refused and sends nothing", async () => {
    seen.length = 0
    const result = await testSecretRequest(
      `${origin()}/ok`,
      `http://127.0.0.1:${port + 1}`,
      bearer,
      VALUE,
      {
        allowLocal: true,
      },
    )
    expect(result).toEqual({ ok: false, reason: "other_origin" })
    expect(seen).toEqual([])
  })
  test("a missing page still shows its status code", async () => {
    const result = await testSecretRequest(`${origin()}/missing`, origin(), bearer, VALUE, {
      allowLocal: true,
    })
    expect(result).toEqual({ ok: true, status: 404 })
  })

  test("with the switch off, a request to this computer is refused and sends nothing", async () => {
    seen.length = 0
    const result = await testSecretRequest(`${origin()}/ok`, origin(), bearer, VALUE, {
      allowLocal: false,
    })
    expect(result).toEqual({ ok: false, reason: "local_off" })
    expect(seen).toEqual([])
  })

  test("an address outside this computer and the local network must use https", async () => {
    seen.length = 0
    expect(
      await testSecretRequest("http://api.example.com/", "http://api.example.com", bearer, VALUE, {
        allowLocal: true,
      }),
    ).toEqual({ ok: false, reason: "http_public" })
    expect(seen).toEqual([])
  })

  test("a link-local address and a cloud metadata address are refused", async () => {
    seen.length = 0
    expect(
      await testSecretRequest(
        "http://169.254.169.254/latest/",
        "http://169.254.169.254",
        bearer,
        VALUE,
        {
          allowLocal: true,
        },
      ),
    ).toEqual({ ok: false, reason: "blocked" })
    expect(
      await testSecretRequest(
        "http://metadata.google.internal/",
        "http://metadata.google.internal",
        bearer,
        VALUE,
        { allowLocal: true },
      ),
    ).toEqual({ ok: false, reason: "blocked" })
    // A name that leads to a blocked address is refused after the lookup, before any request.
    seen.length = 0
    expect(
      await testSecretRequest(`${origin()}/ok`, origin(), bearer, VALUE, {
        allowLocal: true,
        lookup: async () => [{ address: "169.254.169.254" }],
      }),
    ).toEqual({ ok: false, reason: "blocked" })
    expect(seen).toEqual([])
  })

  test("a request that waits ends at the time limit", async () => {
    const result = await testSecretRequest(`${origin()}/hang`, origin(), bearer, VALUE, {
      allowLocal: true,
      timeoutMs: 150,
    })
    expect(result).toEqual({ ok: false, reason: "timeout" })
  })
})
