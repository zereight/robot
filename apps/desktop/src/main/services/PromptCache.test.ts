import { afterAll, describe, expect, test } from "bun:test"
import { messageText } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Chat, type TaskOrigin } from "./Chat.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Usage } from "./Usage.ts"

const KEY = "sk-cache-test"

/** What the stand-ins saw: the body of each request that asked for a reply. */
const seen: { path: string; body: Record<string, unknown> }[] = []

const stream = (parts: string[]) =>
  new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } })
const frame = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

/**
 * Two stand-in providers. `/anthropic` speaks the Anthropic API and reports the input as the real
 * one does with caching on: 4 new tokens, 6 written to the cache and 10 read from it. `/openai`
 * speaks the OpenAI API.
 */
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/anthropic/v1/models")
      return Response.json({ data: [{ id: "claude-sonnet-5-5" }] })
    if (url.pathname === "/openai/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as Record<string, unknown>
    seen.push({ path: url.pathname, body })
    if (url.pathname === "/anthropic/v1/messages")
      return stream([
        frame("message_start", {
          message: {
            usage: { input_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 10 },
          },
        }),
        frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello." } }),
        frame("content_block_stop", { index: 0 }),
        frame("message_delta", { usage: { output_tokens: 3 } }),
        frame("message_stop", {}),
      ])
    return stream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello." } }] })}\n\n`,
      "data: [DONE]\n\n",
    ])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

/** An app on its own database, with one agent on an account of the given kind. */
const setup = async (
  options: { kind?: "anthropic" | "custom"; cacheHosts?: readonly string[] } = {},
) => {
  seen.length = 0
  const kind = options.kind ?? "anthropic"
  const t = testRuntime(options.cacheHosts ? { cacheHosts: options.cacheHosts } : {})
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind,
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/${kind === "anthropic" ? "anthropic" : "openai"}`,
        apiKey: KEY,
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: {
          accountId: account.id,
          model: kind === "anthropic" ? "claude-sonnet-5-5" : "mock",
          effort: null,
        },
      }),
    ),
  )
  const send = async (text: string, origin?: TaskOrigin) => {
    const before = seen.length
    await run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null }, origin)))
    // The turn ends when its reply is stored as done.
    await until(async () => {
      const { messages, queue } = await run(Chat.use((c) => c.history(agent.id)))
      return (
        seen.length > before &&
        queue.length === 0 &&
        messages.every((m) => m.status !== "streaming") &&
        messageText(messages.at(-1) ?? { parts: [] }) !== ""
      )
    })
    return seen.at(-1)?.body ?? {}
  }
  return { ...t, run, account, local, agent, send }
}

describe("prompt cache for an Anthropic account", () => {
  test("a turn that a person starts in the chat asks for 1 hour", async () => {
    const t = await setup({ cacheHosts: ["127.0.0.1"] })
    const body = await t.send("hello")
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("a turn of a routine, a workflow or another agent asks for the default 5 minutes", async () => {
    const t = await setup({ cacheHosts: ["127.0.0.1"] })
    const routine = await t.send("routine job", { source: "routine", sourceId: "r1" })
    const workflow = await t.send("workflow step", { source: "workflow", sourceId: "w1" })
    const colleague = await t.send("message", {
      source: "agent",
      sourceId: "a1",
      starter: "agent",
      prompt: "message",
    })
    for (const body of [routine, workflow, colleague])
      expect(body.cache_control).toEqual({ type: "ephemeral" })
    // The next message of the person asks for 1 hour again: the choice is for each turn.
    expect((await t.send("and now me")).cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("a request from a place with no source of its own asks for the default 5 minutes", async () => {
    // A channel part, a check of the lead, a workflow question and a draft skill give no lifetime.
    const t = await setup({ cacheHosts: ["127.0.0.1"] })
    const events = await t.run(
      Providers.use((p) =>
        p.events(
          t.account.id,
          {
            model: "claude-sonnet-5-5",
            effort: null,
            system: "Be brief.",
            turns: [{ role: "user", content: "check this" }],
            signal: new AbortController().signal,
            workspace: t.dataDir,
            permission: "ask_all",
            useTools: false,
          },
          { execute: async () => ({ output: "", failed: true }), approve: async () => false },
        ),
      ),
    )
    for await (const _ of events);
    expect(seen.at(-1)?.body.cache_control).toEqual({ type: "ephemeral" })
  })

  test("an endpoint that is not the official host gets no marker, so a proxy cannot refuse the chat", async () => {
    const t = await setup()
    const body = await t.send("hello")
    expect("cache_control" in body).toBe(false)
    expect(body.model).toBe("claude-sonnet-5-5")
  })

  test("an account that speaks the OpenAI API gets no marker, on any host", async () => {
    const t = await setup({ kind: "custom", cacheHosts: ["127.0.0.1"] })
    const body = await t.send("hello")
    expect("cache_control" in body).toBe(false)
    expect(seen.at(-1)?.path).toBe("/openai/chat/completions")
  })

  test("the usage of the reply counts the cached parts as input", async () => {
    const t = await setup({ cacheHosts: ["127.0.0.1"] })
    await t.send("hello")
    // The stand-in reports 4 new, 6 written and 10 read: all input is 20.
    const [row] = await t.run(Usage.use((u) => u.summary(t.local.id, 7)))
    expect(row).toMatchObject({ replies: 1, inputTokens: 20, outputTokens: 3 })
  })

  test("an endpoint that reports cached input has it counted too, with or without the marker", async () => {
    const t = await setup()
    await t.send("hello")
    const [row] = await t.run(Usage.use((u) => u.summary(t.local.id, 7)))
    expect(row).toMatchObject({ replies: 1, inputTokens: 20, outputTokens: 3 })
  })
})
