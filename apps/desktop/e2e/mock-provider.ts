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
  /** The cache marker of an Anthropic request. */
  cache_control?: unknown
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
  const planned = answer(body)
  return { ...planned, pause: planned.pause ?? pause }
}

const answer = (body: ChatBody): Plan => {
  const last = body.messages.at(-1)?.content ?? ""
  const text = last.split("\n").at(-1) ?? ""
  // "Make a skill" from work (spec 017): the system text says so. The draft depends on the work.
  // "FAILDRAFT" in the work fails the first request for that work; "SLOWDRAFT" answers late.
  if (String(body.messages[0]?.content ?? "").includes("You write a reusable skill from work")) {
    if (last.includes("FAILDRAFT") && !failedOnce.has(last)) {
      failedOnce.add(last)
      return { status: 500 }
    }
    const [name, description] = last.includes("an article that an agent wrote")
      ? ["Release steps", "When the user wants to ship a release"]
      : last.includes("a fact that an agent keeps")
        ? ["Linter first", "When the user wants to commit code"]
        : ["Weekly report", "When the user wants the weekly report"]
    return {
      chunks: [
        JSON.stringify({
          name,
          description,
          instructions: `1. Do the work of ${name}.\n2. Check the result.\nAsk the user before you delete anything.`,
        }),
      ],
      delay: 0,
      pause: last.includes("SLOWDRAFT") ? 2500 : 0,
    }
  }
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
  // The check of a lead (spec 004): the system text says that the work has stopped.
  if (String(body.messages[0]?.content ?? "").includes("The work in the channel has stopped"))
    return { chunks: [checkAnswer(last)], delay: 0 }
  // A lead that splits a job into two parts with a done test each. The members are Bo and Cy.
  if (text.includes("split verdicts") || text.includes("split stubborn"))
    return {
      chunks: [
        JSON.stringify({
          plan: "Two parts, each with a done test",
          parts: [
            {
              member: "Bo",
              label: "Draft the intro",
              prompt: "Draft the intro",
              doneTest: "The intro has a title",
            },
            {
              member: "Cy",
              label: "List the facts",
              prompt: "List the facts HALFREPLY",
              doneTest: "Lists five facts",
            },
          ],
        }),
      ],
      delay: 0,
    }
  // A member who does half of the work.
  if (text.includes("HALFREPLY")) return { chunks: ["Only two of the five facts."], delay: 0 }
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
  // A lead gives one part to Bo, who does it, and one to Cy, who cannot do it (spec 005, Blocked).
  if (text.includes("split review"))
    return {
      chunks: [
        JSON.stringify({
          plan: "Two parts, and one that cannot be done",
          parts: [
            {
              member: "Bo",
              label: "Write the introduction for the first release",
              prompt: "Write the introduction for the first release",
            },
            { member: "Cy", label: "Check the facts", prompt: "BLOCKEDPART check the facts" },
          ],
        }),
      ],
      delay: 0,
    }
  // A member who cannot do the work ends the reply with a last line that starts with "Blocked:".
  if (text.includes("BLOCKEDPART"))
    return { chunks: ["I looked at it.\n", "Blocked: no access to the repository"], delay: 0 }
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
  // The word "limit" asks for a rate limit, unless it only quotes the reply of another agent.
  if (text.includes("limit") && !last.startsWith("Reply from the agent")) return { status: 429 }
  return { chunks: ["Hello! ", "You said: ", text], delay: 30 }
}

/**
 * A stand-in lead for the check of a channel. It reads the parts to judge: a reply that says
 * "Only two" is Not met, any other reply is Met. With two parts it nudges the first part that is
 * Not met. With more parts it asks one question when the job is "stubborn", else it does nothing.
 */
const checkAnswer = (state: string) => {
  const judged = state.split("Parts to judge:\n")[1]?.split("\n\nGive your check")[0] ?? ""
  const verdicts: { part: number; verdict: string; reason?: string }[] = []
  for (const block of judged.split(/\n\n(?=Part \d+:)/)) {
    const match =
      /^Part (\d+): [^\n]*\nDone test: [^\n]*\nEnd of the last reply of [^\n]*:\n([\s\S]*)$/.exec(
        block.trim(),
      )
    if (!match) continue
    const part = Number(match[1])
    verdicts.push(
      match[2]?.includes("Only two")
        ? { part, verdict: "not_met", reason: "Only two of the five facts are listed." }
        : { part, verdict: "met" },
    )
  }
  const partLines = (state.split("Parts:\n")[1]?.split("\n\n")[0] ?? "").split("\n").length
  const notMet = verdicts.find((v) => v.verdict === "not_met")
  if (notMet && partLines <= 2)
    return JSON.stringify({
      verdicts,
      action: "nudge",
      part: notMet.part,
      instruction: `Finish the list of five facts.${state.includes("stubborn") ? " HALFREPLY" : ""}`,
    })
  if (notMet && state.includes("stubborn"))
    return JSON.stringify({
      verdicts,
      action: "ask",
      question: "Which five facts do you want?",
    })
  return JSON.stringify({ verdicts, action: "nothing" })
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
  const long = longWork(body)
  if (long.length > 0) return long
  return knowledgeRead(body)
}

const usersOf = (body: ChatBody) =>
  body.messages.filter((m) => m.role === "user").map((m) => String(m.content))

/** A call id that no other call has, so that each call of a long task has its own card. */
let loopCalls = 0

/**
 * Words in the user messages make the model act in a long way:
 *   "ENDLESS"           calls a tool after every result, without end
 *   "PINGPONG with Bo"  sends a message to Bo; a message "from the agent X" that holds PINGPONG
 *                       is answered with a message to X, without end
 *   "FAILTOOL"          the request after the first tool result fails once for this text
 */
const longWork = (body: ChatBody) => {
  const last = body.messages.at(-1)
  if (!body.tools || last?.role !== "user") return []
  const text = String(last.content)
  if (text.includes("ENDLESS")) return [{ name: "list_files", args: "{}" }]
  if (text.includes("PINGPONG") && body.tools.some((t) => t.function?.name === "send_message")) {
    const to = /from the agent (\w+)/.exec(text)?.[1] ?? /PINGPONG with (\w+)/.exec(text)?.[1]
    if (to) return [{ name: "send_message", args: JSON.stringify({ to, text: "PINGPONG" }) }]
  }
  return []
}

const failedAfterTool = new Set<string>()

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

/** The context size of "mock-fast". "fill context" in a message reports 91 percent of it as used. */
export const CONTEXT_SIZE = 100_000
/** "use N" at the end of a message reports a use of N tokens in all. */
const usageOf = (body: ChatBody) => {
  const line = (body.messages.at(-1)?.content ?? "").split("\n").at(-1) ?? ""
  const use = /use (\d+)$/.exec(line)?.[1]
  if (use) return { prompt_tokens: Number(use) - 10, completion_tokens: 10 }
  return line.includes("fill context")
    ? { prompt_tokens: 90_000, completion_tokens: 1_000 }
    : { prompt_tokens: 20, completion_tokens: 10 }
}

/**
 * A request for the summary of a compact (spec 003). The answer is "Summary of N messages". When a
 * message of the chat holds "summary fails", it fails. "long summary" makes it take 2 seconds, so
 * that a test can see "Compacting…".
 */
const summaryReply = async (res: ServerResponse, body: ChatBody) => {
  const chat = body.messages.filter((m) => m.role !== "system")
  const text = chat.map((m) => String(m.content)).join("\n")
  if (text.includes("summary fails"))
    return json(res, 400, { error: { message: "mock bad request" } })
  if (text.includes("long summary")) await sleep(2000)
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  send({ choices: [{ delta: { content: `Summary of ${chat.length - 1} messages` } }] })
  send({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 8 } })
  res.end("data: [DONE]\n\n")
}

const openAiReply = async (
  res: ServerResponse,
  body: ChatBody,
  sent: SentPart[],
  dropped: string[],
) => {
  if (String(body.messages[0]?.content ?? "").startsWith("You write the summary"))
    return summaryReply(res, body)
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
    const users = usersOf(body)
    // The request of this turn is the last message of the user.
    const lastAsk = users.at(-1) ?? ""
    // A task that never ends: some text, then the next call, with an id of its own.
    if (lastAsk.includes("ENDLESS")) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      const id = `loop_${++loopCalls}`
      const first = { index: 0, id, function: { name: "list_files", arguments: "" } }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Working. " } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [first] } }] })}\n\n`)
      const rest = { index: 0, function: { arguments: "{}" } }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [rest] } }] })}\n\n`)
      return res.end("data: [DONE]\n\n")
    }
    // A model that fails after a tool step, once for each text.
    if (lastAsk.includes("FAILTOOL") && !failedAfterTool.has(lastAsk)) {
      failedAfterTool.add(lastAsk)
      return json(res, 500, { error: { message: "mock server error" } })
    }
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
  // "go silent": the answer opens and nothing follows, until the app closes the request.
  if ((body.messages.at(-1)?.content ?? "").split("\n").at(-1)?.includes("go silent")) {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()
    return
  }
  const p = plan(body)
  // A draft request that waits, and that the app closes: the app dropped it (spec 017).
  if (p.pause && String(body.messages[0]?.content ?? "").includes("You write a reusable skill")) {
    res.on("close", () => {
      if (!res.writableEnded) dropped.push(String(body.messages.at(-1)?.content ?? ""))
    })
  }
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
  send({ choices: [], usage: usageOf(body) })
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
  // As the real API does when the request has the cache marker: `input_tokens` leaves out the part
  // that is written to the cache and the part that is read from it. The three make 20 in all.
  send("message_start", {
    type: "message_start",
    message: {
      usage: body.cache_control
        ? { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 10 }
        : { input_tokens: 20 },
    },
  })
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
/**
 * `contextSize` is the size of the context of "mock-fast" (spec 003). It is 100000 when not given.
 * `lowHighModel` adds a Claude model to the Anthropic list that takes the levels Low and High only
 * (spec 002, 006). Without it, the list is as before.
 * `effortModels` gives the OpenAI list six models with dates, two of one family, and with effort
 * levels in their capabilities, among them "minimal" and "ultra" (spec 006, "Model list"). A test
 * adds a model between two fetches with `addModel`.
 */
export const startMockProvider = async (
  options: { contextSize?: number; lowHighModel?: boolean; effortModels?: boolean } = {},
) => {
  /** Models that a test added to the OpenAI list after the start. */
  const extraModels: Record<string, unknown>[] = []
  const requests: RecordedRequest[] = []
  const sent: SentPart[] = []
  /** The draft requests that the app closed before the answer came (spec 017). */
  const dropped: string[] = []
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
      if (options.effortModels) {
        // The levels go in the capabilities of each model, as in the Anthropic list.
        const lv = { supported: true }
        const levels = (...names: string[]) => ({
          effort: { supported: true, ...Object.fromEntries(names.map((n) => [n, lv])) },
        })
        return json(res, 200, {
          data: [
            { id: "mock-pro-1", created: 1_700_000_000, capabilities: levels("low", "high") },
            { id: "mock-pro-2", created: 1_710_000_000, capabilities: levels("low", "high") },
            { id: "mock-fast", created: 1_720_000_000 },
            { id: "o3-mini", created: 1_690_000_000 },
            {
              id: "mock-lite",
              created: 1_705_000_000,
              capabilities: levels("low", "medium", "high"),
            },
            {
              id: "mock-think",
              created: 1_715_000_000,
              capabilities: levels("minimal", "low", "medium", "high", "ultra"),
            },
            ...extraModels,
          ],
        })
      }
      // "mock-fast" tells the size of its context, for the context meter (spec 003).
      return json(res, 200, {
        data: [
          { id: "mock-fast", context_length: options.contextSize ?? CONTEXT_SIZE },
          { id: "o3-mini" },
          ...extraModels,
        ],
      })
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
          ...(options.lowHighModel
            ? [
                {
                  id: "claude-opus-5-low-high",
                  display_name: "Claude Opus Low High",
                  capabilities: { effort: { supported: true, low: level, high: level } },
                },
              ]
            : []),
        ],
      })
    }
    if (url.pathname === "/v1/chat/completions")
      return openAiReply(res, body as ChatBody, sent, dropped)
    if (url.pathname === "/anthropic/v1/messages") return anthropicReply(res, body as ChatBody)
    json(res, 404, { error: { message: "not found" } })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    anthropicUrl: `http://127.0.0.1:${port}/anthropic`,
    /** Adds a model to the OpenAI list. The app sees it at its next fetch. */
    addModel: (entry: Record<string, unknown>) => {
      extraModels.push(entry)
    },
    requests,
    sent,
    dropped,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // A request that is held with no answer would keep the server open.
        server.closeAllConnections()
      }),
  }
}
