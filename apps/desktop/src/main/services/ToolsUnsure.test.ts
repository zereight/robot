import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import type { ChatMessage, MessagePart } from "@robot/shared"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Decision } from "./Decision.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

// The level "Ask when unsure" (spec 007) with a stand-in model for the agent and a stand-in
// decision service for the check.

const KEY = "sk-or-unsure-test-key"

const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks)
          controller.enqueue(
            enc.encode(`data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`),
          )
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

/** A model that calls the tool named in the user text ("CALL name {json}"), then repeats the result. */
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      tools?: { function: { name: string } }[]
      messages: { role: string; content: string | null }[]
    }
    const last = body.messages.at(-1)
    if (last?.role === "tool")
      return sse([
        { choices: [{ delta: { content: `Result: ${last.content}` } }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        "[DONE]",
      ])
    const match = /CALL (\w+) (\{.*\})/.exec(String(last?.content ?? ""))
    if (match && body.tools?.some((t) => t.function.name === match[1]))
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: match[1], arguments: "" } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: match[2] } }] } }] },
        "[DONE]",
      ])
    return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])
  },
})

interface Seen {
  body: {
    state: { words_of_the_user: string; step: Record<string, unknown> }
    questions: Record<string, unknown>
  }
}
/** The requests that the stand-in decision service got. */
const seen: Seen[] = []
/** What the stand-in decision service answers next. Set by each test. */
let next: () => Promise<Response> | Response = () => Response.json({})

const decision = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as Seen["body"]
    seen.push({ body })
    if (req.headers.get("authorization") !== `Bearer ${KEY}`)
      return Response.json({ error: { code: 401, message: "no" } }, { status: 401 })
    return next()
  },
})
afterAll(() => {
  model.stop(true)
  decision.stop(true)
})

/** The answer of the check with this chance for "The user asked for this". */
const sure = (asked: number) => () =>
  Response.json({
    answers: {
      ask: {
        type: "choice",
        choice: asked >= 0.5 ? "asked" : "not_asked",
        confidence: 0.9,
        probabilities: { asked, not_asked: 1 - asked },
      },
    },
  })

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const call = (name: string, args: object) => `CALL ${name} ${JSON.stringify(args)}`

/** A command that the risk rules call an install, and that changes nothing when it runs. */
const INSTALL = 'echo "npm install left-pad"'

const setup = async (options: { checks?: boolean } = {}) => {
  seen.length = 0
  next = sure(0.95)
  const t = testRuntime({ decisionUrl: `http://127.0.0.1:${decision.port}` })
  const run = t.runtime.runPromise
  await run(
    SettingsStore.use((s) =>
      s.update({ decisionModel: "openrouter", decisionModelName: "jev-test" }),
    ),
  )
  await run(Decision.use((d) => d.keys({ openrouter: KEY })))
  await run(SettingsStore.use((s) => s.update({ permissionChecks: true })))
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${model.port}/v1`,
        apiKey: "sk-unsure-test-key",
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
        instructions: "Work.",
        model: { accountId: account.id, model: "mock", effort: null },
        permission: "ask_unsure",
      }),
    ),
  )
  // The switch can go off after the agent has the level.
  if (options.checks === false)
    await run(SettingsStore.use((s) => s.update({ permissionChecks: false })))
  mkdirSync(agent.workspace, { recursive: true })
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages
      .filter((m) => m.author === "agent")
      .at(-1)
  const toolPart = async () =>
    (await reply())?.parts.find(
      (p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool",
    )
  const finished = () =>
    until(async () => (await reply())?.status !== "streaming" && !!(await reply()))
  const respond = (answer: string) => run(Tools.use((x) => x.respond(agent.id, "call_1", answer)))
  const waitingCard = async () => {
    await until(async () => (await toolPart())?.state === "waiting")
    return (await toolPart())?.ask
  }
  const log = () => run(ActionLog.use((l) => l.list()))
  return { run, agent, local, send, reply, toolPart, finished, respond, waitingCard, log }
}

describe("Ask when unsure: a checked step", () => {
  test("a sure check runs an install with no card, and the card says Allowed by the check", async () => {
    const s = await setup()
    await s.send(`install the package left-pad. ${call("run_command", { command: INSTALL })}`)
    await s.finished()
    expect(await s.toolPart()).toMatchObject({ name: "run_command", state: "done" })
    expect((await s.toolPart())?.checkAllowed).toBe(0.95)
    expect((await s.toolPart())?.ask).toBeUndefined()
    // One request. It holds the words of the user and the full command, and nothing else.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.body.state.words_of_the_user).toContain("install the package left-pad")
    expect(seen[0]?.body.state.step).toEqual({ kind: "command", command: INSTALL })
    // The log names the check and its probability.
    const entry = (await s.log())[0]
    expect(entry).toMatchObject({
      kind: "shell",
      decidedBy: "check",
      result: "ran",
      check: { allowed: true, probability: 0.95, reason: null },
    })
  })

  test("an unsure check (0.6) shows the normal card with the line that it was not sure", async () => {
    const s = await setup()
    next = sure(0.6)
    await s.send(`install the package left-pad. ${call("run_command", { command: INSTALL })}`)
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({ kind: "approval", unsure: true })
    expect(seen).toHaveLength(1)
    await s.respond("allow")
    await s.finished()
    expect((await s.toolPart())?.checkAllowed).toBeUndefined()
    // The user decided. The log keeps what the check said.
    expect((await s.log())[0]).toMatchObject({
      decidedBy: "user",
      result: "ran",
      check: { allowed: false, probability: 0.6, reason: "unsure" },
    })
  })

  test("a check that does not answer in 3 seconds asks the user, and the step does not run", async () => {
    const s = await setup()
    next = async () => {
      await Bun.sleep(3600)
      return sure(0.99)()
    }
    await s.send(`install the package left-pad. ${call("run_command", { command: INSTALL })}`)
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({ kind: "approval", unsure: true })
    await s.respond("deny")
    await s.finished()
    expect((await s.log())[0]).toMatchObject({
      decidedBy: "user",
      check: { allowed: false, reason: "timeout" },
    })
  }, 20_000)

  test("an error of the service asks the user", async () => {
    const s = await setup()
    next = () => Response.json({ error: { message: "down" } }, { status: 500 })
    await s.send(`install the package left-pad. ${call("run_command", { command: INSTALL })}`)
    expect(await s.waitingCard()).toMatchObject({ kind: "approval", unsure: true })
    await s.respond("deny")
    await s.finished()
    expect((await s.log())[0]?.check).toMatchObject({ allowed: false, reason: "service_error" })
  })

  test("an answer that the app cannot read asks the user", async () => {
    const s = await setup()
    next = () => Response.json({ nothing: true })
    await s.send(`install the package left-pad. ${call("run_command", { command: INSTALL })}`)
    expect(await s.waitingCard()).toMatchObject({ kind: "approval", unsure: true })
    await s.respond("deny")
    await s.finished()
    expect((await s.log())[0]?.check).toMatchObject({ allowed: false, reason: "unreadable" })
  })
})

describe("Ask when unsure: steps that never go to the check", () => {
  test("sudo asks, with the usual card, and the decision model gets no request", async () => {
    const s = await setup()
    await s.send(`please run sudo -n true. ${call("run_command", { command: "sudo -n true" })}`)
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({ kind: "approval" })
    expect((ask as { unsure?: true }).unsure).toBeUndefined()
    await s.respond("deny")
    await s.finished()
    expect(seen).toHaveLength(0)
  })

  test("a command of more than 500 characters asks, and the decision model gets no request", async () => {
    const s = await setup()
    const long = `echo "npm install ${"a".repeat(600)}"`
    await s.send(`install it. ${call("run_command", { command: long })}`)
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({ kind: "approval" })
    expect((ask as { unsure?: true }).unsure).toBeUndefined()
    await s.respond("deny")
    await s.finished()
    expect(seen).toHaveLength(0)
  })

  test("a command that runs a script file asks, and the decision model gets no request", async () => {
    const s = await setup()
    const script = `${INSTALL} && ./setup.sh`
    await s.send(`install it. ${call("run_command", { command: script })}`)
    expect(await s.waitingCard()).toMatchObject({ kind: "approval" })
    await s.respond("deny")
    await s.finished()
    expect(seen).toHaveLength(0)
  })

  test("a step that is not risky runs with no question and no check", async () => {
    const s = await setup()
    await s.send(`say hi. ${call("run_command", { command: "echo hi" })}`)
    await s.finished()
    expect(await s.toolPart()).toMatchObject({ state: "done" })
    expect((await s.toolPart())?.checkAllowed).toBeUndefined()
    expect(seen).toHaveLength(0)
  })
})

describe("Ask when unsure: the switch Permission checks", () => {
  test("with the switch off, an agent at the level asks as at Ask for risky steps, with no request", async () => {
    const s = await setup({ checks: false })
    await s.send(`install the package left-pad. ${call("run_command", { command: INSTALL })}`)
    const ask = await s.waitingCard()
    expect(ask).toMatchObject({ kind: "approval" })
    expect((ask as { unsure?: true }).unsure).toBeUndefined()
    await s.respond("deny")
    await s.finished()
    expect(seen).toHaveLength(0)
  })

  test("the level cannot be picked while the switch is off", async () => {
    const s = await setup({ checks: false })
    const other = await s.run(
      Agents.use((a) =>
        a.create({
          serverId: s.local.id,
          name: "Ben",
          role: "",
          instructions: "Work.",
          permission: "ask_risky",
        }),
      ),
    )
    await expect(
      s.run(Agents.use((a) => a.update(other.id, { permission: "ask_unsure" }))),
    ).rejects.toMatchObject({ code: "unsure_unavailable" })
    await expect(
      s.run(
        Agents.use((a) =>
          a.create({
            serverId: s.local.id,
            name: "Cy",
            role: "",
            instructions: "Work.",
            permission: "ask_unsure",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "unsure_unavailable" })
  })

  test("an agent that has the level keeps it, and its profile can be saved again, while the switch is off", async () => {
    const s = await setup({ checks: false })
    const saved = await s.run(
      Agents.use((a) => a.update(s.agent.id, { permission: "ask_unsure", role: "Builder" })),
    )
    expect(saved).toMatchObject({ permission: "ask_unsure", role: "Builder" })
  })
})
