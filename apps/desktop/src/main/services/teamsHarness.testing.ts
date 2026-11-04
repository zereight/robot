import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatMessage, MessagePart, PermissionLevel, TeamsPatch } from "@robot/shared"
import { Effect } from "effect"
import type { FakeChat } from "../teams/fakeChat.testing.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { asOldShape } from "./channelTurns.testing.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { TeamsLink } from "./TeamsLink.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

// The set-up of the tests of the answers of the Teams link (spec 028, S103): a stand-in model, the
// stand-in Teams, a running app with three agents, and the helpers that move time and read what
// the stand-in Teams got. Nothing here calls the real Teams or a real model.

export const ROOM = "Team room"
export const PASSWORD = "correct-horse-battery-staple-7731"
export const MARTA = "Marta Kim"
/**
 * The key that the stand-in provider holds. It has no known form, so a reply that holds it is hidden
 * only because it equals a stored key (spec 014).
 */
export const PROVIDER_KEY = "stored-provider-key-0042"

// --- The stand-in model ---------------------------------------------------------------------------

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
const delta = (content: string) => ({ choices: [{ delta: { content } }] })
const usage = { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }

/**
 * The stand-in model. It reads the last line of the last message and acts by it:
 * - `REPLY <text>` answers with that text.
 * - `REPLYLEN <n>` answers with words of 9 letters, about n characters.
 * - `NOSPACE <n>` answers with n letters and no space.
 * - `BLOCKED <reason>` answers with a last line "Blocked: <reason>".
 * - `CALLS [...]` calls those tools in one reply, and answers "Done." after the results.
 * - a text with "SLOW" waits for `hold()`, a text with "BREAK" fails, and a text with "FLAKY" fails
 *   once and then works. "SLOW " and "FLAKY " in front of a directive do not hide it.
 * Any other text gets "ok". `extra` may answer a request first: it gets the last message and its last
 * line, and gives a reply text, or null to leave the request to the rules above.
 */
export const startModel = (extra?: (text: string, lastLine: string) => string | null) => {
  const seen: string[] = []
  let gate: { promise: Promise<void>; release: () => void } | undefined
  let flakyFailed = false
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/models")
        return Response.json({ data: [{ id: "mock", context_length: 100000 }] })
      const body = asOldShape(
        (await req.json()) as { messages: { role: string; content: string | null }[] },
      )
      const last = body.messages.at(-1)
      if (last?.role === "tool") return sse([delta("Done."), usage, "[DONE]"])
      const text = String(last?.content ?? "")
      seen.push(text)
      // A word of behaviour in front of a directive changes nothing of the directive.
      const lastLine = (text.split("\n").at(-1) ?? "").replace(/^((SLOW|FLAKY) )+/, "")
      if (text.includes("SLOW") && gate) await gate.promise
      if (text.includes("BREAK")) return new Response("boom", { status: 500 })
      if (text.includes("FLAKY") && !flakyFailed) {
        flakyFailed = true
        return new Response("boom", { status: 500 })
      }
      const special = extra?.(text, lastLine) ?? null
      if (special !== null) return sse([delta(special), usage, "[DONE]"])
      const calls = /^CALLS (\[.*\])$/.exec(lastLine)
      if (calls) {
        const list = JSON.parse(calls[1] as string) as { name: string; args: unknown }[]
        return sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: list.map((c, index) => ({
                    index,
                    id: `call_${index + 1}`,
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                },
              },
            ],
          },
          "[DONE]",
        ])
      }
      const reply = /^REPLY (.*)$/.exec(lastLine)
      if (reply) return sse([delta(reply[1] as string), usage, "[DONE]"])
      const length = /^REPLYLEN (\d+)$/.exec(lastLine)
      if (length) {
        const n = Number(length[1])
        return sse([delta("abcdefghi ".repeat(Math.ceil(n / 10)).slice(0, n)), usage, "[DONE]"])
      }
      const nospace = /^NOSPACE (\d+)$/.exec(lastLine)
      if (nospace) return sse([delta("x".repeat(Number(nospace[1]))), usage, "[DONE]"])
      const blocked = /^BLOCKED (.*)$/.exec(lastLine)
      if (blocked) return sse([delta(`Working on it.\nBlocked: ${blocked[1]}`), usage, "[DONE]"])
      return sse([delta("ok"), usage, "[DONE]"])
    },
  })
  return {
    server,
    seen,
    /** The next request that holds "SLOW" waits until the returned function is called. */
    hold: () => {
      let release = () => {}
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      gate = { promise, release }
      return release
    },
    reset: () => {
      seen.length = 0
      gate = undefined
      flakyFailed = false
    },
    stop: () => server.stop(true),
  }
}
export type Model = ReturnType<typeof startModel>

export const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

/** Lets the work that waits on a promise run. The stand-in answers at once, so a few turns do. */
export const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

export const calls = (...list: { name: string; args: unknown }[]) => `CALLS ${JSON.stringify(list)}`
export const change = (instructions: string) => ({ name: "settings", args: { instructions } })

type ToolPart = Extract<MessagePart, { kind: "tool" }>
export const toolOf = (message: ChatMessage | undefined, callId: string) =>
  message?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === callId)

// --- The set-up -----------------------------------------------------------------------------------

export const setup = async (
  model: Model,
  permission: PermissionLevel = "ask_risky",
  options: { chat?: FakeChat } = {},
) => {
  model.reset()
  const t = testRuntime({ name: "This Mac", ...(options.chat ? { chat: options.chat } : {}) })
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${model.server.port}/v1`,
        apiKey: PROVIDER_KEY,
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const make = async (name: string) => {
    const agent = await run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: "Work.",
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
    await run(Agents.use((a) => a.update(agent.id, { permission })))
    mkdirSync(agent.workspace, { recursive: true })
    return agent
  }
  const ada = await make("Ada")
  const lia = await make("Lia")
  const db = await run(Database.use((d) => Effect.succeed(d)))

  /** Moves time on by seconds. Each second runs the tick of the link, then lets the work settle. */
  const pass = async (ms: number) => {
    for (let spent = 0; spent < ms; spent += 1000) {
      t.advance(1000)
      await settle()
    }
  }
  const update = (patch: TeamsPatch) => run(TeamsLink.use((l) => l.update(patch)))
  const view = () => run(TeamsLink.use((l) => l.view))
  const turnOn = async () => {
    await run(TeamsLink.use((l) => l.setEnabled(true)))
    await pass(3000)
  }
  const turnOff = () => run(TeamsLink.use((l) => l.setEnabled(false)))
  const showPage = () => run(TeamsLink.use((l) => l.showPage))
  const hidePage = () => run(TeamsLink.use((l) => l.hidePage))

  /** The user sets up the link, signs in by hand, and fills the form. The switch stays off. */
  const prepare = async (patch: TeamsPatch = {}) => {
    await run(TeamsLink.use((l) => l.setup))
    t.chat.addChat(ROOM)
    await showPage()
    t.chat.signInByHand(PASSWORD)
    await pass(3000)
    await update({
      targetKind: "agent",
      targetId: ada.id,
      chatTitle: ROOM,
      chatKind: "group",
      callText: "@ROBot",
      allow: [MARTA],
      bots: ["Helper Bot"],
      ...patch,
    })
    await hidePage()
  }

  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const taskList = async () => (await tasks()).toReversed()
  /** Waits until at least `count` tasks exist and none runs or waits in the queue. */
  const quiet = (count: number) =>
    until(async () => {
      const all = await tasks()
      return all.length >= count && all.every((x) => !["queued", "running"].includes(x.state))
    })
  const messages = async (agentId = ada.id) =>
    (await run(Chat.use((c) => c.history(agentId)))).messages
  const reply = async (agentId = ada.id) =>
    (await messages(agentId)).filter((m) => m.author === "agent").at(-1)
  const card = async (callId: string) => {
    await until(async () => toolOf(await reply(), callId)?.state === "waiting")
    return toolOf(await reply(), callId)?.ask
  }
  const respond = (callId: string, answer: string) =>
    run(Tools.use((x) => x.respond(ada.id, callId, answer)))

  /** What the stand-in Teams got typed, as the texts, in order. */
  const typedTexts = () => t.chat.typed.map((x) => x.text)
  /** The records in Settings, Teams, newest first. */
  const records = async () => (await view()).records
  const logText = () => {
    try {
      return readFileSync(join(t.dataDir, "logs", "teams.log"), "utf8")
    } catch {
      return ""
    }
  }
  const log = () =>
    logText()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { time: string; event: string; reason?: string; place?: string },
      )
  const reasons = (event: string) =>
    log()
      .filter((r) => r.event === event)
      .map((r) => r.reason)

  /**
   * A task that a message from Teams started and that ends now, with no model: the reply message
   * is written first, then the task runs and ends as `end` says. It goes through the real service
   * of tasks, so the link sees the end as it sees any other.
   */
  const endTask = async (
    reply: { text?: string; files?: number },
    end: "done" | { fail: { code: string; detail?: string } } | "blocked" = "done",
    agentId = ada.id,
  ) => {
    const messageId = randomUUID()
    const parts: MessagePart[] = [
      ...(reply.text === undefined ? [] : [{ kind: "text", text: reply.text } as const]),
      ...Array.from(
        { length: reply.files ?? 0 },
        (_, i) =>
          ({ kind: "file", name: `f${i}.png`, path: `attachments/f${i}.png`, size: 1 }) as const,
      ),
    ]
    db.run(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at) VALUES (?, ?, 'agent', ?, 'done', ?)",
      messageId,
      agentId,
      JSON.stringify(parts),
      t.clock.now(),
    )
    const task = await run(
      Tasks.use((x) =>
        x.create({
          agentId,
          prompt: "from teams",
          source: "teams",
          sourceId: agentId,
          messageId,
        }),
      ),
    )
    const work =
      end === "done" || end === "blocked"
        ? Effect.void
        : Effect.fail({ code: end.fail.code, detail: end.fail.detail ?? "" })
    await t.runtime.runPromiseExit(
      Tasks.use((x) =>
        x.run(
          task.id,
          agentId,
          work,
          end === "blocked"
            ? { finish: () => ({ state: "blocked", reason: "The key is missing." }) as const }
            : undefined,
        ),
      ),
    )
    return task
  }

  return {
    ...t,
    run,
    local,
    ada,
    lia,
    db,
    pass,
    update,
    view,
    turnOn,
    turnOff,
    showPage,
    hidePage,
    prepare,
    tasks,
    taskList,
    quiet,
    messages,
    reply,
    card,
    respond,
    typedTexts,
    records,
    logText,
    log,
    reasons,
    endTask,
  }
}
export type S = Awaited<ReturnType<typeof setup>>
export const dispose = (s: S) => s.runtime.dispose()

/** A link that is on, with the baseline read done. */
export const running = async (
  model: Model,
  permission: PermissionLevel = "ask_risky",
  over: TeamsPatch = {},
) => {
  const s = await setup(model, permission)
  await s.prepare(over)
  await s.turnOn()
  return s
}
