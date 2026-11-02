import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { checkWait, Providers } from "./Providers.ts"
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

  test.skipIf(process.platform === "win32")(
    "the check of a program that never answers delays no other provider (spec 006)",
    async () => {
      // A stand-in for a vendor program that hangs when it is asked for its version.
      const dir = mkdtempSync(join(tmpdir(), "robot-hung-"))
      const bin = join(dir, "muse")
      writeFileSync(bin, "#!/bin/sh\nsleep 5 & wait\n")
      chmodSync(bin, 0o755)
      const saved = process.env.ROBOT_MUSE_BIN
      const savedWait = checkWait.ms
      process.env.ROBOT_MUSE_BIN = bin
      checkWait.ms = 400
      try {
        const { runtime } = testRuntime()
        const api = await runtime.runPromise(
          Providers.use((p) =>
            p.connect({ kind: "openai", name: "Work", baseUrl, apiKey: GOOD_KEY }),
          ),
        )
        await runtime.runPromise(
          Database.use((db) =>
            Effect.sync(() =>
              db.run(
                "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('hung', 'muse', 'Muse', '', 2)",
              ),
            ),
          ),
        )
        const timed = async <A>(work: Promise<A>) => {
          const started = Date.now()
          const value = await work
          return { value, ms: Date.now() - started }
        }
        // The window asks for the list, and the check of the hung program starts.
        const listing = timed(runtime.runPromise(Providers.use((p) => p.list)))
        // The accounts and the verification of the API account do not wait for it.
        const accounts = await timed(runtime.runPromise(Providers.use((p) => p.accounts)))
        expect(accounts.value.map((a) => a.id)).toContain(api.id)
        expect(accounts.ms).toBeLessThan(200)
        const verified = await timed(runtime.runPromise(Providers.use((p) => p.verify(api.id))))
        expect(verified.value).toBe(true)
        expect(verified.ms).toBeLessThan(200)
        // The list itself waits only a short time for the check, then goes on.
        const list = await listing
        expect(list.ms).toBeLessThan(3000)
        expect(list.value.find((a) => a.id === "hung")?.connected).toBe(false)
        // So does the verification of the account of the hung program.
        const hung = await timed(runtime.runPromise(Providers.use((p) => p.verify("hung"))))
        expect(hung.value).toBe(false)
        expect(hung.ms).toBeLessThan(3000)
      } finally {
        checkWait.ms = savedWait
        if (saved === undefined) delete process.env.ROBOT_MUSE_BIN
        else process.env.ROBOT_MUSE_BIN = saved
      }
    },
  )
})
