import { afterEach, describe, expect, test } from "bun:test"
import { runAgent } from "./agent.ts"
import { anthropicBody, normaliseTurns, replyBlocks, streamChat } from "./chat.ts"

describe("normaliseTurns", () => {
  test("joins turns of one role and drops empty ones", () => {
    expect(
      normaliseTurns([
        { role: "assistant", content: "hello" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "  " },
        { role: "assistant", content: "c" },
      ]),
    ).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
    ])
  })
})

describe("anthropicBody", () => {
  const base = {
    connection: { kind: "anthropic" as const, baseUrl: "http://x", apiKey: "k" },
    system: "",
    turns: [{ role: "user" as const, content: "hi" }],
    signal: new AbortController().signal,
  }

  test("a chosen level goes in the output setting, never as a thinking budget", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const body = anthropicBody({ ...base, model: "claude-sonnet-5-5", effort })
      expect(body.output_config).toEqual({ effort })
      expect(JSON.stringify(body)).not.toContain("budget_tokens")
    }
  })

  test("a model that takes adaptive thinking gets it, with the text of the thinking", () => {
    const body = anthropicBody({ ...base, model: "claude-haiku-5-5", effort: "max" })
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" })
  })

  test("a model that does not take it gets the level and no thinking setting", () => {
    const body = anthropicBody({ ...base, model: "claude-opus-4-5-20251101", effort: "high" })
    expect(body.output_config).toEqual({ effort: "high" })
    expect("thinking" in body).toBe(false)
  })

  test("with no level the body has no output setting and no thinking setting", () => {
    const body = anthropicBody({ ...base, model: "claude-opus-5-5", effort: null })
    expect("output_config" in body).toBe(false)
    expect("thinking" in body).toBe(false)
    expect(body.max_tokens).toBe(8192)
  })

  test("a higher level leaves more room for the reply, within what the models allow", () => {
    const room = (effort: string) =>
      anthropicBody({ ...base, model: "claude-opus-5-5", effort }).max_tokens
    expect(room("low")).toBeLessThan(room("medium"))
    expect(room("medium")).toBeLessThan(room("high"))
    expect(room("high")).toBeLessThan(room("xhigh"))
    expect(room("xhigh")).toBeLessThan(room("max"))
    expect(room("max")).toBeLessThanOrEqual(64000)
  })
})

describe("anthropicBody for an older model", () => {
  const base = {
    connection: { kind: "anthropic" as const, baseUrl: "http://x", apiKey: "k" },
    system: "",
    turns: [{ role: "user" as const, content: "hi" }],
    signal: new AbortController().signal,
  }

  test("a level is a thinking budget, and the body has no effort setting", () => {
    const budgets = { low: 2048, medium: 8192, high: 24576 }
    for (const [effort, budget] of Object.entries(budgets)) {
      const body = anthropicBody({ ...base, model: "claude-sonnet-4-5", effort })
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: budget })
      expect("output_config" in body).toBe(false)
      // The budget must be smaller than the room, and the room within what the model allows.
      expect(body.max_tokens).toBeGreaterThan(budget)
      expect(body.max_tokens).toBeLessThanOrEqual(32000)
    }
  })

  test("the highest level stays within the output limit of Opus 4.1", () => {
    const body = anthropicBody({ ...base, model: "claude-opus-4-1-20250805", effort: "high" })
    expect(body.max_tokens).toBe(32000)
    expect(body.thinking?.budget_tokens).toBe(24576)
  })

  test("with no level there is no thinking setting", () => {
    const body = anthropicBody({ ...base, model: "claude-sonnet-4-5", effort: null })
    expect("thinking" in body).toBe(false)
    expect(body.max_tokens).toBe(8192)
  })

  test("a newer model never gets a budget, which it refuses", () => {
    for (const model of ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      const body = anthropicBody({ ...base, model, effort: "high" })
      expect(JSON.stringify(body)).not.toContain("budget_tokens")
      expect(body.output_config).toEqual({ effort: "high" })
    }
  })
})

describe("a reply with thinking that calls a tool", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const sse = (...parts: string[]) =>
    new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } })

  /** A reply: thinking with a signature, a note, a tool call, in this order. */
  const toolReply = (signature = "SIG-1") =>
    sse(
      event("message_start", { message: { usage: { input_tokens: 5 } } }),
      event("content_block_start", {
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me " },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "look." },
      }),
      event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature } }),
      event("content_block_stop", { index: 0 }),
      event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Checking." } }),
      event("content_block_stop", { index: 1 }),
      event("content_block_start", {
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
      }),
      event("content_block_delta", {
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      }),
      event("content_block_delta", {
        index: 2,
        delta: { type: "input_json_delta", partial_json: '"a.txt"}' },
      }),
      event("content_block_stop", { index: 2 }),
      event("message_delta", { usage: { output_tokens: 9 } }),
      event("message_stop", {}),
    )

  const finalReply = () =>
    sse(
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Done." } }),
      event("content_block_stop", { index: 0 }),
      event("message_stop", {}),
    )

  const request = (effort: string | null) => ({
    connection: { kind: "anthropic" as const, baseUrl: "http://x", apiKey: "k" },
    model: "claude-sonnet-5-5",
    effort,
    system: "",
    turns: [{ role: "user" as const, content: "read a.txt" }],
    tools: [{ name: "read", description: "Reads a file", schema: { type: "object" } }],
    signal: new AbortController().signal,
  })

  test("the stream tells the reply as blocks, in the order that the model made them", async () => {
    globalThis.fetch = (async () => toolReply()) as unknown as typeof fetch
    const events = []
    for await (const e of streamChat(request("high"))) events.push(e)
    const reply = events.find((e) => e.type === "reply")
    expect(reply).toEqual({
      type: "reply",
      blocks: [
        { type: "thinking", thinking: "Let me look.", signature: "SIG-1" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_1", name: "read", input: '{"path":"a.txt"}' },
      ],
    })
    // The chat still gets the thinking and the text as they come.
    expect(events.filter((e) => e.type === "thinking").map((e) => e.text)).toEqual([
      "Let me ",
      "look.",
    ])
  })

  test("the next request carries the thinking block unchanged, before the tool call", async () => {
    const bodies: { messages: { role: string; content: unknown }[] }[] = []
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return ++calls === 1 ? toolReply("SIG-ABC") : finalReply()
    }) as unknown as typeof fetch
    const out: string[] = []
    for await (const e of runAgent(request("high"), async () => ({
      output: "file text",
      failed: false,
    }))) {
      if (e.type === "text") out.push(e.text)
    }
    expect(out.join("")).toContain("Done.")
    expect(bodies).toHaveLength(2)
    const second = bodies[1]?.messages ?? []
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(second[1]?.content).toEqual([
      { type: "thinking", thinking: "Let me look.", signature: "SIG-ABC" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
    ])
    expect(second[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "file text" },
    ])
  })

  test("a redacted thinking block goes back too", async () => {
    const blocks = replyBlocks([
      { type: "redacted_thinking", data: "ENC" },
      { type: "tool_use", id: "t", name: "read", input: "{}" },
    ])
    expect(blocks).toEqual([
      { type: "redacted_thinking", data: "ENC" },
      { type: "tool_use", id: "t", name: "read", input: "{}" },
    ])
  })

  test("without a signature the reply goes the usual way, as the model would refuse it", () => {
    expect(
      replyBlocks([
        { type: "thinking", thinking: "x", signature: "" },
        { type: "tool_use", id: "t", name: "read", input: "{}" },
      ]),
    ).toBeNull()
  })

  test("a reply without thinking is not kept, so nothing changes for the other models", () => {
    expect(
      replyBlocks([
        { type: "text", text: "ok" },
        { type: "tool_use", id: "t", name: "read", input: "{}" },
      ]),
    ).toBeNull()
  })

  test("an empty text block does not go back, as the model refuses it", () => {
    const blocks = replyBlocks([
      { type: "thinking", thinking: "x", signature: "S" },
      { type: "text", text: "" },
      { type: "tool_use", id: "t", name: "read", input: "{}" },
    ])
    expect(blocks?.map((b) => b.type)).toEqual(["thinking", "tool_use"])
  })

  test("pieces that come without the start of their block still stream, and are not sent back", async () => {
    globalThis.fetch = (async () =>
      sse(
        event("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "hm" },
        }),
        event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Hello" } }),
        event("message_stop", {}),
      )) as unknown as typeof fetch
    const events = []
    for await (const e of streamChat(request("high"))) events.push(e)
    expect(events.filter((e) => e.type === "thinking" || e.type === "text")).toEqual([
      { type: "thinking", text: "hm" },
      { type: "text", text: "Hello" },
    ])
    // The thinking has no signature, so the reply is not kept to be sent back.
    expect(events.some((e) => e.type === "reply")).toBe(false)
  })

  test("a model that does not think still gets text, then the tool call", async () => {
    const bodies: { messages: { role: string; content: unknown }[] }[] = []
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      if (++calls > 1) return finalReply()
      return sse(
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "Checking." },
        }),
        event("content_block_stop", { index: 0 }),
        event("content_block_start", {
          index: 1,
          content_block: { type: "tool_use", id: "toolu_9", name: "read", input: {} },
        }),
        event("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{}" },
        }),
        event("content_block_stop", { index: 1 }),
        event("message_stop", {}),
      )
    }) as unknown as typeof fetch
    for await (const _ of runAgent(request(null), async () => ({ output: "x", failed: false })));
    expect(bodies[1]?.messages[1]?.content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_9", name: "read", input: {} },
    ])
  })
})
