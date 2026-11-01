import {
  type Connection,
  failureFrom,
  headersFor,
  ProviderFailure,
  request,
  urlFor,
} from "./client.ts"
import { readSse } from "./sse.ts"

export interface ToolCall {
  readonly id: string
  readonly name: string
  /** The arguments as a JSON text. */
  readonly input: string
}

/** What a model may call. `schema` is a JSON schema of the arguments. */
export interface ToolDef {
  readonly name: string
  readonly description: string
  readonly schema: Record<string, unknown>
}

export type Turn =
  | {
      readonly role: "user" | "assistant"
      readonly content: string
      readonly toolCalls?: readonly ToolCall[]
    }
  | {
      readonly role: "tool"
      readonly callId: string
      readonly name: string
      readonly content: string
    }

export interface ChatRequest {
  readonly connection: Connection
  readonly model: string
  readonly effort: string | null
  readonly system: string
  readonly turns: readonly Turn[]
  readonly tools?: readonly ToolDef[]
  readonly signal: AbortSignal
}

/** What a provider stream gives, one piece at a time. */
export type StreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "usage"; readonly input?: number; readonly output?: number }
  /** The model wants to call a tool. */
  | ({ readonly type: "toolcall" } & ToolCall)

/**
 * Joins neighbouring text turns of one role, and drops empty ones. Both APIs need roles to
 * alternate. Turns with tool calls or tool results stay as they are.
 */
export const normaliseTurns = (turns: readonly Turn[]): Turn[] => {
  const out: Turn[] = []
  for (const turn of turns) {
    if (turn.role === "tool" || turn.toolCalls?.length) {
      out.push(turn)
      continue
    }
    if (!turn.content.trim()) continue
    const last = out.at(-1)
    if (last && last.role !== "tool" && last.role === turn.role && !last.toolCalls?.length)
      out[out.length - 1] = { role: turn.role, content: `${last.content}\n\n${turn.content}` }
    else out.push(turn)
  }
  while (out[0]?.role === "assistant") out.shift()
  return out
}

const parseJson = (text: string): unknown => {
  try {
    return text.trim() ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

const openAiMessages = (turns: readonly Turn[]) =>
  turns.map((t) => {
    if (t.role === "tool") return { role: "tool", tool_call_id: t.callId, content: t.content }
    if (t.role === "assistant" && t.toolCalls?.length)
      return {
        role: "assistant",
        content: t.content || null,
        tool_calls: t.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.input },
        })),
      }
    return { role: t.role, content: t.content }
  })

/** Anthropic wants tool results as blocks of one user turn. */
const anthropicMessages = (turns: readonly Turn[]) => {
  const out: { role: string; content: unknown }[] = []
  for (const t of turns) {
    if (t.role === "tool") {
      const block = { type: "tool_result", tool_use_id: t.callId, content: t.content }
      const last = out.at(-1)
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content[0]?.type === "tool_result"
      )
        last.content.push(block)
      else out.push({ role: "user", content: [block] })
    } else if (t.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: [
          ...(t.content ? [{ type: "text", text: t.content }] : []),
          ...t.toolCalls.map((c) => ({
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: parseJson(c.input),
          })),
        ],
      })
    } else out.push({ role: t.role, content: t.content })
  }
  return out
}

const thinkingBudget: Record<string, number> = { low: 2048, medium: 8192, high: 24576 }
const OUTPUT_TOKENS = 8192

const post = async (req: ChatRequest, body: unknown) => {
  const response = await request(
    urlFor(req.connection, "chat"),
    {
      method: "POST",
      headers: {
        ...headersFor(req.connection),
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    },
    req.signal,
  )
  if (!response.ok) throw await failureFrom(response)
  if (!response.body) throw new ProviderFailure("provider_error", "empty response")
  return response.body
}

async function* openAiStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const messages = [
    ...(req.system.trim() ? [{ role: "system", content: req.system }] : []),
    ...openAiMessages(normaliseTurns(req.turns)),
  ]
  const body = await post(req, {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.schema },
          })),
        }
      : {}),
    ...(req.effort ? { reasoning_effort: req.effort } : {}),
  })
  const calls = new Map<number, { id: string; name: string; input: string }>()
  const flush = function* (): Generator<StreamEvent> {
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0]))
      if (c.name) yield { type: "toolcall", ...c }
    calls.clear()
  }
  for await (const event of readSse(body)) {
    if (event.data === "[DONE]") {
      yield* flush()
      return
    }
    const chunk = JSON.parse(event.data) as {
      choices?: {
        delta?: {
          content?: string | null
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: {
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }[]
        }
      }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null
      error?: { message?: string }
    }
    if (chunk.error)
      throw new ProviderFailure("provider_error", chunk.error.message ?? "stream error")
    const delta = chunk.choices?.[0]?.delta
    const thinking = delta?.reasoning_content ?? delta?.reasoning
    if (thinking) yield { type: "thinking", text: thinking }
    if (delta?.content) yield { type: "text", text: delta.content }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0
      const current = calls.get(index) ?? { id: "", name: "", input: "" }
      calls.set(index, {
        id: call.id ?? current.id,
        name: call.function?.name ?? current.name,
        input: current.input + (call.function?.arguments ?? ""),
      })
    }
    if (chunk.usage) {
      yield {
        type: "usage",
        ...(chunk.usage.prompt_tokens !== undefined ? { input: chunk.usage.prompt_tokens } : {}),
        ...(chunk.usage.completion_tokens !== undefined
          ? { output: chunk.usage.completion_tokens }
          : {}),
      }
    }
  }
  yield* flush()
}

async function* anthropicStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const budget = req.effort ? thinkingBudget[req.effort] : undefined
  const body = await post(req, {
    model: req.model,
    max_tokens: OUTPUT_TOKENS + (budget ?? 0),
    stream: true,
    ...(req.system.trim() ? { system: req.system } : {}),
    messages: anthropicMessages(normaliseTurns(req.turns)),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.schema,
          })),
        }
      : {}),
    ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
  })
  const blocks = new Map<number, { id: string; name: string; input: string }>()
  for await (const event of readSse(body)) {
    const data = JSON.parse(event.data) as {
      type: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string }
      message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
      usage?: { output_tokens?: number }
      error?: { type?: string; message?: string }
    }
    switch (data.type) {
      case "message_start":
        if (data.message?.usage?.input_tokens !== undefined) {
          yield { type: "usage", input: data.message.usage.input_tokens }
        }
        break
      case "content_block_start":
        if (data.content_block?.type === "tool_use")
          blocks.set(data.index ?? 0, {
            id: data.content_block.id ?? "",
            name: data.content_block.name ?? "",
            input: "",
          })
        break
      case "content_block_stop": {
        const block = blocks.get(data.index ?? 0)
        if (block) {
          blocks.delete(data.index ?? 0)
          yield { type: "toolcall", ...block }
        }
        break
      }
      case "content_block_delta":
        if (data.delta?.type === "input_json_delta") {
          const block = blocks.get(data.index ?? 0)
          if (block) block.input += data.delta.partial_json ?? ""
        }
        if (data.delta?.type === "text_delta" && data.delta.text)
          yield { type: "text", text: data.delta.text }
        if (data.delta?.type === "thinking_delta" && data.delta.thinking) {
          yield { type: "thinking", text: data.delta.thinking }
        }
        break
      case "message_delta":
        if (data.usage?.output_tokens !== undefined)
          yield { type: "usage", output: data.usage.output_tokens }
        break
      case "error":
        throw new ProviderFailure(
          data.error?.type === "rate_limit_error" ? "provider_limit" : "provider_error",
          data.error?.message ?? "stream error",
        )
      case "message_stop":
        return
    }
  }
}

/** Streams one reply from the provider of the connection. */
export const streamChat = (req: ChatRequest): AsyncGenerator<StreamEvent> =>
  req.connection.kind === "anthropic" ? anthropicStream(req) : openAiStream(req)
