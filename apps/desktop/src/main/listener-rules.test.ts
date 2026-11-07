import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

// Rules for the servers that a test starts.
//
// A server that asks the system for a free port (port 0) and listens on all addresses can get a
// port that another program of the computer already holds on 127.0.0.1 or on all IPv4 addresses
// (a tunnel agent, a development server, a VPN). A test that connects to 127.0.0.1 and that port
// then reaches the other program. It answers "404" or "401" at once, or never answers, and the
// test fails by chance, about 1 time in 200. A server that listens on 127.0.0.1 only gets a port
// that is free there.
//
// So every server of a test names its address. A test that needs all addresses on purpose names
// them (`"0.0.0.0"`) or has an entry in the list below, with its reason.
//
// The rule looks at the files of tests, the helpers of tests and the end-to-end files. The code
// of the app is not looked at: the app listens on all addresses, and the test preload tells it
// where to listen in a unit test (see `test-preload.ts`).

const root = join(import.meta.dir, "..", "..", "..", "..")

/** Servers that name no address on purpose. The key is the file and the line that starts the call. */
const exceptions: { key: string; reason: string }[] = [
  {
    key: "apps/desktop/e2e/ports.ts | probe.listen(port, () => probe.close(() => resolve(true)))",
    reason:
      "This probe checks that a number is free on all addresses, because the app that gets the number listens on all addresses. A probe on 127.0.0.1 only would call a number free that another program holds on another address of this computer.",
  },
]

type Call = { line: number; text: string; start: string }

// What names an address, for each way to start a server.
const kinds: { call: RegExp; address: RegExp }[] = [
  { call: /\bBun\.serve\(/, address: /\bhostname\s*:/ },
  { call: /\bnew WebSocketServer\(/, address: /\bhost\s*:/ },
  // `listen(port, "address", ...)` or `listen({ port, host: "address" })`.
  { call: /\.listen\(/, address: /\.listen\(\s*(?:[^,(){}]*,\s*["'`]|\{[^}]*\bhost(?:name)?\s*:)/ },
]

const FAR = 80

/** The lines of the call that starts at `at`: one line, or up to the line that closes it. */
function callAt(lines: string[], at: number): string {
  const first = lines[at] ?? ""
  const opens = (first.match(/\(/g) ?? []).length - (first.match(/\)/g) ?? []).length
  if (opens <= 0) return first
  // The files are formatted by Biome: a call that spans lines ends at a line that closes with the
  // indent of the line that opened it.
  const indent = first.match(/^\s*/)?.[0] ?? ""
  const text = [first]
  for (let i = at + 1; i < Math.min(lines.length, at + FAR); i++) {
    const line = lines[i] ?? ""
    text.push(line)
    if (line.startsWith(indent) && /^[)}\]]/.test(line.slice(indent.length))) break
  }
  return text.join("\n")
}

/** The servers in `source` that name no address. A full-line comment is not looked at. */
export function unbound(source: string): Call[] {
  const lines = source.split("\n").map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? "" : line))
  const found: Call[] = []
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? ""
    for (const { call, address } of kinds) {
      if (!call.test(line)) continue
      const text = callAt(lines, at)
      if (!address.test(text)) found.push({ line: at + 1, text, start: line.trim() })
    }
  }
  return found
}

const skippedFolders = new Set(["node_modules", "build", "dist", "out", "target", ".git"])
const isTestCode = (path: string) =>
  /\.(test|testing|spec)\.tsx?$/.test(path) || path.startsWith("apps/desktop/e2e/")

function files(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skippedFolders.has(entry.name)) found.push(...files(path))
    } else if (/\.tsx?$/.test(entry.name)) {
      const name = relative(root, path)
      // This file holds the samples of the rule itself.
      if (isTestCode(name) && path !== import.meta.path) found.push(path)
    }
  }
  return found.sort()
}

describe("the scan of a source", () => {
  test("a server with a port and no address is found", () => {
    const source = ["const server = Bun.serve({", "  port: 0,", "  fetch() {},", "})"].join("\n")
    expect(unbound(source).map((c) => c.line)).toEqual([1])
    expect(unbound("const s = new WebSocketServer({ port: 0 })").length).toBe(1)
    expect(unbound("await new Promise<void>((done) => s.listen(0, done))").length).toBe(1)
    expect(unbound("s.listen({ port: 0 }, done)").length).toBe(1)
  })

  test("a server that names its address is not found", () => {
    const source = [
      "const server = Bun.serve({",
      "  port: 0,",
      '  hostname: "127.0.0.1",',
      "  fetch() {},",
      "})",
    ].join("\n")
    expect(unbound(source)).toEqual([])
    expect(unbound('new WebSocketServer({ port: 0, host: "127.0.0.1" })')).toEqual([])
    expect(unbound('s.listen(0, "127.0.0.1", done)')).toEqual([])
    expect(unbound('s.listen(port, "0.0.0.0", () => s.close())')).toEqual([])
    expect(unbound('s.listen({ port: 0, host: "127.0.0.1" }, done)')).toEqual([])
  })

  test("the address of a server that is after its handler is found", () => {
    const source = [
      "const a = Bun.serve({",
      "  fetch(req) {",
      "    return new Response(String(req.url))",
      "  },",
      '  hostname: "127.0.0.1",',
      "  port: 0,",
      "})",
      "const b = Bun.serve({",
      "  fetch(req) {",
      "    return new Response(String(req.url))",
      "  },",
      "  port: 0,",
      "})",
    ].join("\n")
    expect(unbound(source).map((c) => c.line)).toEqual([8])
  })

  test("a comment is not a server", () => {
    expect(unbound("// A server: Bun.serve({ port: 0 })\n/**\n * s.listen(0)\n */")).toEqual([])
  })
})

describe("the servers of tests", () => {
  const scanned = files(root).flatMap((path) => {
    const name = relative(root, path)
    return unbound(readFileSync(path, "utf8")).map((call) => ({ ...call, file: name }))
  })
  const allowed = exceptions.map((e) => e.key)
  const fresh: string[] = []
  const used = new Set<string>()
  for (const call of scanned) {
    const key = `${call.file} | ${call.start}`
    if (allowed.includes(key)) used.add(key)
    else fresh.push(`${call.file}:${call.line} ${call.start}`)
  }

  test("every server of a test names its address. Use hostname: '127.0.0.1' (or host)", () => {
    expect(fresh).toEqual([])
  })

  test("every listed exception is still in use. Remove one that is gone", () => {
    expect(allowed.filter((key) => !used.has(key))).toEqual([])
  })

  test("every listed exception has a reason", () => {
    expect(exceptions.filter((e) => e.reason.trim() === "").map((e) => e.key)).toEqual([])
  })

  test("the scan reaches the test files", () => {
    expect(files(root).length).toBeGreaterThan(100)
    expect(files(root).some((path) => path.endsWith("nearby.testing.ts"))).toBe(true)
  })
})
