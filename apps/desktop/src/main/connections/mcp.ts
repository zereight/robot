import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createInterface } from "node:readline"
import {
  CONNECTION_TOOLS_MAX,
  type ConnectionFailure,
  checkConnectionAddress,
  TOOL_TEXT_MAX,
} from "@robot/shared"

/**
 * A small client for MCP (Model Context Protocol), written from the public protocol text. It
 * speaks JSON lines with a program on this computer, and "Streamable HTTP" with a web address. It
 * reads tools and calls them: the rest of the protocol (resources, prompts, sampling) is not used
 * (spec 018, "Out of scope"). It holds no secret of the app: it gets the values of the connection
 * and nothing else.
 */

/** The protocol versions that the client knows. The first is the one that it asks for. */
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const

/** The longest answer that the client reads from one request, in characters. */
const ANSWER_MAX = 20_000_000
/** The most pages of tools that the client reads, and the most tools in all. */
const PAGES_MAX = 20
const TOOLS_READ_MAX = 1000
const REDIRECTS_MAX = 3

/** A failure with the reason that the page shows (spec 018, "Flows"). */
export class McpError extends Error {
  constructor(
    readonly failure: ConnectionFailure,
    message: string = failure,
  ) {
    super(message)
    this.name = "McpError"
  }
}

/** The connection answered a call with an error, or the call failed on the way. */
export class McpCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpCallError"
  }
}

/** The call ended because the time limit came, or because Stop came. */
export class McpCallStopped extends Error {
  constructor(readonly why: "timeout" | "stop") {
    super(why)
    this.name = "McpCallStopped"
  }
}

export interface McpTool {
  readonly name: string
  readonly description: string
  readonly readOnly: boolean
  readonly schema: Record<string, unknown>
}

export interface McpCallResult {
  readonly text: string
  readonly isError: boolean
}

export type McpSpec =
  | {
      readonly kind: "program"
      readonly command: string
      readonly args: readonly string[]
      readonly cwd: string
      readonly env: NodeJS.ProcessEnv
    }
  | {
      readonly kind: "web"
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }

export interface McpSession {
  /** The tools of the connection, up to 1000, and whether it offered more. */
  listTools(timeoutMs: number): Promise<{ tools: McpTool[]; more: boolean }>
  call(
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult>
  /** Ends the connection. A program that the app started ends too. */
  close(): void
  /** Resolves when the connection ended, by itself or after `close`. */
  readonly closed: Promise<void>
}

/** Opens a session to a connection. Rejects with `McpError`. */
export type McpOpener = (
  spec: McpSpec,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<McpSession>

interface RequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs: number
}

interface Transport {
  request(method: string, params: unknown, options: RequestOptions): Promise<unknown>
  notify(method: string, params?: unknown): void
  close(): void
  /** A web address sends the version that the first answer named on every later request. */
  setVersion?(version: string): void
  readonly closed: Promise<void>
}

interface RpcMessage {
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const errorText = (error: unknown): string => {
  if (isObject(error) && typeof error.message === "string") return error.message
  return "The connection answered with an error."
}

/** Answers a request that the server sends to the client. Only "ping" is known. */
const serverReply = (message: RpcMessage): Record<string, unknown> | null => {
  if (message.id === undefined || typeof message.method !== "string") return null
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} }
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  }
}

/** Waits for a promise, but stops at the time limit or at the signal. */
const limited = <T>(
  work: Promise<T>,
  options: RequestOptions,
  onStop: (why: "timeout" | "stop") => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      fn()
    }
    const timer = setTimeout(() => {
      onStop("timeout")
      finish(() => reject(new McpCallStopped("timeout")))
    }, options.timeoutMs)
    const abort = () => {
      onStop("stop")
      finish(() => reject(new McpCallStopped("stop")))
    }
    if (options.signal?.aborted) return abort()
    options.signal?.addEventListener("abort", abort, { once: true })
    work.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    )
  })

// ---------------------------------------------------------------------------------------------
// A program on this computer: one JSON message on each line, in both directions.
// ---------------------------------------------------------------------------------------------

const startProgram = (spec: Extract<McpSpec, { kind: "program" }>): Transport => {
  if (!existsSync(spec.cwd)) throw new McpError("not_found", "The working folder is missing.")
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let nextId = 1
  let ended = false
  let spawnError: McpError | null = null
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const fail = (error: Error) => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  const finish = () => {
    if (ended) return
    ended = true
    fail(spawnError ?? new McpError("ended", "The program ended."))
    resolveClosed()
  }
  const send = (message: Record<string, unknown>) => {
    if (ended || !child.stdin.writable) return
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  child.once("error", (error: NodeJS.ErrnoException) => {
    spawnError =
      error.code === "ENOENT" || error.code === "EACCES" || error.code === "ENOTDIR"
        ? new McpError("not_found", "The program was not found.")
        : new McpError("ended", error.message)
    finish()
  })
  child.once("exit", finish)
  child.once("close", finish)
  // A write to a program that is gone is reported by "exit"; it must not stop the app.
  child.stdin.on("error", () => {})
  // The program may print its own log on this stream. Nothing here reads it, but it must drain.
  child.stderr.on("data", () => {})
  child.stderr.on("error", () => {})

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return
    let message: RpcMessage
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isObject(parsed)) return
      message = parsed
    } catch {
      return
    }
    if (typeof message.id === "number" && !("method" in message)) {
      const p = pending.get(message.id)
      if (!p) return
      pending.delete(message.id)
      if ("error" in message && message.error !== undefined)
        p.reject(new McpCallError(errorText(message.error)))
      else p.resolve(message.result)
      return
    }
    const reply = serverReply(message)
    if (reply) send(reply)
  })

  return {
    closed,
    request: (method, params, options) => {
      if (ended) return Promise.reject(spawnError ?? new McpError("ended", "The program ended."))
      const id = nextId++
      const work = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ jsonrpc: "2.0", id, method, params })
      })
      return limited(work, options, (why) => {
        pending.delete(id)
        send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: why === "stop" ? "Stopped by the user" : "Timed out" },
        })
      })
    },
    notify: (method, params) =>
      send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    close: () => {
      if (ended) return
      child.stdin.end()
      child.kill("SIGTERM")
      // A program that ignores the end of its input and the first signal is stopped for good.
      const hard = setTimeout(() => {
        if (!ended) child.kill("SIGKILL")
      }, 1_000)
      hard.unref()
      void closed.then(() => clearTimeout(hard))
    },
  }
}

// ---------------------------------------------------------------------------------------------
// A web address: "Streamable HTTP". Each message is a POST. The answer is one JSON body or a
// stream of events that holds the answer.
// ---------------------------------------------------------------------------------------------

/** Splits a stream of text into events and gives the `data` of each. */
export async function* eventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > ANSWER_MAX) throw new McpError("invalid", "The answer is too long.")
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n")
      for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
        if (data.length > 0) yield data.join("\n")
      }
    }
    // The last event may end with the stream and no blank line.
    const rest = buffer
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
    if (rest.length > 0) yield rest.join("\n")
  } finally {
    reader.cancel().catch(() => {})
  }
}

const startWeb = (spec: Extract<McpSpec, { kind: "web" }>): Transport => {
  let nextId = 1
  let session: string | null = null
  let version: string | null = null
  let ended = false
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const stopper = new AbortController()

  const headers = (): Record<string, string> => ({
    ...spec.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(session ? { "mcp-session-id": session } : {}),
    ...(version ? { "mcp-protocol-version": version } : {}),
  })

  /** Sends one POST. It follows a redirect only inside the same host. */
  const post = async (body: unknown, signal: AbortSignal): Promise<Response> => {
    let url = spec.url
    for (let hops = 0; ; hops++) {
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
          redirect: "manual",
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw error
        throw new McpError("refused", "The address could not be reached.")
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location")
        res.body?.cancel().catch(() => {})
        let next: URL
        try {
          next = new URL(location ?? "", url)
        } catch {
          throw new McpError("invalid", "The redirect is not valid.")
        }
        // A redirect to another host is not followed (spec 018, "Rules").
        if (
          hops >= REDIRECTS_MAX ||
          next.hostname !== new URL(spec.url).hostname ||
          checkConnectionAddress(next.href) !== null
        )
          throw new McpError("refused", "The address redirects to another place.")
        url = next.href
        continue
      }
      return res
    }
  }

  const checkStatus = (res: Response) => {
    if (res.ok) return
    res.body?.cancel().catch(() => {})
    if (res.status === 401 || res.status === 403)
      throw new McpError("sign_in", `HTTP ${res.status}`)
    if (res.status === 404 && session) throw new McpError("ended", "The session ended.")
    throw new McpError(res.status === 404 ? "refused" : "invalid", `HTTP ${res.status}`)
  }

  const respondToServer = (message: RpcMessage, signal: AbortSignal) => {
    const reply = serverReply(message)
    if (reply)
      void post(reply, signal).then(
        (r) => r.body?.cancel().catch(() => {}),
        () => {},
      )
  }

  const answer = async (id: number, res: Response, signal: AbortSignal): Promise<unknown> => {
    const type = res.headers.get("content-type") ?? ""
    if (type.includes("text/event-stream") && res.body) {
      for await (const data of eventData(res.body)) {
        let message: unknown
        try {
          message = JSON.parse(data)
        } catch {
          continue
        }
        for (const m of Array.isArray(message) ? message : [message]) {
          if (!isObject(m)) continue
          if (m.id === id && !("method" in m)) {
            if ("error" in m && m.error !== undefined) throw new McpCallError(errorText(m.error))
            return m.result
          }
          respondToServer(m, signal)
        }
      }
      throw new McpError("ended", "The answer ended with no result.")
    }
    const text = await res.text()
    if (text.length > ANSWER_MAX) throw new McpError("invalid", "The answer is too long.")
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      throw new McpError("invalid", "The answer is not JSON.")
    }
    for (const m of Array.isArray(message) ? message : [message]) {
      if (isObject(m) && m.id === id && !("method" in m)) {
        if ("error" in m && m.error !== undefined) throw new McpCallError(errorText(m.error))
        return m.result
      }
    }
    throw new McpError("invalid", "The answer holds no result.")
  }

  return {
    closed,
    request: (method, params, options) => {
      if (ended) return Promise.reject(new McpError("ended", "The connection ended."))
      const id = nextId++
      const own = new AbortController()
      const work = (async () => {
        const res = await post({ jsonrpc: "2.0", id, method, params }, own.signal)
        checkStatus(res)
        const fromServer = res.headers.get("mcp-session-id")
        if (method === "initialize" && fromServer) session = fromServer
        return answer(id, res, own.signal)
      })()
      const stop = () => own.abort()
      stopper.signal.addEventListener("abort", stop, { once: true })
      return limited(work, options, (why) => {
        own.abort()
        // A call that was running gets a note, so that the server can stop its work.
        if (method === "tools/call") {
          const note = {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: why === "stop" ? "Stopped by the user" : "Timed out" },
          }
          void post(note, AbortSignal.timeout(2_000)).then(
            (r) => r.body?.cancel().catch(() => {}),
            () => {},
          )
        }
      }).finally(() => stopper.signal.removeEventListener("abort", stop))
    },
    notify: (method, params) => {
      if (ended) return
      const body = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }
      void post(body, AbortSignal.any([stopper.signal, AbortSignal.timeout(10_000)])).then(
        (r) => r.body?.cancel().catch(() => {}),
        () => {},
      )
    },
    close: () => {
      if (ended) return
      ended = true
      stopper.abort()
      // A server that keeps sessions is told that this one ends. Nothing waits for the answer.
      if (session) {
        void fetch(spec.url, {
          method: "DELETE",
          headers: { ...spec.headers, "mcp-session-id": session },
          redirect: "manual",
          signal: AbortSignal.timeout(2_000),
        }).then(
          (r) => r.body?.cancel().catch(() => {}),
          () => {},
        )
      }
      resolveClosed()
    },
    setVersion: (v) => {
      version = v
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The session.
// ---------------------------------------------------------------------------------------------

/** Makes text of the content of a result. A picture or a sound gives a short mark, not its bytes. */
export const resultText = (result: unknown): string => {
  if (!isObject(result)) return ""
  const parts: string[] = []
  const content = Array.isArray(result.content) ? result.content : []
  for (const item of content) {
    if (!isObject(item)) continue
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text)
    else if (item.type === "image" || item.type === "audio")
      parts.push(
        `[${String(item.type)}: ${typeof item.mimeType === "string" ? item.mimeType : "unknown type"}]`,
      )
    else if (item.type === "resource" && isObject(item.resource)) {
      const r = item.resource
      parts.push(
        typeof r.text === "string"
          ? r.text
          : `[resource: ${typeof r.uri === "string" ? r.uri : "unknown"}]`,
      )
    } else if (item.type === "resource_link")
      parts.push(`[link: ${typeof item.uri === "string" ? item.uri : "unknown"}]`)
  }
  if (parts.length === 0 && result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent)
  return parts.join("\n")
}

const toolOf = (raw: unknown): McpTool | null => {
  if (!isObject(raw) || typeof raw.name !== "string" || !raw.name || raw.name.length > 200)
    return null
  const schema = isObject(raw.inputSchema) ? { ...raw.inputSchema } : {}
  // A model needs an object with properties for the arguments of a tool.
  if (schema.type !== "object") {
    schema.type = "object"
    if (!isObject(schema.properties)) schema.properties = {}
  }
  const annotations = isObject(raw.annotations) ? raw.annotations : {}
  return {
    name: raw.name,
    description: (typeof raw.description === "string" ? raw.description : "").slice(
      0,
      TOOL_TEXT_MAX,
    ),
    readOnly: annotations.readOnlyHint === true,
    schema,
  }
}

const sessionOf = (transport: Transport): McpSession => ({
  closed: transport.closed,
  close: () => transport.close(),
  listTools: async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    const tools: McpTool[] = []
    const names = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < PAGES_MAX; page++) {
      const left = deadline - Date.now()
      if (left <= 0) throw new McpError("timeout", "No answer in time.")
      let result: unknown
      try {
        result = await transport.request("tools/list", cursor ? { cursor } : {}, {
          timeoutMs: left,
        })
      } catch (error) {
        if (error instanceof McpCallStopped) throw new McpError("timeout", "No answer in time.")
        if (error instanceof McpCallError) throw new McpError("invalid", error.message)
        throw error
      }
      if (!isObject(result) || !Array.isArray(result.tools))
        throw new McpError("invalid", "The list of tools is not valid.")
      for (const raw of result.tools) {
        const tool = toolOf(raw)
        if (!tool || names.has(tool.name)) continue
        if (tools.length >= TOOLS_READ_MAX) return { tools, more: true }
        names.add(tool.name)
        tools.push(tool)
      }
      cursor =
        typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) return { tools, more: false }
    }
    return { tools, more: true }
  },
  call: async (name, args, options) => {
    try {
      const result = await transport.request(
        "tools/call",
        { name, arguments: args },
        { signal: options.signal, timeoutMs: options.timeoutMs },
      )
      return { text: resultText(result), isError: isObject(result) && result.isError === true }
    } catch (error) {
      if (error instanceof McpError) throw new McpCallError(error.message)
      throw error
    }
  },
})

/** Opens a session: starts the program or reaches the address, and runs the first exchange. */
export const openMcp: McpOpener = async (spec, options) => {
  // The form checks the address, but a connection can come from an import or from an older
  // version: the client checks again, so an address that breaks the rules is never reached.
  if (spec.kind === "web" && checkConnectionAddress(spec.url) !== null)
    throw new McpError("refused", "The address is not allowed.")
  const transport = spec.kind === "program" ? startProgram(spec) : startWeb(spec)
  const abort = () => transport.close()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    let result: unknown
    try {
      result = await transport.request(
        "initialize",
        {
          protocolVersion: MCP_VERSIONS[0],
          capabilities: {},
          clientInfo: { name: "ROBot", version: "1" },
        },
        { timeoutMs: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
      )
    } catch (error) {
      if (error instanceof McpCallStopped)
        throw new McpError("timeout", "The connection did not answer in time.")
      if (error instanceof McpCallError) throw new McpError("invalid", error.message)
      throw error
    }
    if (!isObject(result) || typeof result.protocolVersion !== "string")
      throw new McpError("invalid", "The first answer is not valid.")
    if (!(MCP_VERSIONS as readonly string[]).includes(result.protocolVersion))
      throw new McpError("invalid", "The protocol version is not known.")
    transport.setVersion?.(result.protocolVersion)
    transport.notify("notifications/initialized")
    return sessionOf(transport)
  } catch (error) {
    transport.close()
    throw error
  } finally {
    options.signal?.removeEventListener("abort", abort)
  }
}

/** The tools that an agent gets: at most 100 of one connection (spec 018, "Rules"). */
export const limitTools = <T>(tools: readonly T[]): { tools: T[]; tooMany: boolean } => ({
  tools: tools.slice(0, CONNECTION_TOOLS_MAX),
  tooMany: tools.length > CONNECTION_TOOLS_MAX,
})
