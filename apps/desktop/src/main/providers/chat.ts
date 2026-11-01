import {
  type Connection,
  failureFrom,
  headersFor,
  ProviderFailure,
  request,
  urlFor,
} from "./client.ts"
import { readSse } from "./sse.ts"

export interface Turn {
  readonly role: "user" | "assistant"
  readonly content: string
}

export interface ChatRequest {
  readonly connection: Connection
  readonly model: string
  readonly effort: string | null
  readonly system: string
  readonly turns: readonly Turn[]
  readonly signal: AbortSignal
}

/** What a provider stream gives, one piece at a time. */
export type StreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "usage"; readonly input?: number; readonly output?: number }

/** Joins neighbouring turns of one role, and drops empty turns. Both APIs need roles to alternate. */
export const normaliseTurns = (turns: readonly Turn[]): Turn[] => {
  const out: Turn[] = []
  for (const turn of turns) {
    if (!turn.content.trim()) continue
    const last = out.at(-1)
    if (last && last.role === turn.role)
      out[out.length - 1] = { role: turn.role, content: `${last.content}\n\n${turn.content}` }
    else out.push(turn)
  }
  while (out[0]?.role === "assistant") out.shift()
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
    ...normaliseTurns(req.turns),
  ]
  const body = await post(req, {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(req.effort ? { reasoning_effort: req.effort } : {}),
  })
  for await (const event of readSse(body)) {
    if (event.data === "[DONE]") return
    const chunk = JSON.parse(event.data) as {
      choices?: {
        delta?: {
          content?: string | null
          reasoning_content?: string | null
          reasoning?: string | null
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
}

async function* anthropicStream(req: ChatRequest): AsyncGenerator<StreamEvent> {
  const budget = req.effort ? thinkingBudget[req.effort] : undefined
  const body = await post(req, {
    model: req.model,
    max_tokens: OUTPUT_TOKENS + (budget ?? 0),
    stream: true,
    ...(req.system.trim() ? { system: req.system } : {}),
    messages: normaliseTurns(req.turns),
    ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
  })
  for await (const event of readSse(body)) {
    const data = JSON.parse(event.data) as {
      type: string
      message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      delta?: { type?: string; text?: string; thinking?: string }
      usage?: { output_tokens?: number }
      error?: { type?: string; message?: string }
    }
    switch (data.type) {
      case "message_start":
        if (data.message?.usage?.input_tokens !== undefined) {
          yield { type: "usage", input: data.message.usage.input_tokens }
        }
        break
      case "content_block_delta":
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
