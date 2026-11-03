#!/usr/bin/env node
// A small MCP server for tests of connections (spec 018). It is the "test program" that the spec
// names for its checks. It speaks JSON lines on its input and output, or "Streamable HTTP" when
// MCP_TEST_HTTP_PORT is set. What it offers is set by environment values, so a test can change it:
//   MCP_TEST_TOOLS        how many extra tools "tool_01", "tool_02", ... it offers (default 0)
//   MCP_TEST_DESCRIPTION  the description of the tool "echo"
//   MCP_TEST_CALLS        a file where each call is written as one JSON line
//   MCP_TEST_TOKEN        when set, the HTTP server needs "Authorization: Bearer <token>"
//   MCP_TEST_HTTP_PORT    serve HTTP on this port (on 127.0.0.1) instead of the input and output
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"
import { createInterface } from "node:readline"

const extra = Number(process.env.MCP_TEST_TOOLS || 0)
const tools = [
  {
    name: "echo",
    description: process.env.MCP_TEST_DESCRIPTION || "Gives the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "lookup",
    description: "Looks a word up. Only reads.",
    inputSchema: { type: "object", properties: { word: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "slow", description: "Never answers.", inputSchema: { type: "object", properties: {} } },
  {
    name: "big",
    description: "Gives 200000 characters.",
    inputSchema: { type: "object", properties: {} },
  },
  { name: "broken", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  {
    name: "show_env",
    description: "Gives the names and values of the environment values that start with TEST_.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "weather_now",
    description: "The weather of a city right now.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  },
]
for (let i = 1; i <= extra; i++)
  tools.push({
    name: `tool_${String(i).padStart(2, "0")}`,
    description: `Extra tool number ${i}.`,
    inputSchema: { type: "object", properties: {} },
  })

const log = (entry) => {
  if (process.env.MCP_TEST_CALLS)
    appendFileSync(process.env.MCP_TEST_CALLS, `${JSON.stringify(entry)}\n`)
}

/** The answer to one message, or null when none is due. A call of "slow" never answers. */
const answer = (message) => {
  const { id, method, params } = message
  if (id === undefined) return null
  const ok = (result) => ({ jsonrpc: "2.0", id, result })
  if (method === "initialize")
    return ok({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1" },
    })
  if (method === "ping") return ok({})
  if (method === "tools/list") return ok({ tools })
  if (method === "tools/call") {
    const name = params?.name
    const args = params?.arguments ?? {}
    log({ tool: name, args })
    if (name === "slow") return null
    if (name === "big") return ok({ content: [{ type: "text", text: "x".repeat(200000) }] })
    if (name === "broken")
      return ok({ isError: true, content: [{ type: "text", text: "It failed on purpose." }] })
    if (name === "show_env")
      return ok({
        content: [
          {
            type: "text",
            text: Object.entries(process.env)
              .filter(([k]) => k.startsWith("TEST_"))
              .map(([k, v]) => `${k}=${v}`)
              .join("\n"),
          },
        ],
      })
    if (name === "lookup") return ok({ content: [{ type: "text", text: `Found ${args.word}` }] })
    return ok({ content: [{ type: "text", text: `Echo: ${args.text ?? ""}` }] })
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }
}

const port = process.env.MCP_TEST_HTTP_PORT
if (port) {
  const token = process.env.MCP_TEST_TOKEN
  createServer((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(200).end()
      return
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end("sign in")
      return
    }
    if (req.url === "/moved") {
      res.writeHead(302, { location: "http://example.com/elsewhere" }).end()
      return
    }
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", () => {
      const message = JSON.parse(body || "{}")
      const out = answer(message)
      if (!out) {
        // A notification, or the call that never answers.
        if (message.id === undefined) res.writeHead(202).end()
        return
      }
      // A tool call answers as a stream of events, as a server may; the rest answers in JSON.
      if (message.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" })
        res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`)
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" })
      res.end(JSON.stringify(out))
    })
  }).listen(Number(port), "127.0.0.1")
} else {
  const lines = createInterface({ input: process.stdin })
  lines.on("line", (line) => {
    if (!line.trim()) return
    const out = answer(JSON.parse(line))
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`)
  })
  lines.on("close", () => process.exit(0))
}
