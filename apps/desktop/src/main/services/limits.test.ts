import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  CHAIN_LIMIT,
  CHAIN_LIMIT_TEXT,
  type ChatMessage,
  type MessagePart,
  REPEATED_READ_TEXT,
  type Task,
} from "@robot/shared"
import { Effect } from "effect"
import { runRequest } from "../rpc.ts"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// A model for the limits of a task. What it does depends on words in the last user message:
//   LOOP             calls list_files after every result, without end
//   CALLS [...]      calls the listed tools in one reply, then says "done"
//   PINGPONG with X  sends a message to X; a message "from the agent Y" with PINGPONG goes back to Y
//   FAILAFTER        the request after the first tool result fails once for this text
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

// A real provider gives each call its own id.
let callCount = 0

const toolCalls = (calls: { name: string; args: unknown }[]) => {
  const ids = calls.map(() => `call_${++callCount}`)
  return sse([
    ...calls.map((c, index) => ({
      choices: [
        {
          delta: {
            tool_calls: [{ index, id: ids[index], function: { name: c.name, arguments: "" } }],
          },
        },
      ],
    })),
    ...calls.map((c, index) => ({
      choices: [
        {
          delta: {
            tool_calls: [{ index, function: { arguments: JSON.stringify(c.args) } }],
          },
        },
      ],
    })),
    "[DONE]",
  ])
}

const text = (content: string) =>
  sse([
    { choices: [{ delta: { content } }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    "[DONE]",
  ])

const failedOnce = new Set<string>()

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as {
      messages: { role: string; content: string | null }[]
    }
    const users = body.messages.filter((m) => m.role === "user")
    const first = String(users[0]?.content ?? "")
    const last = body.messages.at(-1)
    const lastText = String(last?.content ?? "")
    if (last?.role === "tool") {
      if (first.includes("LOOP")) return toolCalls([{ name: "list_files", args: { path: "." } }])
      if (first.includes("FAILAFTER") && !failedOnce.has(first)) {
        failedOnce.add(first)
        return new Response("boom", { status: 500 })
      }
      return text(`Tool said: ${lastText.slice(0, 60)}`)
    }
    const many = /CALLS (\[.*\])/.exec(lastText)
    if (many) return toolCalls(JSON.parse(many[1] as string))
    if (lastText.includes("LOOP")) return toolCalls([{ name: "list_files", args: { path: "." } }])
    if (lastText.includes("FAILAFTER")) {
      const call = /CALL (\w+) (\{.*\})/.exec(lastText)
      if (call) return toolCalls([{ name: call[1] as string, args: JSON.parse(call[2] as string) }])
    }
    if (lastText.includes("PINGPONG")) {
      const asked = /from the agent (\w+)/.exec(lastText)?.[1]
      const named = /PINGPONG with (\w+)/.exec(lastText)?.[1]
      const to = asked ?? named
      if (to) return toolCalls([{ name: "send_message", args: { to, text: "PINGPONG" } }])
    }
    return text("ok")
  },
})
afterAll(() => server.stop())

const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out")
}

const setup = async (names: string[] = ["Ada"]) => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-limits-test-key",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agents = new Map<string, Awaited<ReturnType<typeof makeAgent>>>()
  const makeAgent = (name: string) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: `${name} works.`,
          instructions: "Work.",
          model: { accountId: account.id, model: "mock", effort: null },
        }),
      ),
    )
  for (const name of names) {
    const agent = await makeAgent(name)
    await run(Agents.use((a) => a.update(agent.id, { permission: "full" })))
    mkdirSync(agent.workspace, { recursive: true })
    agents.set(name, agent)
  }
  const agent = (name: string) => agents.get(name) as NonNullable<ReturnType<typeof agents.get>>
  const send = (name: string, message: string) =>
    run(Chat.use((c) => c.send({ agentId: agent(name).id, text: message, replyTo: null })))
  const messages = async (name: string): Promise<readonly ChatMessage[]> =>
    (await run(Chat.use((c) => c.history(agent(name).id)))).messages
  const reply = async (name: string) =>
    (await messages(name)).filter((m) => m.author === "agent").at(-1)
  const tools = async (name: string) =>
    ((await reply(name))?.parts ?? []).filter(
      (p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool",
    )
  const tasks = () => run(Tasks.use((x) => x.list(local.id)))
  const quiet = async () => {
    await until(async () => {
      const all = await tasks()
      return all.length > 0 && all.every((x) => !["queued", "running", "waiting"].includes(x.state))
    })
  }
  const depth = (task: Task) => run(Tasks.use((x) => Effect.succeed(x.depthOf(task.id))))
  return { t, run, local, agent, send, messages, reply, tools, tasks, quiet, depth }
}

describe("step limit (spec 005)", () => {
  test("a task that calls a tool in every turn ends as Failed at the limit; the reply stays, stopped", async () => {
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ stepLimit: 20 })))
    await s.send("Ada", "LOOP please")
    await s.quiet()
    const [task] = await s.tasks()
    expect(task?.state).toBe("failed")
    expect(task?.error).toEqual({ code: "step_limit", detail: "20" })
    const last = await s.reply("Ada")
    // The reply that streamed stays, and it counts as stopped. The reason stays with it.
    expect(last?.status).toBe("stopped")
    expect(last?.error).toMatchObject({ code: "step_limit", detail: "20" })
    const steps = await s.tools("Ada")
    expect(steps).toHaveLength(20)
    expect(steps.every((p) => p.state === "done")).toBe(true)
  })

  test("the default limit is 300 and the setting takes 20 to 2000", async () => {
    const s = await setup()
    expect((await s.run(SettingsStore.use((x) => x.get))).stepLimit).toBe(300)
  })

  test("a task of 12 or more rounds is no longer cut off at 12 (the old cap is gone)", async () => {
    const s = await setup()
    await s.run(SettingsStore.use((x) => x.update({ stepLimit: 40 })))
    await s.send("Ada", "LOOP please")
    await s.quiet()
    expect((await s.tools("Ada")).length).toBe(40)
  })
})

describe("repeated reads (spec 005)", () => {
  test("the third read with the same result fails with the short text; a changed file reads again", async () => {
    const s = await setup()
    writeFileSync(join(s.agent("Ada").workspace, "a.txt"), "one")
    const read = { name: "read_file", args: { path: "a.txt" } }
    const write = { name: "write_file", args: { path: "a.txt", content: "two" } }
    await s.send("Ada", `CALLS ${JSON.stringify([read, read, read, write, read])}`)
    await s.quiet()
    const steps = await s.tools("Ada")
    expect(steps.map((p) => `${p.name}:${p.state}`)).toEqual([
      "read_file:done",
      "read_file:done",
      "read_file:failed",
      "write_file:done",
      "read_file:done",
    ])
    expect(steps[2]?.output).toBe(REPEATED_READ_TEXT)
    expect(steps[2]?.reason?.code).toBe("repeated_read")
    expect(steps[4]?.output).toBe("two")
    // The turn goes on: the task is Done.
    expect((await s.tasks())[0]?.state).toBe("done")
  })

  test("two reads with one result and a third with another result are all allowed", async () => {
    const s = await setup()
    const file = join(s.agent("Ada").workspace, "b.txt")
    writeFileSync(file, "x")
    const read = { name: "read_file", args: { path: "b.txt" } }
    const write = { name: "write_file", args: { path: "b.txt", content: "y" } }
    await s.send("Ada", `CALLS ${JSON.stringify([read, read, write, read, read])}`)
    await s.quiet()
    expect((await s.tools("Ada")).map((p) => p.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
    ])
  })
})

describe("chain of messages between agents (spec 005, 007)", () => {
  test("the send of the task at depth 8 fails with the reason; no more task starts from a send", async () => {
    const s = await setup(["Ada", "Bo"])
    await s.send("Ada", "PINGPONG with Bo")
    await s.quiet()
    const all = await s.tasks()
    const depths = await Promise.all(all.map(async (t) => ({ t, d: await s.depth(t) })))
    const requests = depths.filter(({ t }) => t.source === "agent" && t.prompt === "PINGPONG")
    // The user's task is at depth 0, and the sends make depth 1 to 8: nothing is deeper.
    expect(Math.max(...requests.map((r) => r.d))).toBe(CHAIN_LIMIT)
    expect(requests).toHaveLength(CHAIN_LIMIT)
    // Replies come back one level deeper than the task that answered, also at depth 9.
    expect(Math.max(...depths.map((r) => r.d))).toBe(CHAIN_LIMIT + 1)
    // The step of the task at depth 8 failed with the reason of the chain limit.
    const failedSteps = (
      await Promise.all(
        ["Ada", "Bo"].map(async (n) => (await s.messages(n)).flatMap((m) => m.parts)),
      )
    )
      .flat()
      .filter(
        (p): p is Extract<MessagePart, { kind: "tool" }> =>
          p.kind === "tool" && p.reason?.code === "chain_limit",
      )
    expect(failedSteps).toHaveLength(1)
    expect(failedSteps[0]).toMatchObject({
      name: "send_message",
      state: "failed",
      output: CHAIN_LIMIT_TEXT,
      reason: { code: "chain_limit", detail: String(CHAIN_LIMIT) },
    })
    // Every task ended. The task at depth 8 is Done: its turn went on after the failed step.
    expect(all.every((t) => t.state === "done")).toBe(true)
  })

  test("a message to an unknown agent, to itself, or to an archived agent fails with a plain reason", async () => {
    const s = await setup(["Ada", "Bo"])
    const send = (to: string) =>
      s.send("Ada", `CALLS ${JSON.stringify([{ name: "send_message", args: { to, text: "hi" } }])}`)
    await send("Nobody")
    await s.quiet()
    await send("Ada")
    await s.run(Agents.use((a) => a.archive(s.agent("Bo").id)))
    await send("Bo")
    await until(async () => (await s.tools("Ada")).length > 0)
    await s.quiet()
    const outputs = (await s.messages("Ada"))
      .flatMap((m) => m.parts)
      .filter((p): p is Extract<MessagePart, { kind: "tool" }> => p.kind === "tool")
      .map((p) => p.output)
    expect(outputs.some((o) => o.startsWith("No agent has this name"))).toBe(true)
    expect(outputs.some((o) => o.includes("cannot send a message to itself"))).toBe(true)
  })
})

describe("retry note (spec 005)", () => {
  test("a task that wrote a file and then failed shows the note; confirmed starts a new task", async () => {
    const s = await setup()
    const write = { name: "write_file", args: { path: "out.txt", content: "data" } }
    await s.send("Ada", `FAILAFTER CALL write_file ${JSON.stringify(write.args)}`)
    await s.quiet()
    const [failed] = await s.tasks()
    expect(failed?.state).toBe("failed")

    const note = await s.run(Tasks.use((t) => Effect.succeed(t.noteFor(failed?.id ?? ""))))
    expect(note?.computer).toBeNull()
    expect(note?.steps).toHaveLength(1)
    expect(note?.steps[0]).toMatchObject({ kind: "file", access: "write", result: "ran" })
    expect(note?.steps[0]?.target).toContain("out.txt")

    // Without the confirm nothing starts and the answer holds the note.
    const asked = await s.run(Tasks.use((t) => t.retry(failed?.id ?? "")))
    expect(asked.started).toBe(false)
    expect((await s.tasks()).length).toBe(1)
    // Retry anyway starts a new task that links to the old one.
    const sure = await s.run(Tasks.use((t) => t.retry(failed?.id ?? "", { confirmed: true })))
    expect(sure.started).toBe(true)
    await s.quiet()
    const all = await s.tasks()
    expect(all).toHaveLength(2)
    expect(all.find((t) => t.retryOf === failed?.id)?.state).toBe("done")
  })

  test("a task that only read files starts at once on retry", async () => {
    const s = await setup()
    writeFileSync(join(s.agent("Ada").workspace, "r.txt"), "text")
    await s.send("Ada", `FAILAFTER CALL read_file ${JSON.stringify({ path: "r.txt" })}`)
    await s.quiet()
    const [failed] = await s.tasks()
    expect(failed?.state).toBe("failed")
    expect(await s.run(Tasks.use((t) => Effect.succeed(t.noteFor(failed?.id ?? ""))))).toBeNull()
    const started = await s.run(Tasks.use((t) => t.retry(failed?.id ?? "")))
    expect(started.started).toBe(true)
    await s.quiet()
    expect(await s.tasks()).toHaveLength(2)
  })

  test("the retry of a failed reply in a chat asks first, then deletes the reply and tries again", async () => {
    const s = await setup()
    await s.send(
      "Ada",
      `FAILAFTER CALL run_command ${JSON.stringify({ command: "echo hi > made.txt" })}`,
    )
    await s.quiet()
    const failed = await s.reply("Ada")
    expect(failed?.status).toBe("failed")
    const [firstTask] = await s.tasks()
    const agentId = s.agent("Ada").id
    const first = await s.run(Chat.use((c) => c.retry(agentId, failed?.id ?? "")))
    expect(first.started).toBe(false)
    if (!first.started) expect(first.note.steps[0]).toMatchObject({ kind: "shell", result: "ran" })
    // The reply stays until the user decides.
    expect((await s.reply("Ada"))?.id).toBe(failed?.id)
    const second = await s.run(
      Chat.use((c) => c.retry(agentId, failed?.id ?? "", { confirmed: true })),
    )
    expect(second.started).toBe(true)
    await s.quiet()
    const all = await s.tasks()
    expect(all).toHaveLength(2)
    expect(all.find((t) => t.retryOf !== null)?.retryOf).toBe(firstTask?.id)
  })

  test("the step record keeps steps in order, newest first in the note, five at most, with the rest counted", async () => {
    const s = await setup()
    const calls = Array.from({ length: 7 }, (_, i) => ({
      name: "write_file",
      args: { path: `f${i}.txt`, content: String(i) },
    }))
    await s.send("Ada", `CALLS ${JSON.stringify(calls)}`)
    await s.quiet()
    const [task] = await s.tasks()
    const note = await s.run(Tasks.use((t) => Effect.succeed(t.noteFor(task?.id ?? ""))))
    expect(note?.steps.map((x) => x.target.split(/[\\/]/).pop())).toEqual([
      "f6.txt",
      "f5.txt",
      "f4.txt",
      "f3.txt",
      "f2.txt",
    ])
    expect(note?.more).toBe(2)
  })
})

describe("depth of a task and the note for a task of another computer", () => {
  const create = (s: Awaited<ReturnType<typeof setup>>, extra: object = {}) =>
    s.run(
      Tasks.use((t) =>
        t.create({
          agentId: s.agent("Ada").id,
          prompt: "p",
          source: "chat",
          sourceId: s.agent("Ada").id,
          ...extra,
        }),
      ),
    )

  test("a task has depth 0; a part and a retry keep the depth of the task that made them", async () => {
    const s = await setup()
    const root = await create(s)
    expect(await s.depth(root)).toBe(0)
    const deep = await create(s, { depth: 5 })
    expect(await s.depth(deep)).toBe(5)
    const part = await create(s, { parentId: deep.id })
    expect(await s.depth(part)).toBe(5)
    const again = await create(s, { retryOf: deep.id })
    expect(await s.depth(again)).toBe(5)
    // A depth that is given wins.
    const sent = await create(s, { retryOf: deep.id, depth: 6 })
    expect(await s.depth(sent)).toBe(6)
  })

  test("a request of a linked device gets the note with no list, naming this computer", async () => {
    const s = await setup()
    const write = { name: "write_file", args: { path: "linked.txt", content: "data" } }
    await s.send("Ada", `FAILAFTER CALL write_file ${JSON.stringify(write.args)}`)
    await s.quiet()
    const [failed] = await s.tasks()
    const answer = await s.run(
      Tasks.use((t) => t.retry(failed?.id ?? "", { awayFrom: "MacBook 2" })),
    )
    expect(answer.started).toBe(false)
    if (!answer.started) expect(answer.note).toEqual({ computer: "MacBook 2", steps: [], more: 0 })
    expect(await s.tasks()).toHaveLength(1)
  })

  test("a linked device gets no note when the first try changed nothing", async () => {
    const s = await setup()
    writeFileSync(join(s.agent("Ada").workspace, "linked-read.txt"), "text")
    await s.send("Ada", `FAILAFTER CALL read_file ${JSON.stringify({ path: "linked-read.txt" })}`)
    await s.quiet()
    const [failed] = await s.tasks()
    const answer = await s.run(
      Tasks.use((t) => t.retry(failed?.id ?? "", { awayFrom: "MacBook 2" })),
    )
    expect(answer.started).toBe(true)
  })

  test("a task of the other computer of a sync pair always gets the note, with no list", async () => {
    const s = await setup()
    await s.send("Ada", "hello")
    await s.quiet()
    const [done] = await s.tasks()
    s.t.runtime.runSync(
      Database.use((db) =>
        Effect.sync(() => {
          db.run("UPDATE task SET origin = 'other', state = 'failed' WHERE id = ?", done?.id ?? "")
        }),
      ),
    )
    const note = await s.run(Tasks.use((t) => Effect.succeed(t.noteFor(done?.id ?? ""))))
    expect(note).toEqual({ computer: "", steps: [], more: 0 })
  })
})

describe("retry from a linked device (spec 012)", () => {
  test("chat.retry gives the note with no list that names this computer; Retry anyway starts a task", async () => {
    const s = await setup()
    await s.send(
      "Ada",
      `FAILAFTER CALL run_command ${JSON.stringify({ command: "echo linked > linked.txt" })}`,
    )
    await s.quiet()
    const failed = await s.reply("Ada")
    const as = { id: "device-1", name: "MacBook 1" }
    const input = { agentId: s.agent("Ada").id, messageId: failed?.id }
    const asked = await runRequest(s.t.runtime, "chat.retry", input, as)
    expect(asked.ok).toBe(true)
    if (asked.ok) {
      const result = asked.value as {
        started: boolean
        note: { computer: string; steps: unknown[] }
      }
      expect(result.started).toBe(false)
      // The steps are on this computer, which the client is not: no list, and this computer's name.
      expect(result.note.steps).toEqual([])
      expect(result.note.computer).toBe("Test computer")
    }
    expect(await s.tasks()).toHaveLength(1)
    const sure = await runRequest(s.t.runtime, "chat.retry", { ...input, confirmed: true }, as)
    expect(sure).toEqual({ ok: true, value: { started: true } })
    await s.quiet()
    expect(await s.tasks()).toHaveLength(2)
  })

  test("a linked device cannot call tasks.retry: the list of requests did not grow", async () => {
    const s = await setup()
    const refused = await runRequest(
      s.t.runtime,
      "tasks.retry",
      { id: "x" },
      { id: "device-1", name: "MacBook 1" },
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe("not_allowed")
  })
})

describe("the steps in the action log (spec 007)", () => {
  test("a step of a file says whether it read or wrote; the level decided; no outside content", async () => {
    const s = await setup()
    writeFileSync(join(s.agent("Ada").workspace, "r.txt"), "text")
    const calls = [
      { name: "write_file", args: { path: "w.txt", content: "x" } },
      { name: "read_file", args: { path: "r.txt" } },
    ]
    await s.send("Ada", `CALLS ${JSON.stringify(calls)}`)
    await s.quiet()
    const entries = await s.run(ActionLog.use((l) => l.list()))
    const files = entries.filter((e) => e.kind === "file").reverse()
    expect(files).toMatchObject([
      { access: "write", decidedBy: "level", result: "ran", outside: null, agentName: "Ada" },
      { access: "read", decidedBy: "level", result: "ran", outside: null },
    ])
    expect(files[0]?.target).toContain("w.txt")
    expect(files.every((e) => e.taskId !== null)).toBe(true)
  })

  test("a step of a task that another agent asked for names that agent as outside content", async () => {
    const s = await setup(["Ada", "Bo"])
    const write = { name: "write_file", args: { path: "from-ada.txt", content: "x" } }
    const send = {
      name: "send_message",
      args: { to: "Bo", text: `CALLS ${JSON.stringify([write])}` },
    }
    await s.send("Ada", `CALLS ${JSON.stringify([send])}`)
    await s.quiet()
    const entries = await s.run(ActionLog.use((l) => l.list()))
    const step = entries.find((e) => e.kind === "file" && e.target.includes("from-ada.txt"))
    expect(step).toMatchObject({
      agentName: "Bo",
      access: "write",
      result: "ran",
      outside: { kind: "agent", name: "Ada" },
    })
  })

  test("the steps of a task that the retry note reads hold no step of another kind", async () => {
    const s = await setup()
    await s.send("Ada", `CALLS ${JSON.stringify([{ name: "save_memory", args: { text: "x" } }])}`)
    await s.quiet()
    const [task] = await s.tasks()
    const logged = await s.run(Tasks.use((t) => Effect.succeed(t.steps(task?.id ?? ""))))
    expect(logged).toEqual([])
  })
})
