import { afterAll, describe, expect, test } from "bun:test"
import type { KeepAwakeMode } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { KeepAwake } from "./KeepAwake.ts"
import { Providers } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { testRuntime } from "./testing.ts"

const sse = (chunks: { delay: number; text: string }[]) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks) {
          await Bun.sleep(c.delay)
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: c.text } }] })}\n\n`,
            ),
          )
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { content: string }[] }
    const last = body.messages.at(-1)?.content ?? ""
    if (last.includes("SLOW"))
      return sse(Array.from({ length: 200 }, () => ({ delay: 30, text: "tick " })))
    return sse([{ delay: 0, text: "Done." }])
  },
})
afterAll(() => server.stop())

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-keep-awake-test",
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
      }),
    ),
  )
  const mode = (keepAwake: KeepAwakeMode) => run(SettingsStore.use((s) => s.update({ keepAwake })))
  const state = () => run(KeepAwake.use((k) => k.state))
  const routine = (enabled = true) =>
    run(
      Routines.use((r) =>
        r.create(
          {
            serverId: local.id,
            agentId: agent.id,
            name: "Check",
            prompt: "Look.",
            schedule: { kind: "every", minutes: 60, from: Date.now() },
            place: { kind: "agent" },
          },
          { paused: !enabled },
        ),
      ),
    )
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const stop = () => run(Chat.use((c) => c.stop(agent.id)))
  return { ...t, run, agent, local, mode, state, routine, send, stop }
}

describe("keep the computer awake", () => {
  test("the default holds nothing while the app is idle", async () => {
    const s = await setup()
    expect(s.shell.awake).toBe(false)
    expect(await s.state()).toMatchObject({ mode: "working", reason: null, working: 0 })
  })

  test("an agent that works holds the computer, and the hold ends with the work", async () => {
    const s = await setup()
    await s.send("SLOW work")
    await until(() => s.shell.awake)
    expect(await s.state()).toMatchObject({ reason: "working", working: 1 })
    await s.stop()
    await until(() => !s.shell.awake)
    expect(s.shell.awakeLog).toEqual(["on", "off"])
  })

  test("a turn that ends by itself lets the computer go", async () => {
    const s = await setup()
    await s.send("quick")
    await until(() => s.shell.awakeLog.includes("on"))
    await until(() => !s.shell.awake)
    expect(await s.state()).toMatchObject({ reason: null, working: 0 })
  })

  test("off holds nothing while an agent works", async () => {
    const s = await setup()
    await s.mode("off")
    await s.send("SLOW work")
    await until(async () => (await s.state()).working === 1)
    expect(s.shell.awake).toBe(false)
    expect(s.shell.awakeLog).toEqual([])
    await s.stop()
  })

  test("turning it off while an agent works lets the computer go at once", async () => {
    const s = await setup()
    await s.send("SLOW work")
    await until(() => s.shell.awake)
    await s.mode("off")
    expect(s.shell.awake).toBe(false)
    // Turning it on again while the agent still works holds it again.
    await s.mode("working")
    expect(s.shell.awake).toBe(true)
    await s.stop()
  })

  test("a routine that is on does not hold the computer in the mode that holds for work", async () => {
    const s = await setup()
    await s.routine()
    expect(s.shell.awake).toBe(false)
    expect(await s.state()).toMatchObject({ reason: null, routines: 1 })
  })

  test("a routine that is on holds the computer in the mode routines, on power", async () => {
    const s = await setup()
    await s.mode("routines")
    expect(s.shell.awake).toBe(false)
    await s.routine()
    expect(s.shell.awake).toBe(true)
    expect(await s.state()).toMatchObject({ reason: "routines", routines: 1 })
  })

  test("a routine that is paused does not hold, and resuming it does", async () => {
    const s = await setup()
    await s.mode("routines")
    const r = await s.routine(false)
    expect(s.shell.awake).toBe(false)
    await s.run(Routines.use((x) => x.update(r.id, { enabled: true })))
    expect(s.shell.awake).toBe(true)
    await s.run(Routines.use((x) => x.update(r.id, { enabled: false })))
    expect(s.shell.awake).toBe(false)
  })

  test("the last routine that is removed lets the computer go", async () => {
    const s = await setup()
    await s.mode("routines")
    const r = await s.routine()
    expect(s.shell.awake).toBe(true)
    await s.run(Routines.use((x) => x.remove(r.id)))
    expect(s.shell.awake).toBe(false)
  })

  test("on battery a routine lets go, and power holds it again", async () => {
    const s = await setup()
    await s.mode("routines")
    await s.routine()
    expect(s.shell.awake).toBe(true)
    s.shell.battery = true
    s.shell.powerChanged()
    expect(s.shell.awake).toBe(false)
    expect(await s.state()).toMatchObject({ reason: null, onBattery: true })
    s.shell.battery = false
    s.shell.powerChanged()
    expect(s.shell.awake).toBe(true)
  })

  test("on battery the work that runs still holds the computer", async () => {
    const s = await setup()
    await s.mode("routines")
    s.shell.battery = true
    s.shell.powerChanged()
    await s.send("SLOW work")
    await until(() => s.shell.awake)
    expect(await s.state()).toMatchObject({ reason: "working", onBattery: true })
    await s.stop()
  })

  test("the windows hear of a change only when the state changed", async () => {
    const s = await setup()
    await s.mode("routines")
    const heard = () => s.events.filter((e) => e.event === "keepAwake.changed").length
    const before = heard()
    // The power source reports the same value again: nothing new for the windows.
    s.shell.powerChanged()
    s.shell.powerChanged()
    expect(heard()).toBe(before)
    await s.routine()
    expect(heard()).toBe(before + 1)
  })
})
