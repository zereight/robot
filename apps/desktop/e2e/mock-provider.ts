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
  tools?: { function?: { name?: string } }[]
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

/** Parts of the stream "stream parts": one every 50 ms for 10 seconds (docs/performance.md). */
export const STREAM_PARTS = 200
export const streamPart = (i: number) => `p${String(i).padStart(3, "0")} `

interface Plan {
  readonly chunks?: readonly string[]
  readonly delay?: number
  readonly thinking?: string
  readonly status?: number
  /** A wait before the first part, in ms: "pause 2000ms" in the message. */
  readonly pause?: number
}

/** What the mock answers depends on the last user message. "pause <n>ms" waits before it answers. */
const plan = (body: ChatBody): Plan => {
  const text =
    String(body.messages.at(-1)?.content ?? "")
      .split("\n")
      .at(-1) ?? ""
  const pause = Number(/pause (\d+)ms/.exec(text)?.[1] ?? 0)
  return { ...answer(body), pause }
}

const answer = (body: ChatBody): Plan => {
  const last = body.messages.at(-1)?.content ?? ""
  const text = last.split("\n").at(-1) ?? ""
  // "Teach a task": the model writes a draft skill from the steps. A result that holds "fail
  // draft" fails once, so the card shows "Try again".
  if (text === "Reply with the JSON object only.") {
    if (last.includes("fail draft") && !failedOnce.has(last)) {
      failedOnce.add(last)
      return { status: 500 }
    }
    return {
      chunks: [
        JSON.stringify({
          name: "Greet on the test page",
          description: "When the user wants the test page to say hello",
          instructions:
            "1. Open the test page.\n2. Press the button.\n3. Type hello into Name.\n4. Ask the user for the password.\nAt the end, check that the page says hello.",
        }),
      ],
      delay: 0,
    }
  }
  // A condition in the mode "Ask a model": the model answers yes when the text holds "Hello".
  if (text === "Reply with yes or no only.")
    return { chunks: [last.includes("Hello") ? "Yes" : "No"], delay: 0 }
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
  // A lead gives one part to Bo, who then works for a long time.
  if (text.includes("split hold"))
    return {
      chunks: [
        JSON.stringify({
          plan: "One part that runs long",
          parts: [{ member: "Bo", label: "Hold the line", prompt: "run long" }],
        }),
      ],
      delay: 0,
    }
  // "Check knowledge": the agent reports what the app found, line by line.
  if (last.includes("The app found this:")) {
    // What the app found is the lines up to the request that follows them.
    const found = last.split("The app found this:")[1]?.split("\n\n")[0]?.trim() ?? ""
    return { chunks: [`Report of the check:\n${found}`], delay: 0 }
  }
  // Work that lasts about 30 seconds, for tests that look at agents while they work.
  if (text.includes("run long"))
    return { chunks: Array.from({ length: 600 }, (_, i) => `w${i} `), delay: 50 }
  if (text.includes("slow"))
    return { chunks: Array.from({ length: 60 }, (_, i) => `word${i} `), delay: 50 }
  if (text.includes("markdown")) return { chunks: [MARKDOWN_REPLY], delay: 0 }
  if (text.includes("stream parts"))
    return { chunks: Array.from({ length: STREAM_PARTS }, (_, i) => streamPart(i)), delay: 50 }
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

/**
 * "TOOL name {json}" in the last user message makes the model call that tool once.
 * "TOOLS [{"name": "...", "args": {...}}, ...]" makes it call several tools in one reply.
 */
const toolCalls = (body: ChatBody) => {
  const last = body.messages.at(-1)
  if (!body.tools || last?.role !== "user") return []
  const many = [...last.content.matchAll(/TOOLS (\[.*\])/g)].at(-1)
  if (many) {
    return (JSON.parse(many[1] as string) as { name: string; args: unknown }[]).map((c) => ({
      name: c.name,
      args: JSON.stringify(c.args),
    }))
  }
  // Turns without an answer are merged, so the last request in the text counts.
  const match = [...last.content.matchAll(/TOOL (\w+) (\{.*\})/g)].at(-1)
  if (match) return [{ name: match[1] as string, args: match[2] as string }]
  return knowledgeRead(body)
}

const wordsOf = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 5),
  )

/**
 * A model that reads the contents list in its instructions: when the question shares a word
 * with a line of the list, it opens that article.
 */
const knowledgeRead = (body: ChatBody) => {
  if (!body.tools?.some((t) => t.function?.name === "read_article")) return []
  const system = String(body.messages[0]?.content ?? "")
  const list = system.split("Contents (title: summary):\n")[1]
  const last = body.messages.at(-1)?.content ?? ""
  if (!list || last.includes("Check knowledge.")) return []
  const asked = wordsOf(last.split("\n").at(-1) ?? "")
  for (const line of list.split("\n")) {
    const match = /^- (.+?): (.*)$/.exec(line)
    if (!match) continue
    const known = wordsOf(`${match[1]} ${match[2]}`)
    if ([...asked].some((w) => known.has(w)))
      return [{ name: "read_article", args: JSON.stringify({ title: match[1] }) }]
  }
  return []
}

/** When each text part was sent, for the performance report. */
export interface SentPart {
  readonly text: string
  readonly at: number
}

const openAiReply = async (res: ServerResponse, body: ChatBody, sent: SentPart[]) => {
  const calls = toolCalls(body)
  if (calls.length > 0) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const [index, call] of calls.entries()) {
      const first = { index, id: `call_${index + 1}`, function: { name: call.name, arguments: "" } }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [first] } }] })}\n\n`)
      const rest = { index, function: { arguments: call.args } }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [rest] } }] })}\n\n`)
    }
    return res.end("data: [DONE]\n\n")
  }
  const finished = body.messages.at(-1)
  if (finished?.role === "tool") {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const output = String(finished.content)
    // An article that was read: the reply uses its text.
    const article = output.startsWith("Title: ") ? output.split("\n\n").slice(1).join("\n\n") : ""
    // An answer of the tool "search chats": the reply uses the quotes that it found.
    const quotes = output.startsWith("Found ") ? output.split("\n").slice(2).join(" | ") : ""
    const text = article
      ? `According to my article: ${article.slice(0, 300)}`
      : quotes
        ? `From the past chats: ${quotes.slice(0, 400)}`
        : `Tool said: ${output.slice(0, 80)}`
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
  if (p.pause) await sleep(p.pause)
  if (p.thinking) send({ choices: [{ delta: { reasoning_content: p.thinking } }] })
  for (const chunk of p.chunks ?? []) {
    if (res.destroyed) return
    send({ choices: [{ delta: { content: chunk } }] })
    sent.push({ text: chunk, at: Date.now() })
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
  if (p.pause) await sleep(p.pause)
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
    // The real stream closes a thinking block with its signature.
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "mock-signature" },
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
  const sent: SentPart[] = []
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
      // As the real list does: a model says which effort levels it takes.
      const level = { supported: true }
      return json(res, 200, {
        data: [
          {
            id: "claude-haiku-5-5",
            display_name: "Claude Haiku 5.5",
            capabilities: {
              effort: {
                supported: true,
                low: level,
                medium: level,
                high: level,
                xhigh: level,
                max: level,
              },
            },
          },
          // An older model: no effort setting, but it thinks with a budget.
          {
            id: "claude-sonnet-4-5",
            display_name: "Claude Sonnet 4.5",
            capabilities: { effort: { supported: false } },
          },
          // An old model that does not think at all.
          {
            id: "claude-3-5-haiku-latest",
            display_name: "Claude Haiku 3.5",
            capabilities: { effort: { supported: false } },
          },
        ],
      })
    }
    if (url.pathname === "/v1/chat/completions") return openAiReply(res, body as ChatBody, sent)
    if (url.pathname === "/anthropic/v1/messages") return anthropicReply(res, body as ChatBody)
    json(res, 404, { error: { message: "not found" } })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    anthropicUrl: `http://127.0.0.1:${port}/anthropic`,
    requests,
    sent,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
