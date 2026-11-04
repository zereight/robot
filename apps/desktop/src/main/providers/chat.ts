import { takesAdaptiveThinking, takesThinkingBudget } from "@robot/shared"
import { type CacheLifetime, type CacheMarker, cacheMarker } from "./cache.ts"
import {
  type Connection,
  failureFrom,
  headersFor,
  limitFailure,
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

/**
 * One block of an Anthropic reply, as the model made it. A reply with thinking must go back to the
 * model block by block, in the same order and without a change, when it called a tool.
 */
export type ReplyBlock =
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string }
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "tool_use" } & ToolCall)

export type Turn =
  | {
      readonly role: "user" | "assistant"
      readonly content: string
      readonly toolCalls?: readonly ToolCall[]
      /** The reply as the model made it, with its thinking. Only for a reply with tool calls. */
      readonly blocks?: readonly ReplyBlock[]
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
  /**
   * The most tokens that one request may write: the output limit that the user set for a custom
   * model (spec 006). Absent means that the request names no limit of its own, and an Anthropic
   * request takes the room that its effort level needs.
   */
  readonly maxOutput?: number
  readonly system: string
  readonly turns: readonly Turn[]
  readonly tools?: readonly ToolDef[]
  /**
   * Asks Anthropic to keep the start of the request ready for the next one, for this long. Absent
   * means no marker. The caller sets it only for an endpoint that takes it (`takesCacheMarker`).
   */
  readonly cache?: CacheLifetime
  readonly signal: AbortSignal
}

/** The whole reply of the model, as blocks. It comes at the end, only when the reply has thinking. */
export interface ReplyEvent {
  readonly type: "reply"
  readonly blocks: readonly ReplyBlock[]
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
    } else if (t.blocks?.length) {
      // The thinking goes back as it came: same blocks, same order. Only a tool call changes form.
      out.push({
        role: "assistant",
        content: t.blocks.map((b) =>
          b.type === "tool_use"
            ? { type: "tool_use", id: b.id, name: b.name, input: parseJson(b.input) }
            : b,
        ),
      })
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
    } else {
      // A message of the user after tool results (a message sent during the turn) goes in the
      // same turn as the results, because the roles must alternate.
      const last = out.at(-1)
      if (
        t.role === "user" &&
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content[0]?.type === "tool_result"
      )
        last.content.push({ type: "text", text: t.content })
      else out.push({ role: t.role, content: t.content })
    }
  }
  return out
}

/**
 * The most tokens that an Anthropic reply may use. The thinking of the model counts toward it, so
 * a higher effort level gets more room. The top value stays within what every model that takes
 * an effort level allows.
 */
const outputTokens: Record<string, number> = {
  low: 10240,
  medium: 16384,
  high: 32768,
  xhigh: 49152,
  max: 64000,
  ultra: 64000,
}
const OUTPUT_TOKENS = 8192

/**
 * For the older models: the thinking budget of each level, in tokens. The reply may use the budget
 * and the usual room on top of it, but not more than 32,000 tokens, which every one of these
 * models allows.
 */
const thinkingBudget: Record<string, number> = { low: 2048, medium: 8192, high: 24576 }
const BUDGET_MODEL_OUTPUT_LIMIT = 32000
const MIN_THINKING_BUDGET = 1024

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
    // The output limit of a custom model (spec 006). OpenAI itself names the field in another way
    // than the other servers that speak its API.
    ...(req.maxOutput
      ? req.connection.kind === "openai"
        ? { max_completion_tokens: req.maxOutput }
        : { max_tokens: req.maxOutput }
      : {}),
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

/** The body of one request to the Anthropic API. */
export interface AnthropicBody {
  readonly model: string
  readonly max_tokens: number
  readonly stream: true
  /** One marker for the whole request. The provider puts the breakpoint on the last block. */
  readonly cache_control?: CacheMarker
  readonly system?: string
  readonly messages: { role: string; content: unknown }[]
  readonly tools?: { name: string; description: string; input_schema: Record<string, unknown> }[]
  readonly output_config?: { effort: string }
  readonly thinking?: { type: string; display?: string; budget_tokens?: number }
}

/**
 * A newer model gets the chosen level as its effort setting. An older one, which has none, gets it
 * as a thinking budget. With no level the body has neither, and the model uses its own default.
 */
export const anthropicBody = (req: ChatRequest): AnthropicBody => {
  // An older model has no effort setting: the level gives it a thinking budget.
  const wanted =
    req.effort && takesThinkingBudget(req.model) ? thinkingBudget[req.effort] : undefined
  // The output limit of a custom model is the most tokens to write. The thinking budget must stay
  // below it, and the smallest budget that the API takes is 1,024 tokens: a limit too small for
  // that leaves the model without a thinking budget.
  const cap = req.maxOutput
  const budget =
    wanted !== undefined && cap !== undefined
      ? Math.min(wanted, cap - 1) >= MIN_THINKING_BUDGET
        ? Math.min(wanted, cap - 1)
        : undefined
      : wanted
  const maxTokens =
    cap ??
    (budget
      ? Math.min(OUTPUT_TOKENS + budget, BUDGET_MODEL_OUTPUT_LIMIT)
      : ((req.effort ? outputTokens[req.effort] : undefined) ?? OUTPUT_TOKENS))
  return {
    model: req.model,
    max_tokens: maxTokens,
    stream: true,
    ...(req.cache ? { cache_control: cacheMarker(req.cache) } : {}),
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
    ...(req.effort && wanted === undefined ? { output_config: { effort: req.effort } } : {}),
    ...(budget
      ? { thinking: { type: "enabled", budget_tokens: budget } }
      : // The text of the thinking is hidden unless asked for, and the chat shows it.
        req.effort && takesAdaptiveThinking(req.model)
        ? { thinking: { type: "adaptive", display: "summarized" } }
        : {}),
  }
}

/** A block while it streams in. The text, the thinking and the arguments grow with each piece. */
type Draft =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | { type: "other" }

/**
 * The reply as blocks that can go back to the model, or nothing. Only a reply with thinking needs
 * this. A thinking block without a signature cannot go back: the model would refuse the request.
 * That happens with a proxy that drops the signature, so the reply then goes the usual way.
 */
export const replyBlocks = (drafts: readonly Draft[]): ReplyBlock[] | null => {
  const blocks: ReplyBlock[] = []
  let thinks = false
  for (const d of drafts) {
    if (d.type === "other") return null
    if (d.type === "thinking") {
      if (!d.signature) return null
      thinks = true
      blocks.push(d)
    } else if (d.type === "redacted_thinking") {
      if (!d.data) return null
      thinks = true
      blocks.push(d)
    } else if (d.type === "text") {
      // The model refuses an empty text block.
      if (d.text) blocks.push(d)
    } else blocks.push(d)
  }
  return thinks ? blocks : null
}

/** The counts of tokens in the `usage` of an Anthropic reply. Every field can be absent. */
export interface AnthropicUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
}

/**
 * Counts all the input of one Anthropic reply. With caching on, `input_tokens` leaves out the
 * parts that were written to the cache or read from it, so all input is the three fields together
 * (specs 005 and 009: cached input counts as input). The counts come at the start of the stream
 * and can come again, as running totals, at the end. A field keeps its last value, so an event that
 * names only some of the fields never lowers the total. Gives the total when an event changes a
 * field, and nothing when it names none of them.
 */
export const inputCounter = () => {
  const seen = { fresh: 0, written: 0, read: 0 }
  // A field that a proxy sends as null counts as absent.
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined
  return (usage: AnthropicUsage | undefined): number | undefined => {
    if (!usage) return undefined
    const fresh = count(usage.input_tokens)
    const written = count(usage.cache_creation_input_tokens)
    const read = count(usage.cache_read_input_tokens)
    if (fresh === undefined && written === undefined && read === undefined) return undefined
    seen.fresh = fresh ?? seen.fresh
    seen.written = written ?? seen.written
    seen.read = read ?? seen.read
    return seen.fresh + seen.written + seen.read
  }
}

async function* anthropicStream(req: ChatRequest): AsyncGenerator<StreamEvent | ReplyEvent> {
  const body = await post(req, anthropicBody(req))
  const drafts = new Map<number, Draft>()
  const countInput = inputCounter()
  for await (const event of readSse(body)) {
    const data = JSON.parse(event.data) as {
      type: string
      index?: number
      content_block?: {
        type?: string
        id?: string
        name?: string
        text?: string
        thinking?: string
        signature?: string
        data?: string
      }
      message?: { usage?: AnthropicUsage }
      delta?: {
        type?: string
        text?: string
        thinking?: string
        signature?: string
        partial_json?: string
      }
      usage?: AnthropicUsage
      error?: { type?: string; message?: string }
    }
    const index = data.index ?? 0
    switch (data.type) {
      case "message_start": {
        const input = countInput(data.message?.usage)
        if (input !== undefined) yield { type: "usage", input }
        break
      }
      case "content_block_start": {
        const block = data.content_block
        if (block?.type === "tool_use")
          drafts.set(index, {
            type: "tool_use",
            id: block.id ?? "",
            name: block.name ?? "",
            input: "",
          })
        else if (block?.type === "thinking")
          drafts.set(index, {
            type: "thinking",
            thinking: block.thinking ?? "",
            signature: block.signature ?? "",
          })
        else if (block?.type === "redacted_thinking")
          drafts.set(index, { type: "redacted_thinking", data: block.data ?? "" })
        else if (block?.type === "text" || block?.type === undefined)
          drafts.set(index, { type: "text", text: block?.text ?? "" })
        else drafts.set(index, { type: "other" })
        break
      }
      case "content_block_stop": {
        const block = drafts.get(index)
        if (block?.type === "tool_use")
          yield { type: "toolcall", id: block.id, name: block.name, input: block.input }
        break
      }
      case "content_block_delta": {
        let block = drafts.get(index)
        // A proxy can leave out the start of a block. The pieces still count; a thinking block
        // that began this way has no signature, so the reply then goes the usual way.
        if (!block && data.delta?.type === "text_delta") {
          block = { type: "text", text: "" }
          drafts.set(index, block)
        } else if (!block && data.delta?.type === "thinking_delta") {
          block = { type: "thinking", thinking: "", signature: "" }
          drafts.set(index, block)
        }
        if (data.delta?.type === "input_json_delta" && block?.type === "tool_use")
          block.input += data.delta.partial_json ?? ""
        if (data.delta?.type === "text_delta" && data.delta.text) {
          if (block?.type === "text") block.text += data.delta.text
          yield { type: "text", text: data.delta.text }
        }
        if (data.delta?.type === "thinking_delta" && data.delta.thinking) {
          if (block?.type === "thinking") block.thinking += data.delta.thinking
          yield { type: "thinking", text: data.delta.thinking }
        }
        if (data.delta?.type === "signature_delta" && block?.type === "thinking")
          block.signature += data.delta.signature ?? ""
        break
      }
      case "message_delta": {
        // The counts of this event are running totals, so they replace the ones of the start.
        const input = countInput(data.usage)
        const output =
          typeof data.usage?.output_tokens === "number" ? data.usage.output_tokens : undefined
        if (input !== undefined || output !== undefined)
          yield {
            type: "usage",
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
          }
        break
      }
      case "error":
        if (data.error?.type === "rate_limit_error")
          throw limitFailure(data.error.message ?? "stream error")
        throw new ProviderFailure(
          data.error?.type === "overloaded_error" ? "provider_busy" : "provider_error",
          data.error?.message ?? "stream error",
        )
      case "message_stop": {
        const blocks = replyBlocks(
          [...drafts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
        )
        if (blocks) yield { type: "reply", blocks }
        return
      }
    }
  }
}

/** Streams one reply from the provider of the connection. */
export const streamChat = (req: ChatRequest): AsyncGenerator<StreamEvent | ReplyEvent> =>
  req.connection.kind === "anthropic" ? anthropicStream(req) : openAiStream(req)
