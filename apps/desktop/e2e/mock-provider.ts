import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export const GOOD_KEY = "sk-mock-good-0123456789"

export interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined)
      } catch {
        resolve(data)
      }
    })
  })

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/**
 * A local model provider for end-to-end tests. It speaks the OpenAI-compatible API under
 * `/v1` and the Anthropic API under `/anthropic/v1`.
 */
export const startMockProvider = async () => {
  const requests: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const body = await readBody(req)
    requests.push({ method: req.method ?? "GET", path: url.pathname, body })
    const anthropic = url.pathname.startsWith("/anthropic/")
    const key = anthropic
      ? req.headers["x-api-key"]
      : req.headers.authorization?.replace(/^Bearer /, "")
    if (key !== GOOD_KEY) return json(res, 401, { error: { message: "invalid api key" } })

    if (url.pathname === "/v1/models") {
      return json(res, 200, { data: [{ id: "mock-fast" }, { id: "o3-mini" }] })
    }
    if (url.pathname === "/anthropic/v1/models") {
      return json(res, 200, {
        data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" }],
      })
    }
    json(res, 404, { error: { message: "not found" } })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    anthropicUrl: `http://127.0.0.1:${port}/anthropic`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
