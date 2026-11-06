import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/** The key that the stand-in provider accepts. A test sends nothing to a real model account. */
export const GOOD_KEY = "sk-mock-good-0123456789"

export interface RecordedRequest {
  readonly path: string
  readonly body: {
    readonly model?: string
    readonly messages: { role: string; content: unknown }[]
    readonly tools?: { function: { name: string } }[]
  }
}

export interface MockProvider {
  /** The base URL of the OpenAI-compatible API (it ends with `/v1`). */
  readonly openaiUrl: string
  /** Every chat request that the app sent, in order. */
  readonly requests: RecordedRequest[]
  close(): Promise<void>
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => resolve(data))
  })

const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : ""))
          .join("")
      : ""

/**
 * A stand-in for an OpenAI-compatible provider. What it answers depends on the last message:
 * - `slow`: 60 words, one every 50 ms, so a test can stop the reply;
 * - `tool <name> <json>`: one call of that tool; after the tool result it says "Tool said: ...";
 * - anything else: "You said: <message>".
 */
export const startMockProvider = async (): Promise<MockProvider> => {
  const requests: RecordedRequest[] = []
  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "bad key" } }))
      return
    }
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "mock-fast" }, { id: "gpt-5" }] }))
      return
    }
    if (req.url?.endsWith("/chat/completions")) {
      const body = JSON.parse(await readBody(req)) as RecordedRequest["body"]
      requests.push({ path: req.url, body })
      const last = body.messages.at(-1)
      const said = text(last?.content)
      res.writeHead(200, { "content-type": "text/event-stream" })
      const send = (delta: object) =>
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      const finish = () => {
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
        )
        res.write("data: [DONE]\n\n")
        res.end()
      }
      if (last?.role === "tool") {
        send({ content: `Tool said: ${said}` })
        finish()
        return
      }
      const tool = /^tool (\w+)\s*(.*)$/s.exec(said)
      if (tool) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              function: { name: tool[1], arguments: tool[2] || "{}" },
            },
          ],
        })
        finish()
        return
      }
      if (said.includes("slow")) {
        let closed = false
        res.on("close", () => {
          closed = true
        })
        for (let i = 1; i <= 60 && !closed; i++) {
          send({ content: `word${i} ` })
          await new Promise((r) => setTimeout(r, 50))
        }
        if (!closed) finish()
        return
      }
      send({ content: `You said: ${said}` })
      finish()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
