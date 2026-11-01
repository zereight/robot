import { afterAll, describe, expect, test } from "bun:test"
import { Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

const GOOD_KEY = "sk-test-good"

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    const auth = req.headers.get("authorization") ?? `Bearer ${req.headers.get("x-api-key")}`
    if (auth !== `Bearer ${GOOD_KEY}`)
      return Response.json({ error: { message: "bad key" } }, { status: 401 })
    if (url.pathname === "/v1/models")
      return Response.json({ data: [{ id: "model-b" }, { id: "o3", display_name: "O3" }] })
    return new Response("not found", { status: 404 })
  },
})
afterAll(() => server.stop())
const baseUrl = `http://127.0.0.1:${server.port}/v1`

const code = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

describe("Providers", () => {
  test("connect checks the key first and refuses a bad one", async () => {
    const { runtime } = testRuntime()
    const exit = await runtime.runPromiseExit(
      Providers.use((p) => p.connect({ kind: "openai", name: "Work", baseUrl, apiKey: "wrong" })),
    )
    expect(code(exit)).toBe("provider_auth")
    expect(await runtime.runPromise(Providers.use((p) => p.list))).toHaveLength(0)
  })

  test("connect stores the account; the key is only in the secret store", async () => {
    const { runtime } = testRuntime()
    const account = await runtime.runPromise(
      Providers.use((p) => p.connect({ kind: "openai", name: "Work", baseUrl, apiKey: GOOD_KEY })),
    )
    expect(account.connected).toBe(true)
    expect(JSON.stringify(account)).not.toContain(GOOD_KEY)
    const models = await runtime.runPromise(Providers.use((p) => p.models(account.id)))
    expect(models.map((m) => m.id)).toEqual(["model-b", "o3"])
    expect(models.find((m) => m.id === "o3")?.efforts).toEqual(["low", "medium", "high"])
  })

  test("disconnect removes the key; agents that use the account go offline", async () => {
    const { runtime } = testRuntime()
    const account = await runtime.runPromise(
      Providers.use((p) => p.connect({ kind: "openai", name: "Work", baseUrl, apiKey: GOOD_KEY })),
    )
    const local = await runtime.runPromise(Servers.use((s) => s.local))
    const agent = await runtime.runPromise(
      Agents.use((a) =>
        a.create({
          serverId: local.id,
          name: "Ada",
          role: "",
          instructions: "",
          model: { accountId: account.id, model: "o3", effort: "low" },
        }),
      ),
    )
    expect(agent.state).toBe("idle")
    await runtime.runPromise(Providers.use((p) => p.disconnect(account.id)))
    expect((await runtime.runPromise(Agents.use((a) => a.get(agent.id)))).state).toBe("offline")
    expect((await runtime.runPromise(Providers.use((p) => p.list)))[0]?.connected).toBe(false)
    expect(code(await runtime.runPromiseExit(Providers.use((p) => p.connection(account.id))))).toBe(
      "provider_not_connected",
    )
  })

  test("an unreachable provider gives a clear error", async () => {
    const { runtime } = testRuntime()
    const exit = await runtime.runPromiseExit(
      Providers.use((p) =>
        p.connect({ kind: "custom", name: "Gone", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }),
      ),
    )
    expect(code(exit)).toBe("provider_unreachable")
  })
})
