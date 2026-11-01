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

interface ChatBody {
  messages: { role: string; content: string }[]
  tools?: unknown[]
}

export const MARKDOWN_REPLY = [
  "## Plan",
  "",
  "- first step",
  "- second step",
  "",
  "```ts",
  "const answer = 42",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "See [the docs](https://example.com/docs) and <b>raw html</b>.",
].join("\n")

const failedOnce = new Set<string>()

/** What the mock answers depends on the last user message. */
const plan = (body: ChatBody) => {
  const last = body.messages.at(-1)?.content ?? ""
  const text = last.split("\n").at(-1) ?? ""
  // A lead that splits a job answers with a plan. The members are Bo and Cy.
  if (text.includes("split two"))
    return {
      chunks: [
        JSON.stringify({
          plan: "Two parts",
          parts: [
            { member: "Bo", label: "Write the intro", prompt: "Write the intro" },
            { member: "Cy", label: "Check the facts", prompt: "Check the facts" },
          ],
        }),
      ],
      delay: 0,
    }
  if (text.includes("split long"))
    return {
      chunks: [
        JSON.stringify({
          plan: "One long part",
          parts: [{ member: "Bo", label: "Long work", prompt: "go slow on the long work" }],
        }),
      ],
      delay: 0,
    }
  if (text.includes("slow"))
    return { chunks: Array.from({ length: 60 }, (_, i) => `word${i} `), delay: 50 }
  if (text.includes("markdown")) return { chunks: [MARKDOWN_REPLY], delay: 0 }
  if (text.includes("think"))
    return { thinking: "Weighing the options.", chunks: ["Decided."], delay: 0 }
  if (text.includes("fail once") && !failedOnce.has(text)) {
    failedOnce.add(text)
    return { status: 500 }
  }
  if (text.includes("limit")) return { status: 429 }
  return { chunks: ["Hello! ", "You said: ", text], delay: 30 }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** "TOOL name {json}" in the last user message makes the model call that tool once. */
const toolCall = (body: ChatBody) => {
  const last = body.messages.at(-1)
  if (!body.tools || last?.role !== "user") return null
  // Turns without an answer are merged, so the last request in the text counts.
  const match = [...last.content.matchAll(/TOOL (\w+) (\{.*\})/g)].at(-1)
  return match ? { name: match[1] as string, args: match[2] as string } : null
}

const openAiReply = async (res: ServerResponse, body: ChatBody) => {
  const call = toolCall(body)
  if (call) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const first = { index: 0, id: "call_1", function: { name: call.name, arguments: "" } }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [first] } }] })}\n\n`)
    const rest = { index: 0, function: { arguments: call.args } }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [rest] } }] })}\n\n`)
    return res.end("data: [DONE]\n\n")
  }
  const finished = body.messages.at(-1)
  if (finished?.role === "tool") {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const text = `Tool said: ${String(finished.content).slice(0, 80)}`
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    return res.end("data: [DONE]\n\n")
  }
  const p = plan(body)
  if (p.status === 429) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "120" })
    return res.end(JSON.stringify({ error: { message: "rate limited" } }))
  }
  if (p.status) return json(res, p.status, { error: { message: "mock server error" } })
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  if (p.thinking) send({ choices: [{ delta: { reasoning_content: p.thinking } }] })
  for (const chunk of p.chunks ?? []) {
    if (res.destroyed) return
    send({ choices: [{ delta: { content: chunk } }] })
    if (p.delay) await sleep(p.delay)
  }
  send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } })
  res.end("data: [DONE]\n\n")
}

const anthropicReply = async (res: ServerResponse, body: ChatBody) => {
  const p = plan(body)
  if (p.status)
    return json(res, p.status === 429 ? 429 : 500, {
      type: "error",
      error: { message: "mock error" },
    })
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send("message_start", { type: "message_start", message: { usage: { input_tokens: 20 } } })
  if (p.thinking) {
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    })
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: p.thinking },
    })
    send("content_block_stop", { type: "content_block_stop", index: 0 })
  }
  for (const chunk of p.chunks ?? []) {
    if (res.destroyed) return
    send("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: chunk },
    })
    if (p.delay) await sleep(p.delay)
  }
  send("message_delta", { type: "message_delta", usage: { output_tokens: 10 } })
  send("message_stop", { type: "message_stop" })
  res.end()
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
    if (url.pathname === "/v1/chat/completions") return openAiReply(res, body as ChatBody)
    if (url.pathname === "/anthropic/v1/messages") return anthropicReply(res, body as ChatBody)
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
