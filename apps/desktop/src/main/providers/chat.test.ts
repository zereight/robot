import { afterEach, describe, expect, test } from "bun:test"
import { runAgent } from "./agent.ts"
import { anthropicBody, inputCounter, normaliseTurns, replyBlocks, streamChat } from "./chat.ts"

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

  /** An inbox that hands out each message once. `waiting` takes new messages. */
  const inboxOf = (messages: { id: string; text: string }[]) => {
    const waiting = [...messages]
    return { waiting, take: () => waiting.splice(0), watch: () => () => {} }
  }

  test("a message of the user joins the request after the tool step (spec 003)", async () => {
    const bodies: { messages: { role: string; content: unknown }[] }[] = []
    let calls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return ++calls === 1 ? toolReply() : finalReply()
    }) as unknown as typeof fetch
    const inbox = inboxOf([])
    const events: string[] = []
    for await (const e of runAgent(
      request(null),
      async () => {
        // The user writes while the tool step runs.
        inbox.waiting.push({ id: "m1", text: "Use b.txt instead" })
        return { output: "file text", failed: false }
      },
      undefined,
      inbox,
    )) {
      events.push(e.type === "joined" ? `joined:${e.id}` : e.type)
    }
    expect(bodies).toHaveLength(2)
    // The message goes in the same turn as the tool result: the roles still alternate.
    expect(bodies[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "file text" },
        { type: "text", text: "Use b.txt instead" },
      ],
    })
    expect(events).toContain("joined:m1")
    expect(events.indexOf("joined:m1")).toBeLessThan(events.lastIndexOf("text"))
  })

  test("a message that comes while the reply streams gets one more request, not a new turn", async () => {
    const bodies: { messages: { role: string; content: unknown }[] }[] = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return finalReply()
    }) as unknown as typeof fetch
    const inbox = inboxOf([
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ])
    const joined: string[] = []
    for await (const e of runAgent(
      { ...request(null), tools: [] },
      async () => ({ output: "", failed: false }),
      undefined,
      inbox,
    ))
      if (e.type === "joined") joined.push(e.id)
    expect(bodies).toHaveLength(2)
    expect(joined).toEqual(["a", "b"])
    expect(bodies[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: "Done." },
      { role: "user", content: "first\n\nsecond" },
    ])
  })

  test("with no message in the inbox the turn ends after the reply", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return finalReply()
    }) as unknown as typeof fetch
    for await (const _ of runAgent(
      { ...request(null), tools: [] },
      async () => ({ output: "", failed: false }),
      undefined,
      inboxOf([]),
    ));
    expect(calls).toBe(1)
  })
})

describe("the cache marker in the body of an Anthropic request", () => {
  const base = {
    connection: { kind: "anthropic" as const, baseUrl: "http://x", apiKey: "k" },
    model: "claude-sonnet-5-5",
    effort: null,
    system: "Be brief.",
    turns: [{ role: "user" as const, content: "hi" }],
    signal: new AbortController().signal,
  }

  test("with no lifetime the body has no marker", () => {
    expect("cache_control" in anthropicBody(base)).toBe(false)
  })

  test("the short lifetime puts one marker on the top level, with the default lifetime", () => {
    const body = anthropicBody({ ...base, cache: "short" })
    expect(body.cache_control).toEqual({ type: "ephemeral" })
    // One marker for the whole request: none on a block of the system text or the messages.
    expect(JSON.stringify({ ...body, cache_control: undefined })).not.toContain("cache_control")
  })

  test("the long lifetime asks for 1 hour", () => {
    expect(anthropicBody({ ...base, cache: "long" }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    })
  })

  test("the marker leaves the rest of the body as it is", () => {
    const { cache_control: _, ...marked } = anthropicBody({ ...base, cache: "long" })
    expect(marked).toEqual(anthropicBody(base))
  })

  test("the marker is the same for the requests of one turn, so a tool step reads the cache", () => {
    const first = anthropicBody({ ...base, cache: "long", effort: "high" })
    const next = anthropicBody({
      ...base,
      cache: "long",
      effort: "high",
      turns: [...base.turns, { role: "assistant", content: "ok" }, { role: "user", content: "go" }],
    })
    expect(next.cache_control).toEqual(first.cache_control)
    expect(next.output_config).toEqual(first.output_config)
    expect(next.thinking).toEqual(first.thinking)
  })

  test("every request of a turn with a tool step carries the same marker", async () => {
    const realFetch = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    const event = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(
        bodies.length === 1
          ? [
              event("content_block_start", {
                index: 0,
                content_block: { type: "tool_use", id: "t1", name: "read", input: {} },
              }),
              event("content_block_delta", {
                index: 0,
                delta: { type: "input_json_delta", partial_json: "{}" },
              }),
              event("content_block_stop", { index: 0 }),
              event("message_stop", {}),
            ].join("")
          : [
              event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
              event("content_block_delta", {
                index: 0,
                delta: { type: "text_delta", text: "Done." },
              }),
              event("message_stop", {}),
            ].join(""),
      )
    }) as unknown as typeof fetch
    try {
      for await (const _ of runAgent(
        {
          ...base,
          cache: "long",
          tools: [{ name: "read", description: "Reads", schema: { type: "object" } }],
        },
        async () => ({ output: "text", failed: false }),
      ));
      expect(bodies).toHaveLength(2)
      for (const body of bodies)
        expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("the request that goes out carries the marker; a request of an OpenAI account never does", async () => {
    const realFetch = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return String(url).endsWith("/v1/messages")
        ? new Response(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
        : new Response("data: [DONE]\n\n")
    }) as unknown as typeof fetch
    const drain = async (req: Parameters<typeof streamChat>[0]) => {
      for await (const _ of streamChat(req));
    }
    try {
      await drain({ ...base, cache: "long" })
      await drain({
        ...base,
        connection: { kind: "openai", baseUrl: "http://x/v1", apiKey: "k" },
        cache: "long",
      })
      expect(bodies[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect("cache_control" in (bodies[1] ?? {})).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("the input tokens of an Anthropic reply", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

  /** The usage events that the stream of one reply gives, with the usage of its two events. */
  const usageOf = async (start: object | undefined, end: object | undefined) => {
    globalThis.fetch = (async () =>
      new Response(
        [
          event("message_start", start ? { message: { usage: start } } : { message: {} }),
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
          event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hi." } }),
          event("content_block_stop", { index: 0 }),
          event("message_delta", end ? { usage: end } : {}),
          event("message_stop", {}),
        ].join(""),
      )) as unknown as typeof fetch
    const usage = []
    for await (const e of streamChat({
      connection: { kind: "anthropic", baseUrl: "http://x", apiKey: "k" },
      model: "claude-sonnet-5-5",
      effort: null,
      system: "",
      turns: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
    }))
      if (e.type === "usage") usage.push({ input: e.input, output: e.output })
    return usage
  }

  test("a reply with no cache fields counts as before", async () => {
    expect(await usageOf({ input_tokens: 20 }, { output_tokens: 10 })).toEqual([
      { input: 20, output: undefined },
      { input: undefined, output: 10 },
    ])
  })

  test("the cached parts count as input, so the total is all three fields", async () => {
    const usage = await usageOf(
      { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 10 },
      { output_tokens: 10 },
    )
    expect(usage[0]).toEqual({ input: 20, output: undefined })
    expect(usage[1]).toEqual({ input: undefined, output: 10 })
  })

  test("a reply that reads the whole prompt from the cache counts it", async () => {
    const usage = await usageOf(
      { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 },
      { output_tokens: 5 },
    )
    expect(usage[0]?.input).toBe(8003)
  })

  test("a field that is null counts as zero", async () => {
    const usage = await usageOf(
      { input_tokens: 7, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      { output_tokens: 2 },
    )
    expect(usage[0]?.input).toBe(7)
  })

  test("running totals in the last event replace the first ones", async () => {
    const usage = await usageOf(
      { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 10 },
      {
        input_tokens: 4,
        cache_creation_input_tokens: 6,
        cache_read_input_tokens: 10,
        output_tokens: 9,
      },
    )
    expect(usage.at(-1)).toEqual({ input: 20, output: 9 })
  })

  test("a last event that names only some fields never lowers the total", async () => {
    const usage = await usageOf(
      { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 10 },
      { input_tokens: 5, output_tokens: 9 },
    )
    // The input field rose to 5; the two cache fields keep what the start told.
    expect(usage.at(-1)).toEqual({ input: 21, output: 9 })
  })

  test("a reply with no usage at all gives no usage event", async () => {
    expect(await usageOf(undefined, undefined)).toEqual([])
  })
})

describe("inputCounter", () => {
  test("gives nothing until an event names a field of the input", () => {
    const count = inputCounter()
    expect(count(undefined)).toBeUndefined()
    expect(count({})).toBeUndefined()
    expect(count({ output_tokens: 3 })).toBeUndefined()
    expect(count({ cache_read_input_tokens: 9 })).toBe(9)
  })

  test("adds the three fields and keeps the last value of each", () => {
    const count = inputCounter()
    expect(count({ input_tokens: 1, cache_creation_input_tokens: 2 })).toBe(3)
    expect(count({ cache_read_input_tokens: 10 })).toBe(13)
    expect(count({ input_tokens: 5 })).toBe(17)
  })
})
