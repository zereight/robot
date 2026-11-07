import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  McpCallError,
  McpCallStopped,
  McpError,
  type McpSession,
  type McpSpec,
  openMcp,
  resultText,
} from "./mcp.ts"

const SERVER = join(import.meta.dir, "../../../e2e/fakes/mcp-server.mjs")
const work = mkdtempSync(join(tmpdir(), "robot-mcp-"))

const program = (env: Record<string, string> = {}): Extract<McpSpec, { kind: "program" }> => ({
  kind: "program",
  command: process.execPath,
  args: [SERVER],
  // Not the temp folder: Bun starts slowly in a folder whose parent holds very many entries.
  cwd: process.cwd(),
  env: { PATH: process.env.PATH, ...env },
})

const sessions: McpSession[] = []
const open = async (spec: McpSpec, timeoutMs = 10_000) => {
  const s = await openMcp(spec, { timeoutMs })
  sessions.push(s)
  return s
}
afterAll(() => {
  for (const s of sessions) s.close()
})

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

/** Starts the test server on HTTP and waits until it answers. */
const http = async (env: Record<string, string> = {}) => {
  const port = await freePort()
  const child = Bun.spawn([process.execPath, SERVER], {
    env: { ...process.env, MCP_TEST_HTTP_PORT: String(port), ...env },
    stdout: "ignore",
    stderr: "ignore",
  })
  afterAll(() => child.kill())
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "DELETE" })
      break
    } catch {
      await Bun.sleep(25)
    }
  }
  return { port, url: `http://127.0.0.1:${port}/mcp` }
}

describe("a program on this computer", () => {
  test("lists tools with their descriptions and the read-only mark", async () => {
    const s = await open(program())
    const { tools, more } = await s.listTools(5_000)
    expect(more).toBe(false)
    const names = tools.map((t) => t.name)
    expect(names).toContain("echo")
    expect(names).toContain("lookup")
    expect(tools.find((t) => t.name === "echo")?.description).toBe("Gives the text back.")
    expect(tools.find((t) => t.name === "lookup")?.readOnly).toBe(true)
    expect(tools.find((t) => t.name === "echo")?.readOnly).toBe(false)
    expect(tools.find((t) => t.name === "echo")?.schema.type).toBe("object")
  })

  test("calls a tool and gives its text", async () => {
    const s = await open(program())
    const r = await s.call(
      "echo",
      { text: "hi" },
      { signal: new AbortController().signal, timeoutMs: 5_000 },
    )
    expect(r).toEqual({ text: "Echo: hi", isError: false })
  })

  test("a result that the tool marks as an error is a result with that mark", async () => {
    const s = await open(program())
    const r = await s.call("broken", {}, { signal: new AbortController().signal, timeoutMs: 5_000 })
    expect(r).toEqual({ text: "It failed on purpose.", isError: true })
  })

  test("a tool that never answers ends at the time limit", async () => {
    const s = await open(program())
    const started = Date.now()
    const result = s.call("slow", {}, { signal: new AbortController().signal, timeoutMs: 300 })
    await expect(result).rejects.toBeInstanceOf(McpCallStopped)
    await expect(result).rejects.toMatchObject({ why: "timeout" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("Stop ends a running call within 2 seconds", async () => {
    const s = await open(program())
    const stop = new AbortController()
    const started = Date.now()
    const result = s.call("slow", {}, { signal: stop.signal, timeoutMs: 60_000 })
    setTimeout(() => stop.abort(), 100)
    await expect(result).rejects.toMatchObject({ why: "stop" })
    expect(Date.now() - started).toBeLessThan(2_000)
    // The connection still works after a stopped call.
    const again = await s.call(
      "echo",
      { text: "x" },
      { signal: new AbortController().signal, timeoutMs: 5_000 },
    )
    expect(again.text).toBe("Echo: x")
  })

  test("a program gets only the values of the connection", async () => {
    const s = await open(program({ TEST_ONE: "1", TEST_TWO: "2" }))
    const r = await s.call(
      "show_env",
      {},
      { signal: new AbortController().signal, timeoutMs: 5_000 },
    )
    expect(r.text.split("\n").sort()).toEqual(["TEST_ONE=1", "TEST_TWO=2"])
  })

  test("a program that is not there fails with the reason", async () => {
    const spec: McpSpec = { ...program(), command: join(work, "no-such-program") }
    await expect(openMcp(spec, { timeoutMs: 5_000 })).rejects.toMatchObject({
      failure: "not_found",
    })
  })

  test("a working folder that is not there fails with the reason", async () => {
    const spec: McpSpec = { ...program(), cwd: join(work, "no-such-folder") } as McpSpec
    await expect(openMcp(spec, { timeoutMs: 5_000 })).rejects.toMatchObject({
      failure: "not_found",
    })
  })

  test("a program that ends at once fails with the reason", async () => {
    const spec: McpSpec = {
      ...program(),
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
    }
    await expect(openMcp(spec, { timeoutMs: 5_000 })).rejects.toMatchObject({ failure: "ended" })
  })

  test("a program that does not answer fails at the time limit", async () => {
    const spec: McpSpec = {
      ...program(),
      args: ["-e", "setInterval(() => {}, 1000)"],
    }
    const started = Date.now()
    await expect(openMcp(spec, { timeoutMs: 300 })).rejects.toMatchObject({ failure: "timeout" })
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test("a program that answers with text that is not valid fails with the reason", async () => {
    const spec: McpSpec = {
      ...program(),
      args: [
        "-e",
        `require("node:readline").createInterface({input:process.stdin}).on("line",l=>{const m=JSON.parse(l);console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:"nonsense"}))})`,
      ],
    }
    await expect(openMcp(spec, { timeoutMs: 5_000 })).rejects.toMatchObject({ failure: "invalid" })
  })

  test("close ends the program that the app started", async () => {
    const s = await open(program())
    s.close()
    await Promise.race([
      s.closed,
      Bun.sleep(3_000).then(() => Promise.reject(new Error("still running"))),
    ])
  })

  test("close ends the program and every process that it started (its whole group)", async () => {
    // A launcher such as `npx` starts the real server as a child. This one starts a child that
    // sleeps for a long time, writes its number to a file, and then becomes the test server.
    const pidFile = join(work, `child-${Date.now()}.pid`)
    const s = await open({
      kind: "program",
      command: "/bin/sh",
      args: ["-c", `sleep 300 & echo $! > "${pidFile}"; exec "${process.execPath}" "${SERVER}"`],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
    })
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(pid).toBeGreaterThan(1)
    expect(alive(pid)).toBe(true)
    s.close()
    const end = Date.now() + 5_000
    while (alive(pid) && Date.now() < end) await Bun.sleep(25)
    expect(alive(pid)).toBe(false)
  })

  test("a tool list with more than 1000 tools says that it holds more", async () => {
    const s = await open(program({ MCP_TEST_TOOLS: "1100" }))
    const { tools, more } = await s.listTools(10_000)
    expect(tools).toHaveLength(1000)
    expect(more).toBe(true)
  })
})

describe("a web address", () => {
  test("lists tools and calls one; a call answers as a stream of events", async () => {
    const { url } = await http()
    const s = await open({ kind: "web", url, headers: {} })
    const { tools } = await s.listTools(5_000)
    expect(tools.map((t) => t.name)).toContain("echo")
    const r = await s.call(
      "echo",
      { text: "web" },
      { signal: new AbortController().signal, timeoutMs: 5_000 },
    )
    expect(r.text).toBe("Echo: web")
  })

  test("a header goes with every request; a wrong sign-in fails with the reason", async () => {
    const { url } = await http({ MCP_TEST_TOKEN: "secret-1" })
    await expect(
      openMcp({ kind: "web", url, headers: {} }, { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      failure: "sign_in",
    })
    const s = await open({ kind: "web", url, headers: { Authorization: "Bearer secret-1" } })
    expect((await s.listTools(5_000)).tools.length).toBeGreaterThan(3)
  })

  test("an address that nobody listens on is refused", async () => {
    const port = await freePort()
    await expect(
      openMcp(
        { kind: "web", url: `http://127.0.0.1:${port}/mcp`, headers: {} },
        { timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ failure: "refused" })
  })

  test("an address that breaks the rules is never reached, also when it comes from an import", async () => {
    // Plain http to a host that is not this computer, and an address with a sign-in part.
    for (const url of ["http://example.com/mcp", "https://user:pass@example.com/mcp", "ftp://x/y"])
      await expect(
        openMcp({ kind: "web", url, headers: {} }, { timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ failure: "refused" })
  })

  test("a redirect to another host is not followed", async () => {
    const { port } = await http()
    await expect(
      openMcp(
        { kind: "web", url: `http://127.0.0.1:${port}/moved`, headers: {} },
        { timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ failure: "refused" })
  })

  test("a call that never answers ends at the time limit, and Stop ends it fast", async () => {
    const { url } = await http()
    const s = await open({ kind: "web", url, headers: {} })
    await expect(
      s.call("slow", {}, { signal: new AbortController().signal, timeoutMs: 300 }),
    ).rejects.toMatchObject({ why: "timeout" })
    const stop = new AbortController()
    const started = Date.now()
    const result = s.call("slow", {}, { signal: stop.signal, timeoutMs: 60_000 })
    setTimeout(() => stop.abort(), 100)
    await expect(result).rejects.toMatchObject({ why: "stop" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("a server that does not speak MCP fails with the reason", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<html>hello</html>", { headers: { "content-type": "text/html" } }),
    })
    afterAll(() => server.stop())
    await expect(
      openMcp(
        { kind: "web", url: `http://127.0.0.1:${server.port}/`, headers: {} },
        { timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ failure: "invalid" })
  })
})

describe("the text of a result", () => {
  test("joins text, and marks a picture instead of giving its bytes", () => {
    expect(
      resultText({
        content: [
          { type: "text", text: "a" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
          { type: "text", text: "b" },
          { type: "resource", resource: { uri: "file:///x", text: "inside" } },
          { type: "resource", resource: { uri: "file:///y", blob: "AA" } },
        ],
      }),
    ).toBe("a\n[image: image/png]\nb\ninside\n[resource: file:///y]")
  })

  test("uses structured content when there is no content", () => {
    expect(resultText({ structuredContent: { n: 1 } })).toBe('{"n":1}')
    expect(resultText("nope")).toBe("")
  })
})

describe("errors", () => {
  test("the error classes carry the reason", () => {
    expect(new McpError("timeout").failure).toBe("timeout")
    expect(new McpCallError("x").message).toBe("x")
    expect(readFileSync(SERVER, "utf8")).toContain("MCP_TEST_HTTP_PORT")
  })
})
