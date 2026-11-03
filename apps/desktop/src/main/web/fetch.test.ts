import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { type CheckedFetch, checkedFetch, type LocalAsk, type Resolver } from "./fetch.ts"

/** A test server on this computer. Its paths answer as the tests need. */
let server: Server
let port = 0
/** The requests that reached the server: the host header and the path. */
const seen: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.headers.host} ${req.url}`)
    const path = req.url ?? "/"
    if (path === "/page") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<p>hello</p>")
    } else if (path === "/zipped") {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" })
      res.end(gzipSync("zipped text"))
    } else if (path === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" })
      res.end()
    } else if (path === "/to-metadata-v6") {
      res.writeHead(302, { location: "http://[fd00:ec2::254]/" })
      res.end()
    } else if (path === "/to-metadata-mapped") {
      res.writeHead(302, { location: "http://[::ffff:169.254.169.254]/" })
      res.end()
    } else if (path === "/to-metadata-name") {
      res.writeHead(301, { location: "http://metadata.google.internal/computeMetadata/v1/" })
      res.end()
    } else if (path === "/to-local-name") {
      res.writeHead(302, { location: `http://leads-local.test:${port}/page` })
      res.end()
    } else if (path === "/to-page") {
      res.writeHead(307, { location: "/page" })
      res.end()
    } else if (path === "/loop") {
      res.writeHead(302, { location: "/loop" })
      res.end()
    } else if (path === "/to-ftp") {
      res.writeHead(302, { location: "ftp://example.test/x" })
      res.end()
    } else if (path === "/big") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("x".repeat(5000))
    } else if (path === "/slow") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("start")
    } else {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("nothing")
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

/** A resolver with a fixed table. A name that is not in it fails like a name that does not exist. */
const table =
  (map: Record<string, string[]>, calls: string[] = []): Resolver =>
  async (host) => {
    calls.push(host)
    const list = map[host]
    if (!list) throw new Error(`ENOTFOUND ${host}`)
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
  }

/** What a run of `checkedFetch` needs. The user answers each question with `answer`. */
const run = (
  url: string,
  options: {
    answer?: boolean
    asked?: LocalAsk[]
    resolve?: Resolver
  } & Partial<CheckedFetch> = {},
) => {
  const { answer = true, asked = [], resolve, ...rest } = options
  return checkedFetch({
    url,
    signal: new AbortController().signal,
    allowLocal: async (ask) => {
      asked.push(ask)
      return answer
    },
    ...(resolve ? { resolve } : {}),
    ...rest,
  })
}

describe("checkedFetch: a page", () => {
  test("a local address asks first, then the page comes", async () => {
    const asked: LocalAsk[] = []
    const result = await run(`http://127.0.0.1:${port}/page`, { asked })
    expect(asked).toEqual([
      { host: "127.0.0.1", url: `http://127.0.0.1:${port}/page`, byName: false },
    ])
    expect(result).toMatchObject({ kind: "page", status: 200, ok: true, body: "<p>hello</p>" })
  })

  test("a page that the server zips is read", async () => {
    const result = await run(`http://127.0.0.1:${port}/zipped`)
    expect(result).toMatchObject({ kind: "page", body: "zipped text" })
  })

  test("a page that is not found gives its status", async () => {
    const result = await run(`http://127.0.0.1:${port}/missing`)
    expect(result).toMatchObject({ kind: "page", status: 404, ok: false, body: "nothing" })
  })

  test("a page is cut at the limit of bytes", async () => {
    const result = await run(`http://127.0.0.1:${port}/big`, { readBytes: 100 })
    expect(result).toMatchObject({ kind: "page" })
    expect(result.kind === "page" && result.body.length).toBe(100)
  })

  test("a relative redirect is followed on the same host", async () => {
    const asked: LocalAsk[] = []
    const result = await run(`http://127.0.0.1:${port}/to-page`, { asked })
    expect(result).toMatchObject({ kind: "page", body: "<p>hello</p>" })
    // Each step is a connection: the local address asks at each step.
    expect(asked).toHaveLength(2)
  })

  test("a redirect that never ends stops", async () => {
    const result = await run(`http://127.0.0.1:${port}/loop`, { maxRedirects: 3 })
    expect(result).toEqual({ kind: "failed", reason: "redirects" })
  })

  test("only http and https, and no sign-in part", async () => {
    expect(await run("ftp://127.0.0.1/x")).toEqual({ kind: "failed", reason: "scheme" })
    expect(await run("not a url")).toEqual({ kind: "failed", reason: "invalid" })
    expect(await run("http://user:pass@127.0.0.1/x")).toEqual({ kind: "failed", reason: "invalid" })
    expect(await run(`http://127.0.0.1:${port}/to-ftp`)).toEqual({
      kind: "failed",
      reason: "scheme",
    })
  })

  test("a server that does not answer in time fails with the reason", async () => {
    const result = await run(`http://127.0.0.1:${port}/slow`, { timeoutMs: 150 })
    expect(result).toEqual({ kind: "failed", reason: "timeout" })
  })

  test("Stop ends the fetch", async () => {
    const stop = new AbortController()
    const pending = checkedFetch({
      url: `http://127.0.0.1:${port}/slow`,
      signal: stop.signal,
      allowLocal: async () => true,
    })
    setTimeout(() => stop.abort(), 50)
    expect(await pending).toEqual({ kind: "failed", reason: "stopped" })
  })
})

describe("checkedFetch: addresses that are never allowed", () => {
  const never = [
    "http://169.254.169.254/latest/",
    "http://169.254.0.1/",
    "http://100.100.100.200/",
    "http://[fe80::1]/",
    "http://[fd00:ec2::254]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[2002:a9fe:a9fe::1]/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "https://METADATA.GOOGLE.INTERNAL./x",
    // Other ways to write the same address: the URL reader folds them to dotted form.
    "http://2852039166/",
    "http://0xa9fea9fe/",
    "http://0251.0376.0251.0376/",
    "http://169.254.43518/",
  ]
  for (const url of never)
    test(`is refused with no question and no connection: ${url}`, async () => {
      const asked: LocalAsk[] = []
      const calls: string[] = []
      const result = await run(url, { asked, resolve: table({}, calls) })
      expect(result.kind).toBe("refused")
      expect(asked).toEqual([])
    })

  test("a name that leads to a metadata address is refused after the look-up", async () => {
    const asked: LocalAsk[] = []
    const result = await run(`http://sneaky.test:${port}/page`, {
      asked,
      resolve: table({ "sneaky.test": ["169.254.169.254"] }),
    })
    expect(result).toEqual({ kind: "refused", host: "sneaky.test" })
    expect(asked).toEqual([])
    expect(seen.filter((s) => s.startsWith("sneaky.test"))).toEqual([])
  })

  test("one address that is never allowed refuses a list with a public address", async () => {
    const result = await run(`http://mixed.test:${port}/page`, {
      resolve: table({ "mixed.test": ["93.184.216.34", "169.254.169.254", "127.0.0.1"] }),
    })
    expect(result.kind).toBe("refused")
  })

  test("IPv6 results of a look-up are checked as well", async () => {
    for (const address of ["fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254", "fe80::1%en0"]) {
      const result = await run(`http://six.test:${port}/page`, {
        resolve: table({ "six.test": [address] }),
      })
      expect(result.kind).toBe("refused")
    }
  })

  test("a redirect to a metadata address is refused, also when the first step was allowed", async () => {
    for (const path of [
      "/to-metadata",
      "/to-metadata-v6",
      "/to-metadata-mapped",
      "/to-metadata-name",
    ]) {
      const before = seen.length
      const result = await run(`http://127.0.0.1:${port}${path}`)
      expect(result.kind).toBe("refused")
      // Only the first step reached the server. The second step made no connection at all.
      expect(seen.slice(before)).toEqual([`127.0.0.1:${port} ${path}`])
    }
  })

  test("a redirect from a name to a name that leads to a metadata address is refused", async () => {
    const result = await run(`http://127.0.0.1:${port}/to-local-name`, {
      resolve: table({ "leads-local.test": ["169.254.169.254"] }),
    })
    expect(result.kind).toBe("refused")
  })
})

describe("checkedFetch: local addresses", () => {
  test("a denied question ends the fetch with no connection", async () => {
    const before = seen.length
    const result = await run(`http://127.0.0.1:${port}/page`, { answer: false })
    expect(result).toEqual({ kind: "denied", host: "127.0.0.1" })
    expect(seen.length).toBe(before)
  })

  test("the ranges of a local network ask, and the question names the host", async () => {
    for (const host of ["10.0.0.1", "172.16.5.5", "192.168.1.1", "[::1]", "[fd12:3456::1]"]) {
      const asked: LocalAsk[] = []
      const result = await run(`http://${host}:9/x`, { answer: false, asked })
      expect(result.kind).toBe("denied")
      expect(asked).toHaveLength(1)
      expect(asked[0]?.byName).toBe(false)
    }
  })

  test("localhost and a name that ends in .local are asked as written, with no second question", async () => {
    const asked: LocalAsk[] = []
    const resolve = table({ localhost: ["127.0.0.1"], "printer.local": ["127.0.0.1"] })
    const one = await run(`http://localhost:${port}/page`, { asked, resolve })
    expect(one).toMatchObject({ kind: "page", body: "<p>hello</p>" })
    const two = await run(`http://printer.local:${port}/page`, { asked, resolve })
    expect(two).toMatchObject({ kind: "page", body: "<p>hello</p>" })
    expect(asked.map((a) => [a.host, a.byName])).toEqual([
      ["localhost", false],
      ["printer.local", false],
    ])
  })

  test("a name that leads to a local address always asks, as a name", async () => {
    const asked: LocalAsk[] = []
    const result = await run(`http://leads-local.test:${port}/page`, {
      asked,
      resolve: table({ "leads-local.test": ["127.0.0.1"] }),
    })
    expect(result).toMatchObject({ kind: "page", body: "<p>hello</p>" })
    expect(asked).toEqual([
      { host: "leads-local.test", url: `http://leads-local.test:${port}/page`, byName: true },
    ])
  })

  test("a name with a public and a local address asks", async () => {
    const asked: LocalAsk[] = []
    const result = await run(`http://half.test:${port}/page`, {
      asked,
      answer: false,
      resolve: table({ "half.test": ["93.184.216.34", "127.0.0.1"] }),
    })
    expect(result).toEqual({ kind: "denied", host: "half.test" })
    expect(asked).toHaveLength(1)
  })

  test("a name that leads to a local address and a denied question makes no connection", async () => {
    const before = seen.length
    await run(`http://leads-local.test:${port}/page`, {
      answer: false,
      resolve: table({ "leads-local.test": ["127.0.0.1"] }),
    })
    expect(seen.length).toBe(before)
  })

  test("a redirect to a name that leads to a local address asks again, as a name", async () => {
    const asked: LocalAsk[] = []
    const result = await run(`http://127.0.0.1:${port}/to-local-name`, {
      asked,
      resolve: table({ "leads-local.test": ["127.0.0.1"] }),
    })
    expect(result).toMatchObject({ kind: "page", body: "<p>hello</p>" })
    expect(asked.map((a) => [a.host, a.byName])).toEqual([
      ["127.0.0.1", false],
      ["leads-local.test", true],
    ])
  })
})

describe("checkedFetch: the address that the connection really uses", () => {
  test("a name is looked up once for each step, and the connection uses that answer", async () => {
    const calls: string[] = []
    // A name that changes its answer: the first look-up leads here, any later one leads to the
    // metadata address. The connection must use the answer that was checked.
    let n = 0
    const rebinding: Resolver = async (host) => {
      calls.push(host)
      return n++ === 0
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }]
    }
    const result = await run(`http://rebind.test:${port}/page`, { resolve: rebinding })
    expect(result).toMatchObject({ kind: "page", body: "<p>hello</p>" })
    expect(calls).toEqual(["rebind.test"])
  })

  test("a name that was fine and now leads to a metadata address is refused at the next step", async () => {
    let n = 0
    const rebinding: Resolver = async () =>
      n++ === 0
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }]
    // The first step is the redirect page on this computer, which sends the agent back to the same name.
    const first = await run(`http://rebind.test:${port}/page`, { resolve: rebinding })
    expect(first.kind).toBe("page")
    const second = await run(`http://rebind.test:${port}/page`, { resolve: rebinding })
    expect(second).toEqual({ kind: "refused", host: "rebind.test" })
  })

  test("a look-up that fails is a network failure, not a refusal", async () => {
    const result = await run(`http://nowhere.test:${port}/page`, { resolve: table({}) })
    expect(result).toEqual({ kind: "failed", reason: "network" })
  })

  test("the time that the user takes to answer is not a time limit of the fetch", async () => {
    const result = await checkedFetch({
      url: `http://127.0.0.1:${port}/page`,
      signal: new AbortController().signal,
      timeoutMs: 100,
      allowLocal: async () => true,
    })
    expect(result.kind).toBe("page")
    const slowAnswer = await checkedFetch({
      url: `http://leads-local.test:${port}/page`,
      signal: new AbortController().signal,
      timeoutMs: 100,
      resolve: table({ "leads-local.test": ["127.0.0.1"] }),
      allowLocal: async () => {
        await new Promise((r) => setTimeout(r, 400))
        return true
      },
    })
    expect(slowAnswer).toMatchObject({ kind: "page", body: "<p>hello</p>" })
  })
})
