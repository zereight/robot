import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Tools of the app for an agent runtime. A vendor program (Claude Code, Codex, Pi, Muse Code)
 * has its own tools, but the browser window of the agent belongs to the app. For the time of one
 * turn the app listens on the loopback address, and each program is told how to reach it:
 * as an MCP server, or, for Pi, as tools of the same names that the API agents have.
 */

/** The browser tools of the app. Every agent has them. */
export const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_close",
  "browser_ask_look",
] as const

/**
 * The tool that searches the past chats (spec 007). A runtime gets it only when memory is on for
 * the agent, as an API agent does.
 */
export const SEARCH_TOOL_NAME = "search_chats"

/**
 * The tools to work with other agents (spec 007, "Working with other agents"). The app checks
 * each send, so the hand-off rule of spec 030 holds for a vendor program as for an API agent.
 */
export const AGENT_TOOL_NAMES = ["list_agents", "send_message"] as const

/** The tools that the app can give to a runtime. */
export const BRIDGE_TOOL_NAMES = [
  ...BROWSER_TOOL_NAMES,
  SEARCH_TOOL_NAME,
  ...AGENT_TOOL_NAMES,
] as const

/** The name of the server, as the vendor program shows it in the name of a tool. */
export const BRIDGE_SERVER = "robot"

/**
 * The name that the app uses for a tool, from the name that a program shows for it: the program
 * puts the name of the server before it, in its own way ("mcp__robot__browser_open",
 * "robot.browser_open"). Null when the tool is not one of these.
 */
export const bridgeToolName = (shown: string): string | null => {
  for (const name of BRIDGE_TOOL_NAMES) {
    if (shown === name) return name
    if (!shown.endsWith(name)) continue
    const head = shown.slice(0, -name.length)
    if (/(^|[^a-z0-9])robot[^a-z0-9]+$/i.test(head)) return name
  }
  return null
}

export interface BridgeTool {
  readonly name: string
  readonly description: string
  /** JSON Schema of the input. */
  readonly schema: Record<string, unknown>
}

export interface BridgeOutcome {
  readonly output: string
  readonly failed: boolean
}

/** What answers a call that a program makes. */
export interface BridgeHandler {
  readonly tools: readonly BridgeTool[]
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeOutcome>
}

/** How a program reaches the app. The token is for one turn. */
export interface BridgeAccess {
  readonly url: string
  readonly token: string
  readonly tools: readonly BridgeTool[]
}

export interface BridgeGrant extends BridgeAccess {
  /** Ends the access. The server closes when the last access ends. */
  release(): void
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
const BODY_MAX = 1_000_000
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}

const failure = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
})

/** Answers one JSON-RPC message of the MCP protocol. Null for a notification. */
export const answer = async (
  handler: BridgeHandler,
  message: unknown,
  signal: AbortSignal,
): Promise<unknown | null> => {
  const request = obj(message)
  const id = request.id
  if (typeof request.method !== "string") return failure(id, -32600, "Invalid request.")
  if (id === undefined) return null
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result })
  const params = obj(request.params)
  switch (request.method) {
    case "initialize": {
      const asked = params.protocolVersion
      return ok({
        protocolVersion: PROTOCOLS.find((v) => v === asked) ?? PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: BRIDGE_SERVER, version: "1.0.0" },
      })
    }
    case "ping":
      return ok({})
    case "tools/list":
      return ok({
        tools: handler.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.schema,
        })),
      })
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : ""
      if (!handler.tools.some((t) => t.name === name))
        return failure(id, -32602, `Unknown tool: ${name}`)
      try {
        const outcome = await handler.call(name, obj(params.arguments), signal)
        return ok({ content: [{ type: "text", text: outcome.output }], isError: outcome.failed })
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        return ok({ content: [{ type: "text", text }], isError: true })
      }
    }
    default:
      return failure(id, -32601, `Unknown method: ${request.method}`)
  }
}

const readBody = (req: IncomingMessage) =>
  new Promise<string | null>((resolve) => {
    let body = ""
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_MAX) {
        resolve(null)
        req.destroy()
      } else body += chunk.toString()
    })
    req.on("end", () => resolve(body))
    req.on("error", () => resolve(null))
  })

class ToolBridge {
  private server: Server | null = null
  private ready: Promise<number> | null = null
  private readonly grants = new Map<string, BridgeHandler>()

  private ensure(): Promise<number> {
    if (this.ready) return this.ready
    const server = createServer((req, res) => void this.handle(req, res))
    this.server = server
    this.ready = new Promise<number>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    })
    return this.ready
  }

  private stop() {
    const server = this.server
    this.server = null
    this.ready = null
    server?.close()
    server?.closeAllConnections()
  }

  async grant(handler: BridgeHandler): Promise<BridgeGrant> {
    const port = await this.ensure()
    const token = randomBytes(24).toString("hex")
    this.grants.set(token, handler)
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      tools: handler.tools,
      release: () => {
        this.grants.delete(token)
        if (this.grants.size === 0) this.stop()
      },
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405, { allow: "POST" })
      res.end()
      return
    }
    // A page of a web browser cannot reach this server: it has no token, and the host must be
    // the loopback address, which also stops a name that points to it from another place.
    if (!LOOPBACK_HOST.test(req.headers.host ?? "")) return reply(403)
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]
    const handler = token ? this.grants.get(token) : undefined
    if (!handler) return reply(401)
    const body = await readBody(req)
    if (body === null) return reply(413)
    let message: unknown
    try {
      message = JSON.parse(body)
    } catch {
      return reply(400, failure(null, -32700, "Parse error."))
    }
    // The program drops the connection when it gives up on a call: the call stops with it.
    const controller = new AbortController()
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })
    const result = await answer(handler, message, controller.signal)
    if (res.destroyed) return
    if (result === null) {
      res.writeHead(202)
      res.end()
    } else reply(200, result)
  }
}

const bridge = new ToolBridge()

/** Opens access for one turn. */
export const grantBridge = (handler: BridgeHandler): Promise<BridgeGrant> => bridge.grant(handler)

// ---- what each program is given -----------------------------------------------------------

/**
 * A program that only starts MCP servers as child programs gets this script. It reads the lines
 * of the program on its input, sends each to the app, and writes the answer on its output. The
 * last argument names the file with the address and the token, so that the token is in no list
 * of processes. The app itself runs the script (see `stdioServer`).
 */
export const SHIM = `
const fs = require("node:fs")
const access = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], "utf8"))
const out = (text) => process.stdout.write(text + "\\n")
const fail = (id, message) =>
  id === undefined ? undefined : out(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }))
const rl = require("node:readline").createInterface({ input: process.stdin })
rl.on("line", async (line) => {
  if (!line.trim()) return
  let id
  try { id = JSON.parse(line).id } catch { return }
  try {
    const res = await fetch(access.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + access.token },
      body: line,
    })
    const text = (await res.text()).trim()
    if (res.status === 200 && text) out(text)
    else if (res.status !== 202) fail(id, "The app answered " + res.status + ".")
  } catch (error) {
    fail(id, String(error))
  }
})
rl.on("close", () => process.exit(0))
`

/** The app runs the script with its own runtime: the one program that is sure to be there. */
export const stdioServer = (accessFile: string) => ({
  command: process.execPath,
  args: ["-e", SHIM, accessFile],
  env: { ELECTRON_RUN_AS_NODE: "1" } as Record<string, string>,
})

/** Pi has no flag for a server of one run, so the app gives it tools of the same names. */
export const piExtensionSource = (tools: readonly BridgeTool[], accessFile: string) => `
import { readFileSync } from "node:fs"
const access = JSON.parse(readFileSync(${JSON.stringify(accessFile)}, "utf8"))
const tools = ${JSON.stringify(tools)}
const call = async (name, args, signal) => {
  const res = await fetch(access.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + access.token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } }),
    signal,
  })
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  const text = (body.result?.content ?? []).map((c) => c.text ?? "").join("\\n")
  if (body.result?.isError) throw new Error(text)
  return { content: [{ type: "text", text }], details: undefined }
}
export default function (pi) {
  for (const tool of tools)
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.schema,
      execute: (_id, params, signal) => call(tool.name, params, signal),
    })
}
`

/** Files of one run, in a folder that only the user can read. `remove` deletes the folder. */
export interface Staged {
  readonly accessFile: string
  /** For `claude --mcp-config`. */
  readonly claudeConfig: string
  /** For `pi --extension`. */
  readonly piExtension: string
  remove(): void
}

export const stage = (access: BridgeAccess): Staged => {
  const dir = mkdtempSync(join(tmpdir(), "robot-bridge-"))
  const write = (name: string, text: string) => {
    const path = join(dir, name)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }
  const accessFile = write("access.json", JSON.stringify({ url: access.url, token: access.token }))
  return {
    accessFile,
    claudeConfig: write(
      "claude.json",
      JSON.stringify({
        mcpServers: {
          [BRIDGE_SERVER]: {
            type: "http",
            url: access.url,
            headers: { Authorization: `Bearer ${access.token}` },
          },
        },
      }),
    ),
    piExtension: write("pi.mjs", piExtensionSource(access.tools, accessFile)),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** The settings that start the script as the MCP server of Codex. Values parse as JSON and as TOML. */
export const codexBridgeArgs = (staged: Staged): string[] => {
  const server = stdioServer(staged.accessFile)
  const key = `mcp_servers.${BRIDGE_SERVER}`
  return [
    "-c",
    `${key}.command=${JSON.stringify(server.command)}`,
    "-c",
    `${key}.args=${JSON.stringify(server.args)}`,
    ...Object.entries(server.env).flatMap(([name, value]) => [
      "-c",
      `${key}.env.${name}=${JSON.stringify(value)}`,
    ]),
  ]
}

/** The variable of Muse Code that holds the header of the token. */
export const MUSE_AUTH_VARIABLE = "ROBOT_BRIDGE_AUTH"

/**
 * The setting that makes the app a server of Muse Code, and the variable that it needs. The
 * program reads a secret of a setting only from its environment, so the token is in no argument
 * and in no file.
 */
export const museBridge = (access: BridgeAccess) => ({
  args: [
    "-c",
    `mcpServers.${BRIDGE_SERVER}=${JSON.stringify({
      url: access.url,
      headers: { Authorization: `\${${MUSE_AUTH_VARIABLE}}` },
    })}`,
  ],
  env: { [MUSE_AUTH_VARIABLE]: `Bearer ${access.token}` } as Record<string, string>,
})
