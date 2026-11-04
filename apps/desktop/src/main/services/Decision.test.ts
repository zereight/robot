import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DECISION_MODEL_DEFAULT } from "@robot/shared"
import { Effect } from "effect"
import { Decision } from "./Decision.ts"
import { appendLog, LOG_MAX_BYTES } from "./logs.ts"
import { SettingsStore } from "./Settings.ts"
import { testRuntime } from "./testing.ts"

const GOOD_KEY = "sk-or-test-good-key"

interface Seen {
  auth: string | null
  path: string
  body: Record<string, unknown>
}
const seen: Seen[] = []
/** What the fake service answers next. Set by each test. */
let next: () => Promise<Response> | Response = () => Response.json({})

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    seen.push({
      auth: req.headers.get("authorization"),
      path: url.pathname,
      body: (await req.json().catch(() => ({}))) as Record<string, unknown>,
    })
    if (req.headers.get("authorization") !== `Bearer ${GOOD_KEY}`)
      return Response.json({ error: { code: 401, message: "no" } }, { status: 401 })
    return next()
  },
})
afterAll(() => server.stop(true))

const answer = (choice: string, probabilities: Record<string, number>) =>
  Response.json({ answers: { pick: { type: "choice", choice, confidence: 0.9, probabilities } } })

const setup = async (options: { on?: boolean; key?: string | null; model?: string } = {}) => {
  const t = testRuntime({ decisionUrl: `http://127.0.0.1:${server.port}` })
  const run = t.runtime.runPromise
  if (options.on !== false)
    await run(
      SettingsStore.use((s) =>
        s.update({
          decisionModel: "openrouter",
          ...(options.model !== undefined ? { decisionModelName: options.model } : {}),
        }),
      ),
    )
  if (options.key !== null)
    await run(Decision.use((d) => d.keys({ openrouter: options.key ?? GOOD_KEY })))
  seen.length = 0
  return { ...t, run }
}

const input = {
  channelName: "Launch",
  topic: "Ship it",
  recent: [],
  job: "Fix the login crash",
  members: [
    { name: "Ada", role: "Writes code" },
    { name: "Ben", role: "Writes docs" },
  ],
}

describe("Decision", () => {
  test("off by default: nothing is sent", async () => {
    const s = await setup({ on: false })
    expect(await s.run(Decision.use((d) => d.ready))).toBe(false)
    const r = await s.run(Decision.use((d) => d.pick(input)))
    expect(r).toMatchObject({ index: null, reason: "not_set_up" })
    expect(seen).toHaveLength(0)
  })

  test("the page learns only whether a key is saved; a save names the keys it changes", async () => {
    const s = await setup({ key: null })
    expect(await s.run(Decision.use((d) => d.status))).toEqual({ keys: { openrouter: false } })
    const saved = await s.run(Decision.use((d) => d.keys({ openrouter: GOOD_KEY })))
    expect(saved).toEqual({ keys: { openrouter: true } })
    expect(JSON.stringify(saved)).not.toContain(GOOD_KEY)
    // A save that names no key leaves it.
    expect(await s.run(Decision.use((d) => d.keys({})))).toEqual({ keys: { openrouter: true } })
    expect(await s.run(Decision.use((d) => d.keys({ openrouter: null })))).toEqual({
      keys: { openrouter: false },
    })
    const empty = await s.run(Decision.use((d) => d.keys({ openrouter: "   " })).pipe(Effect.flip))
    expect(empty.code).toBe("invalid_input")
  })

  test("a choice that lacks its key or its model asks nobody", async () => {
    const noKey = await setup({ key: null })
    expect(await noKey.run(Decision.use((d) => d.ready))).toBe(false)
    expect(await noKey.run(Decision.use((d) => d.pick(input)))).toMatchObject({
      reason: "not_set_up",
    })
    const noModel = await setup({ model: "  " })
    expect(await noModel.run(Decision.use((d) => d.ready))).toBe(false)
    expect(seen).toHaveLength(0)
  })

  test("a request goes to the Decisions API with the key, the model and one Choice question", async () => {
    next = () => answer("member_2", { member_1: 0.1, member_2: 0.85, none: 0.05 })
    const s = await setup()
    const r = await s.run(Decision.use((d) => d.pick(input)))
    expect(r).toMatchObject({ index: 1, probability: 0.85 })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.path).toBe("/api/alpha/decisions")
    expect(seen[0]?.auth).toBe(`Bearer ${GOOD_KEY}`)
    expect(seen[0]?.body.model).toBe(DECISION_MODEL_DEFAULT)
    expect(Object.keys((seen[0]?.body.questions as Record<string, unknown>) ?? {})).toEqual([
      "pick",
    ])
  })

  test("text that looks like a key does not go out", async () => {
    next = () => answer("member_1", { member_1: 0.9, member_2: 0.1, none: 0 })
    const s = await setup()
    await s.run(
      Decision.use((d) =>
        d.pick({
          ...input,
          job: "Use sk-abcdefghijklmnopqrstuvwxyz123456 to deploy",
          recent: [{ from: "user", text: "token ghp_abcdefghijklmnopqrstuvwxyz12345" }],
        }),
      ),
    )
    const sent = JSON.stringify(seen[0]?.body)
    expect(sent).not.toContain("sk-abcdefghijklmnop")
    expect(sent).not.toContain("ghp_abcdefghij")
    expect(sent).toContain("[redacted]")
  })

  test("a wrong key gives the code of the service", async () => {
    const s = await setup({ key: "wrong" })
    expect(await s.run(Decision.use((d) => d.pick(input)))).toMatchObject({
      index: null,
      reason: "service_error",
      code: 401,
    })
  })

  test("an unsure answer, a body that cannot be read, and no single member give no pick", async () => {
    const s = await setup()
    next = () => answer("member_1", { member_1: 0.5, member_2: 0.3, none: 0.2 })
    expect(await s.run(Decision.use((d) => d.pick(input)))).toMatchObject({
      reason: "below_threshold",
    })
    next = () => answer("none", { member_1: 0.1, member_2: 0.1, none: 0.8 })
    expect(await s.run(Decision.use((d) => d.pick(input)))).toMatchObject({
      reason: "no_single_member",
    })
    next = () => new Response("not json", { status: 200 })
    expect(await s.run(Decision.use((d) => d.pick(input)))).toMatchObject({
      reason: "unreadable",
    })
  })

  test("a late answer is a timeout after 3 seconds, and a closed service is a network error", async () => {
    next = async () => {
      await Bun.sleep(3600)
      return answer("member_1", { member_1: 0.9, member_2: 0.1, none: 0 })
    }
    const s = await setup()
    const late = await s.run(Decision.use((d) => d.pick(input)))
    expect(late).toMatchObject({ index: null, reason: "timeout" })
    expect(late.ms).toBeGreaterThanOrEqual(2900)
    expect(late.ms).toBeLessThan(3500)

    const closed = testRuntime({ decisionUrl: "http://127.0.0.1:1" })
    await closed.runtime.runPromise(
      SettingsStore.use((x) => x.update({ decisionModel: "openrouter" })),
    )
    await closed.runtime.runPromise(Decision.use((d) => d.keys({ openrouter: GOOD_KEY })))
    expect(await closed.runtime.runPromise(Decision.use((d) => d.pick(input)))).toMatchObject({
      reason: "network_error",
    })
  }, 15_000)

  test("the test sends three made-up members and tells who was chosen, or why not", async () => {
    next = () => answer("member_1", { member_1: 0.92, member_2: 0.05, none: 0.03 })
    const s = await setup()
    const ok = await s.run(Decision.use((d) => d.test))
    expect(ok).toMatchObject({ ok: true, member: "Ada", probability: 0.92 })
    const questions = (seen[0]?.body.questions ?? {}) as {
      pick?: { criteria: Record<string, string> }
    }
    const members = questions.pick?.criteria ?? {}
    expect(Object.keys(members)).toEqual(["member_1", "member_2", "member_3", "none"])

    const off = await setup({ on: false })
    expect(await off.run(Decision.use((d) => d.test))).toMatchObject({
      ok: false,
      reason: "not_set_up",
    })
    const wrong = await setup({ key: "wrong" })
    expect(await wrong.run(Decision.use((d) => d.test))).toMatchObject({
      ok: false,
      reason: "service_error",
      code: 401,
    })
  })
})

describe("logs", () => {
  test("a line holds the time and the entry; the oldest lines go first at the size limit", () => {
    const t = testRuntime()
    appendLog(t.dataDir, "channels", { event: "one", n: 1 })
    const file = join(t.dataDir, "logs", "channels.log")
    const first = JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>
    expect(first).toMatchObject({ event: "one", n: 1 })
    expect(typeof first.time).toBe("string")

    for (let i = 0; i < 400; i++)
      appendLog(t.dataDir, "channels", { event: "line", n: i, pad: "x".repeat(1000) }, 64 * 1024)
    const text = readFileSync(file, "utf8")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024)
    const lines = text.trim().split("\n")
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({ n: 399 })
    expect(text).not.toContain('"event":"one"')
    expect(LOG_MAX_BYTES).toBeGreaterThan(0)
  })
})
