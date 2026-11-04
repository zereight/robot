import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { type ChannelMessage, GO_ON_MESSAGE, messageText } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { holdClock } from "./ModelHolds.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { testRuntime } from "./testing.ts"

// A part of a channel job follows the backup model like a chat does (spec 006, 004).

interface Seen {
  readonly model: string
  readonly messages: { role: string; content: string | null }[]
}
const seen: Seen[] = []
const callsOf = (model: string) => seen.filter((s) => s.model === model)

const sse = (data: unknown[]) =>
  new Response(
    data.map((d) => `data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
const text = (content: string) => ({ choices: [{ delta: { content } }] })

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "main-m" }] })
    const body = (await req.json()) as Seen & { tools?: unknown }
    seen.push({ model: body.model, messages: body.messages })
    const asked = [...body.messages]
      .reverse()
      .find((m) => m.role === "user" && !String(m.content).includes(GO_ON_MESSAGE))
    const request = String(asked?.content ?? "")
    const hasToolResult = body.messages.some((m) => m.role === "tool")
    const goOn = String(body.messages.at(-1)?.content ?? "").includes(GO_ON_MESSAGE)
    if (body.model === "main-m") {
      const limit = () =>
        Response.json(
          { error: { message: "You have hit your usage limit." } },
          { status: 429, headers: { "retry-after": "7200" } },
        )
      if (request.includes("LIMIT")) return limit()
      if (request.includes("STEPS")) {
        if (hasToolResult) return limit()
        return sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: {
                        name: "save_memory",
                        arguments: JSON.stringify({ text: "The step ran once" }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          "[DONE]",
        ])
      }
      return sse([text("main answers"), "[DONE]"])
    }
    return sse([text(goOn ? "backup goes on" : "backup answers"), "[DONE]"])
  },
})
afterAll(() => server.stop(true))

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(15)
  }
  throw new Error("timed out")
}

afterEach(() => {
  holdClock.now = () => Date.now()
  seen.length = 0
})

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const connect = (name: string) =>
    run(
      Providers.use((p) =>
        p.connect({
          kind: "custom",
          name,
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: `sk-${name}`,
        }),
      ),
    )
  const mainAccount = await connect("Main")
  const backupAccount = await connect("Backup")
  const local = await run(Servers.use((s) => s.local))
  const make = (name: string, backup: boolean) =>
    run(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name,
          role: "",
          instructions: `You are ${name}.`,
          model: { accountId: mainAccount.id, model: "main-m", effort: null },
          ...(backup
            ? { backupModel: { accountId: backupAccount.id, model: "backup-m", effort: null } }
            : {}),
        }),
      ),
    )
  const [lead, bo] = await Promise.all([make("Lia", false), make("Bo", true)])
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId: local.id,
        name: "Launch",
        topic: "Ship it",
        memberIds: [lead.id, bo.id],
        leadId: lead.id,
      }),
    ),
  )
  const history = () => run(Channels.use((c) => c.history(channel.id)))
  const send = (message: string) => run(Channels.use((c) => c.send(channel.id, message)))
  const idle = () =>
    until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      return all.length > 0 && all.every((x) => !["queued", "running"].includes(x.state))
    })
  const replyOfBo = async () =>
    (await history()).filter((m: ChannelMessage) => m.agentId === bo.id).at(-1)
  return { run, local, bo, history, send, idle, replyOfBo }
}

describe("backup model in a channel (spec 006)", () => {
  test("a part that meets the limit goes on with the backup model, with the line", async () => {
    const s = await setup()
    await s.send("@bo LIMIT job")
    await s.idle()
    const reply = await s.replyOfBo()
    expect(reply?.status).toBe("done")
    expect(messageText(reply as never)).toBe("backup answers")
    expect(reply?.model).toBe("backup-m")
    const line = reply?.parts.find((p) => p.kind === "note" && p.note === "backup_goes_on")
    expect(line).toMatchObject({ main: "main-m", backup: "backup-m" })
    const agent = await s.run(Agents.use((a) => a.get(s.bo.id)))
    expect(agent.hold?.model.model).toBe("backup-m")
    const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
    expect(tasks.every((t) => t.state === "done")).toBe(true)
  })

  test("while the hold lasts the next part uses the backup at once", async () => {
    const s = await setup()
    await s.send("@bo LIMIT job")
    await s.idle()
    const mainCalls = callsOf("main-m").length
    await s.send("@bo second job")
    await s.idle()
    expect(messageText((await s.replyOfBo()) as never)).toBe("backup answers")
    expect(callsOf("main-m")).toHaveLength(mainCalls)
  })

  test("a part that ran a step gets the work so far and the go-on message", async () => {
    const s = await setup()
    await s.send("@bo STEPS job")
    await s.idle()
    const reply = await s.replyOfBo()
    expect(messageText(reply as never)).toContain("backup goes on")
    const [call] = callsOf("backup-m")
    expect(String(call?.messages.at(-1)?.content)).toContain(GO_ON_MESSAGE)
    expect(call?.messages.filter((m) => m.role === "tool")).toHaveLength(1)
  })
})
