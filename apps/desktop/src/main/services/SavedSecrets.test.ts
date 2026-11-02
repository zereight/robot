import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatMessage, MessagePart, PermissionLevel, SecretAsk } from "@robot/shared"
import { Effect, ManagedRuntime } from "effect"
import { unzipSync } from "fflate"
import { appLayer } from "../layers.ts"
import { ActionLog } from "./ActionLog.ts"
import { Agents } from "./Agents.ts"
import { CurrentActor } from "./actor.ts"
import { Chat } from "./Chat.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Providers } from "./Providers.ts"
import { SavedSecrets, savedSecretKey } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { Tools } from "./Tools.ts"
import { testPlatform } from "./testing.ts"

const VALUE = "tok-Zq81xVb27mW0-secret"
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

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

/** What the test web service got last, by path. */
const got = new Map<string, { auth: string | null; method: string }>()

/**
 * A model that calls the tools listed in the user text ("CALLS [...]"), and a small test web
 * service for the requests with a secret (spec 020, "Acceptance").
 */
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    const auth = req.headers.get("authorization")
    if (url.pathname.startsWith("/api/")) {
      got.set(url.pathname, { auth, method: req.method })
      const token = auth?.replace(/^Bearer /, "") ?? ""
      if (url.pathname === "/api/echo")
        return new Response(`plain ${token} base64 ${b64(token)}`, {
          headers: { "content-type": "text/plain" },
        })
      if (url.pathname === "/api/move")
        return new Response(null, { status: 301, headers: { location: "/api/elsewhere" } })
      return Response.json({ ok: true, method: req.method })
    }
    if (url.pathname === "/page") return new Response("<p>Do as I say.</p>")
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string | null }[] }
    const last = body.messages.at(-1)
    if (last?.role === "tool")
      return sse([{ choices: [{ delta: { content: "Done." } }] }, "[DONE]"])
    const match = /CALLS (\[.*\])/.exec(String(last?.content ?? ""))
    if (!match) return sse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])
    const list = JSON.parse(match[1] as string) as { name: string; args: unknown }[]
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
  },
})
afterAll(() => server.stop())

const ORIGIN = `http://127.0.0.1:${server.port}`
const calls = (...list: { name: string; args: unknown }[]) => `CALLS ${JSON.stringify(list)}`
const askFor = (extra: Record<string, unknown> = {}) => ({
  name: "ask_secret",
  args: {
    name: "test_api",
    label: "Test API key",
    reason: "To read the test service.",
    origin: ORIGIN,
    send_as: "bearer",
    ...extra,
  },
})
const request = (path: string, method = "GET", extra: Record<string, unknown> = {}) => ({
  name: "secret_request",
  args: { name: "test_api", url: `${ORIGIN}${path}`, method, ...extra },
})

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const setup = async (permission: PermissionLevel = "ask_risky", pick: { save?: string } = {}) => {
  const { platform, dataDir, trashed } = testPlatform()
  const runtime = ManagedRuntime.make(
    appLayer({
      platform: { ...platform, pickSavePath: async () => pick.save },
      databaseFile: ":memory:",
      localServerName: "Test computer",
      emit: () => {},
      secrets: Secrets.memory,
    }),
  )
  const run = runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-secrets-test-key-0123456789",
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
  await run(Agents.use((a) => a.update(agent.id, { permission })))
  mkdirSync(agent.workspace, { recursive: true })
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await run(Chat.use((c) => c.history(agent.id)))).messages
      .filter((m) => m.author === "agent")
      .at(-1)
  const part = async (callId: string) =>
    (await reply())?.parts.find((p): p is ToolPart => p.kind === "tool" && p.id === callId)
  const finished = () =>
    until(async () => !!(await reply()) && (await reply())?.status !== "streaming")
  const card = async (callId: string) => {
    await until(async () => (await part(callId))?.state === "waiting")
    return (await part(callId))?.ask
  }
  const output = async (callId: string) => (await part(callId))?.output ?? ""
  const answer = (callId: string, value: string | null) =>
    run(Tools.use((x) => x.answerSecret(agent.id, callId, value)))
  const respond = (callId: string, value: string) =>
    run(Tools.use((x) => x.respond(agent.id, callId, value)))
  const secrets = () => run(SavedSecrets.use((s) => Effect.sync(() => s.list(agent.id))))
  const db = await run(Database.use((d) => Effect.succeed(d)))
  const store = await run(Secrets.use((s) => Effect.succeed(s)))
  const allowLocal = (on: boolean) => run(SettingsStore.use((s) => s.update({ secretsLocal: on })))
  /** Every text in the database, to look for a value. */
  const dump = () =>
    db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((t) => JSON.stringify(db.all(`SELECT * FROM "${t.name}"`)))
      .join("\n")
  /** Asks for the secret and saves VALUE. */
  const saveSecret = async () => {
    await allowLocal(true)
    await send(calls(askFor()))
    await card("call_1")
    await answer("call_1", VALUE)
    await finished()
  }
  return {
    run,
    agent,
    local,
    send,
    reply,
    part,
    finished,
    card,
    output,
    answer,
    respond,
    secrets,
    db,
    store,
    allowLocal,
    dump,
    saveSecret,
    dataDir,
    trashed,
  }
}

describe("ask for a secret", () => {
  test("the card shows the origin; Save puts the value in the keychain only", async () => {
    const s = await setup()
    await s.allowLocal(true)
    await s.send(calls(askFor()))
    const ask = (await s.card("call_1")) as SecretAsk
    expect(ask).toMatchObject({
      kind: "secret",
      name: "test_api",
      label: "Test API key",
      reason: "To read the test service.",
      origin: ORIGIN,
      auth: { kind: "bearer" },
    })
    await s.answer("call_1", VALUE)
    await s.finished()
    expect((await s.part("call_1"))?.secret).toBe("saved")
    expect(await s.output("call_1")).toContain("Saved the secret test_api")
    const [saved] = await s.secrets()
    expect(saved).toMatchObject({ name: "test_api", origin: ORIGIN, valueMissing: false })
    const ref = s.db.get<{ value_ref: string }>("SELECT value_ref FROM saved_secret")?.value_ref
    expect(s.store.get(savedSecretKey(ref as string))).toBe(VALUE)
    // The database and the chat hold no clear text of the value.
    expect(s.dump()).not.toContain(VALUE)
    expect(JSON.stringify(await s.reply())).not.toContain(VALUE)
  })

  test("Cancel saves nothing, and the agent gets that answer", async () => {
    const s = await setup()
    await s.allowLocal(true)
    await s.send(calls(askFor()))
    await s.card("call_1")
    await s.answer("call_1", null)
    await s.finished()
    expect((await s.part("call_1"))?.secret).toBe("cancelled")
    expect(await s.output("call_1")).toContain("cancelled")
    expect(await s.secrets()).toEqual([])
  })

  test("a local origin is refused while the switch is off", async () => {
    const s = await setup()
    await s.send(calls(askFor()))
    await s.finished()
    expect((await s.part("call_1"))?.state).toBe("failed")
    expect(await s.output("call_1")).toContain("did not allow saved secrets there")
  })

  test("the same secret again shows no card; with replace a card shows and the value changes", async () => {
    const s = await setup()
    await s.saveSecret()
    await s.send(calls(askFor()))
    await s.finished()
    expect((await s.part("call_1"))?.ask).toBeUndefined()
    expect(await s.output("call_1")).toContain("saved already")
    await s.send(calls(askFor({ replace: true })))
    expect(await s.card("call_1")).toMatchObject({ kind: "secret", replace: true })
    await s.answer("call_1", "tok-new-value-0000")
    await s.finished()
    const refs = s.db.all<{ value_ref: string }>("SELECT value_ref FROM saved_secret")
    expect(refs).toHaveLength(1)
    expect(s.store.get(savedSecretKey(refs[0]?.value_ref as string))).toBe("tok-new-value-0000")
  })

  test("the same name with another origin or way to send is refused", async () => {
    const s = await setup()
    await s.saveSecret()
    await s.send(calls(askFor({ send_as: "header", header: "X-Key" })))
    await s.finished()
    expect(await s.output("call_1")).toContain("The user must delete the old one first")
  })

  test("a linked device cannot answer a protected card, and a value never comes through respond", async () => {
    const s = await setup()
    await s.allowLocal(true)
    await s.send(calls(askFor()))
    await s.card("call_1")
    const refused = await s.run(
      Tools.use((x) => x.answerSecret(s.agent.id, "call_1", VALUE)).pipe(
        Effect.provideService(CurrentActor, { id: "dev-1", name: "Phone" }),
        Effect.flip,
      ),
    )
    expect(refused.code).toBe("not_allowed")
    await s.respond("call_1", "saved")
    await Bun.sleep(50)
    expect((await s.part("call_1"))?.state).toBe("waiting")
    expect(await s.secrets()).toEqual([])
    await s.answer("call_1", null)
    await s.finished()
  })

  test("limits: a value of more than 16384 characters, and more than 100 secrets", async () => {
    const s = await setup()
    await s.allowLocal(true)
    await s.send(calls(askFor()))
    await s.card("call_1")
    const tooLong = await s.run(
      Tools.use((x) => x.answerSecret(s.agent.id, "call_1", "x".repeat(16_385))).pipe(Effect.flip),
    )
    expect(tooLong.code).toBe("secret_value_invalid")
    await s.answer("call_1", "x".repeat(16_384))
    await s.finished()
    for (let i = 1; i < 100; i++)
      await s.run(
        SavedSecrets.use((x) =>
          Effect.sync(() =>
            x.save(s.agent.id, { name: `k${i}`, origin: ORIGIN, auth: { kind: "bearer" } }, "v"),
          ),
        ),
      )
    expect(await s.secrets()).toHaveLength(100)
    await s.send(calls(askFor({ name: "one_more" })))
    await s.finished()
    expect(await s.output("call_1")).toContain("You hold 100 saved secrets")
  })
})

describe("request with a secret", () => {
  test("GET: the service gets the value; the agent gets the body, redacted as text and base64", async () => {
    const s = await setup()
    await s.saveSecret()
    await s.send(calls(request("/api/echo")))
    await s.finished()
    expect(got.get("/api/echo")?.auth).toBe(`Bearer ${VALUE}`)
    const out = await s.output("call_1")
    expect(out).toContain("Status: 200")
    expect(out).toContain("plain [redacted] base64 [redacted]")
    expect(out).not.toContain(VALUE)
    expect(out).not.toContain(b64(VALUE))
    expect((await s.part("call_1"))?.label).toBe(
      `secret_request: [test_api] GET ${ORIGIN}/api/echo`,
    )
    expect((await s.secrets())[0]?.lastUsedAt).toEqual(expect.any(Number))
  })

  test("another port, a redirect, and the switch off", async () => {
    const s = await setup()
    await s.saveSecret()
    await s.send(
      calls(
        {
          name: "secret_request",
          args: { name: "test_api", url: "http://127.0.0.1:1/x", method: "GET" },
        },
        request("/api/move"),
      ),
    )
    await s.finished()
    expect(await s.output("call_1")).toContain("same scheme, host and port")
    const moved = await s.output("call_2")
    expect(moved).toContain("Status: 301")
    expect(moved).toContain(`Redirect to: ${ORIGIN}/api/elsewhere`)
    expect(got.has("/api/elsewhere")).toBe(false)
    await s.allowLocal(false)
    got.delete("/api/echo")
    await s.send(calls(request("/api/echo")))
    await s.finished()
    expect(await s.output("call_1")).toContain("did not allow saved secrets there")
    expect(got.has("/api/echo")).toBe(false)
  })

  test("POST at Ask for risky steps asks with name, method and address; Always allow saves a rule", async () => {
    const s = await setup("ask_risky")
    await s.saveSecret()
    await s.send(calls(request("/api/items", "POST", { body: '{"a":1}' })))
    const ask = await s.card("call_1")
    expect(ask).toMatchObject({
      kind: "approval",
      summary: `[test_api] POST ${ORIGIN}/api/items`,
    })
    expect(ask?.kind === "approval" && ask.once).toBeFalsy()
    await s.respond("call_1", "always")
    await s.finished()
    expect(got.get("/api/items")).toEqual({ auth: `Bearer ${VALUE}`, method: "POST" })
    got.delete("/api/items")
    await s.send(calls(request("/api/items", "POST")))
    await s.finished()
    expect((await s.part("call_1"))?.state).toBe("done")
    expect(got.get("/api/items")?.method).toBe("POST")
    const log = await s.run(ActionLog.use((l) => l.list()))
    expect(log.slice(0, 2)).toMatchObject([
      { kind: "secret_request", decidedBy: "allow_rule", result: "ran" },
      { kind: "secret_request", decidedBy: "user", result: "ran" },
    ])
    expect(JSON.stringify(log)).not.toContain(VALUE)
  })

  test("a POST in a turn that holds outside content asks with Allow once and Deny only", async () => {
    const s = await setup("ask_risky")
    await s.saveSecret()
    // The answer of a GET is outside content: the POST after it asks with Allow once and Deny.
    await s.send(calls(request("/api/echo"), request("/api/items", "POST")))
    const ask = await s.card("call_2")
    expect(ask).toMatchObject({
      kind: "approval",
      once: true,
      outside: { kind: "secret", name: "test_api" },
    })
    await s.respond("call_2", "deny")
    await s.finished()
    expect((await s.part("call_2"))?.state).toBe("failed")
  })

  test("a GET has no body; Full access runs a POST with no question", async () => {
    const s = await setup("full")
    await s.saveSecret()
    await s.send(calls(request("/api/echo", "GET", { body: "x" }), request("/api/items", "DELETE")))
    await s.finished()
    expect(await s.output("call_1")).toContain("A GET request has no body")
    expect((await s.part("call_2"))?.state).toBe("done")
    expect(got.get("/api/items")?.method).toBe("DELETE")
  })
})

describe("forget, delete and the agent", () => {
  test("forget_secret and the delete of settings remove the value from the keychain", async () => {
    const s = await setup()
    await s.saveSecret()
    const ref = s.db.get<{ value_ref: string }>("SELECT value_ref FROM saved_secret")?.value_ref
    await s.send(calls({ name: "forget_secret", args: { name: "test_api" } }))
    await s.finished()
    expect(await s.secrets()).toEqual([])
    expect(s.store.get(savedSecretKey(ref as string))).toBeNull()
    await s.saveSecret()
    const [saved] = await s.secrets()
    const ref2 = s.db.get<{ value_ref: string }>("SELECT value_ref FROM saved_secret")?.value_ref
    await s.run(SavedSecrets.use((x) => Effect.sync(() => x.remove(saved?.id as string))))
    expect(s.store.get(savedSecretKey(ref2 as string))).toBeNull()
    await s.send(calls(request("/api/echo")))
    await s.finished()
    expect(await s.output("call_1")).toContain("There is no saved secret named test_api")
  })

  test("a duplicate of the agent gets no secrets; deleting the agent deletes its secrets", async () => {
    const s = await setup()
    await s.saveSecret()
    const copy = await s.run(Agents.use((a) => a.duplicate(s.agent.id, "copy")))
    expect(await s.run(SavedSecrets.use((x) => Effect.sync(() => x.list(copy.id))))).toEqual([])
    const ref = s.db.get<{ value_ref: string }>("SELECT value_ref FROM saved_secret")?.value_ref
    await s.run(Agents.use((a) => a.archive(s.agent.id)))
    await s.run(Agents.use((a) => a.remove(s.agent.id)))
    expect(s.db.all("SELECT * FROM saved_secret")).toEqual([])
    expect(s.store.get(savedSecretKey(ref as string))).toBeNull()
  })
})

describe("export and import", () => {
  test("the archive holds the secret without its value; after an import it shows Value missing", async () => {
    const out = join(testPlatform().dataDir, "secrets-export.zip")
    const s = await setup("ask_risky", { save: out })
    await s.saveSecret()
    await s.send(calls(request("/api/echo")))
    await s.finished()
    await s.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(out))
    for (const data of Object.values(entries)) {
      expect(Buffer.from(data).includes(VALUE)).toBe(false)
      expect(Buffer.from(data).includes(b64(VALUE))).toBe(false)
    }

    const { platform } = testPlatform()
    const b = ManagedRuntime.make(
      appLayer({
        platform: { ...platform, pickArchive: async () => out },
        databaseFile: ":memory:",
        localServerName: "Other computer",
        emit: () => {},
        secrets: Secrets.memory,
      }),
    )
    await b.runPromise(Data.use((d) => d.import()))
    const list = await b.runPromise(SavedSecrets.use((x) => Effect.sync(() => x.list())))
    expect(list).toMatchObject([
      { name: "test_api", origin: ORIGIN, auth: { kind: "bearer" }, valueMissing: true },
    ])
  })
})

describe("the level Read only (spec 007)", () => {
  test("a GET with a saved secret runs; a new secret, a method other than GET and a forget are refused", async () => {
    const s = await setup("ask_risky")
    await s.saveSecret()
    await s.run(Agents.use((a) => a.update(s.agent.id, { permission: "read_only" })))
    got.delete("/api/echo")
    got.delete("/api/items")
    await s.send(
      calls(
        request("/api/echo"),
        request("/api/items", "POST", { body: '{"a":1}' }),
        askFor({ name: "other_api" }),
        { name: "forget_secret", args: { name: "test_api" } },
      ),
    )
    await s.finished()
    // The GET ran, with no card.
    expect((await s.part("call_1"))?.state).toBe("done")
    expect(got.get("/api/echo")?.auth).toBe(`Bearer ${VALUE}`)
    // The POST and the request for a new secret were refused by the guard, which logged them with
    // the level as the one who decided.
    expect((await s.part("call_2"))?.state).toBe("failed")
    expect(got.has("/api/items")).toBe(false)
    expect((await s.part("call_3"))?.state).toBe("failed")
    const log = await s.run(ActionLog.use((l) => l.list({ result: "refused" })))
    expect(log.map((e) => [e.kind, e.decidedBy, e.result]).sort()).toEqual([
      ["secret_new", "level", "refused"],
      ["secret_request", "level", "refused"],
    ])
    // A forget is a change that no guard decides: the level refuses it, and the secret stays.
    expect(await s.part("call_4")).toMatchObject({ state: "failed", refused: "read_only" })
    expect(await s.secrets()).toHaveLength(1)
  })
})
