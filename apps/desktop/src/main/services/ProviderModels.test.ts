import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { MODEL_NEW_MS, type ModelInfo } from "@robot/shared"
import { Effect, Exit } from "effect"
import { Database } from "./Database.ts"
import { modelClock, Providers } from "./Providers.ts"
import { testRuntime } from "./testing.ts"

// The model list of an account (spec 006, "Model list"): the order, the folded group of older
// models, the tag "New", the models that the user turns off, and the fields of a custom model.

const GOOD_KEY = "sk-test-good"

/** The list that the stand-in provider answers. A test changes it between two fetches. */
let listed: Record<string, unknown>[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url)
    if (req.headers.get("authorization") !== `Bearer ${GOOD_KEY}`)
      return Response.json({ error: { message: "bad key" } }, { status: 401 })
    if (url.pathname === "/v1/models") return Response.json({ data: listed })
    return new Response("not found", { status: 404 })
  },
})
afterAll(() => server.stop())
afterEach(() => {
  modelClock.now = () => Date.now()
})
const baseUrl = `http://127.0.0.1:${server.port}/v1`

const six = (): Record<string, unknown>[] => [
  { id: "mock-pro-1", created: 1_000 },
  { id: "mock-pro-2", created: 2_000 },
  { id: "mock-fast", created: 3_000 },
  { id: "o3-mini", created: 500 },
  { id: "mock-lite", created: 1_500 },
  { id: "mock-think", created: 2_500 },
]

const connect = async (kind: "openai" | "custom" = "custom") => {
  const { runtime } = testRuntime()
  const account = await runtime.runPromise(
    Providers.use((p) => p.connect({ kind, name: "Stand-in", baseUrl, apiKey: GOOD_KEY })),
  )
  const models = () => runtime.runPromise(Providers.use((p) => p.models(account.id)))
  const ids = async (pick?: (m: ModelInfo) => boolean) =>
    (await models()).filter(pick ?? (() => true)).map((m) => m.id)
  return { runtime, account, models, ids }
}

describe("the order of the list and the group Older models", () => {
  test("the newest model is first, and the older one of a family is marked", async () => {
    listed = six()
    const { ids } = await connect()
    expect(await ids()).toEqual([
      "mock-fast",
      "mock-think",
      "mock-pro-2",
      "mock-lite",
      "mock-pro-1",
      "o3-mini",
    ])
    expect(await ids((m) => m.older === true)).toEqual(["mock-pro-1"])
  })

  test("a provider with no dates and no versions keeps its order and has no older group", async () => {
    listed = [{ id: "zeta" }, { id: "alpha" }, { id: "mid" }]
    const { ids } = await connect()
    expect(await ids()).toEqual(["zeta", "alpha", "mid"])
    expect(await ids((m) => m.older === true)).toEqual([])
  })
})

describe("the tag New", () => {
  test("the first fetch of an account tags no model", async () => {
    listed = six()
    const { ids } = await connect()
    expect(await ids((m) => m.isNew === true)).toEqual([])
  })

  test("a model that a later fetch lists for the first time is New for 7 days", async () => {
    listed = six()
    const start = 10_000_000
    modelClock.now = () => start
    const { runtime, account, ids } = await connect()
    listed = [...six(), { id: "mock-fresh", created: 9_000 }]
    modelClock.now = () => start + 1_000
    await runtime.runPromise(Providers.use((p) => p.check(account.id)))
    expect(await ids((m) => m.isNew === true)).toEqual(["mock-fresh"])
    // Just before 7 days: still New. At 7 days: the tag is gone.
    modelClock.now = () => start + 1_000 + MODEL_NEW_MS - 1
    expect(await ids((m) => m.isNew === true)).toEqual(["mock-fresh"])
    modelClock.now = () => start + 1_000 + MODEL_NEW_MS
    expect(await ids((m) => m.isNew === true)).toEqual([])
  })

  test("a model that was listed before and comes back is not New again", async () => {
    listed = six()
    const { runtime, account, ids } = await connect()
    listed = six().slice(0, 4)
    await runtime.runPromise(Providers.use((p) => p.check(account.id)))
    listed = six()
    await runtime.runPromise(Providers.use((p) => p.check(account.id)))
    expect(await ids((m) => m.isNew === true)).toEqual([])
  })
})

describe("the part Models of an account", () => {
  test("a model that is off stays in the list with its mark; Hide all and Reset change all", async () => {
    listed = six()
    const { runtime, account, ids } = await connect()
    await runtime.runPromise(
      Providers.use((p) => p.setModel(account.id, "mock-fast", { hidden: true })),
    )
    expect(await ids((m) => m.hidden === true)).toEqual(["mock-fast"])
    await runtime.runPromise(Providers.use((p) => p.setAllModels(account.id, true)))
    expect(await ids((m) => m.hidden === true)).toHaveLength(6)
    await runtime.runPromise(Providers.use((p) => p.setAllModels(account.id, false)))
    expect(await ids((m) => m.hidden === true)).toEqual([])
  })

  test("a model that a later fetch brings is on, also after Hide all", async () => {
    listed = six()
    const { runtime, account, ids } = await connect()
    await runtime.runPromise(Providers.use((p) => p.setAllModels(account.id, true)))
    listed = [...six(), { id: "mock-fresh", created: 9_000 }]
    await runtime.runPromise(Providers.use((p) => p.check(account.id)))
    expect(await ids((m) => m.hidden !== true)).toEqual(["mock-fresh"])
  })

  test("the choice is kept in the table of this computer, and goes with the account", async () => {
    listed = six()
    const { runtime, account } = await connect()
    await runtime.runPromise(
      Providers.use((p) => p.setModel(account.id, "o3-mini", { hidden: true })),
    )
    const count = () =>
      runtime.runPromise(
        Database.use((db) =>
          Effect.sync(
            () =>
              db.get<{ n: number }>(
                "SELECT COUNT(*) AS n FROM provider_model WHERE account_id = ?",
                account.id,
              )?.n,
          ),
        ),
      )
    expect(await count()).toBe(6)
    await runtime.runPromise(Providers.use((p) => p.remove(account.id)))
    expect(await count()).toBe(0)
  })
})

describe("a custom model", () => {
  const code = (exit: Exit.Exit<unknown, { code: string }>) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons
          .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
          .join()
      : "ok"

  test("the context size and the output limit show in the list and reach the turn", async () => {
    listed = [{ id: "mock-fast", context_length: 100_000 }]
    const { runtime, account, models } = await connect("custom")
    await runtime.runPromise(
      Providers.use((p) =>
        p.setModel(account.id, "mock-fast", { contextSize: 32_000, outputLimit: 2_000 }),
      ),
    )
    const [model] = await models()
    expect(model).toMatchObject({
      id: "mock-fast",
      custom: true,
      contextWindow: 32_000,
      outputLimit: 2_000,
    })
    expect(
      await runtime.runPromise(
        Providers.use((p) => Effect.sync(() => p.outputLimit(account.id, "mock-fast"))),
      ),
    ).toBe(2_000)
    // A field that is cleared gives the size of the provider back.
    await runtime.runPromise(
      Providers.use((p) => p.setModel(account.id, "mock-fast", { contextSize: null })),
    )
    expect((await models())[0]?.contextWindow).toBe(100_000)
  })

  test("the fields refuse 0, 10,000,001 and a fraction", async () => {
    listed = [{ id: "mock-fast" }]
    const { runtime, account } = await connect("custom")
    for (const bad of [0, 10_000_001, 1.5, -1]) {
      expect(
        code(
          await runtime.runPromiseExit(
            Providers.use((p) => p.setModel(account.id, "mock-fast", { outputLimit: bad })),
          ),
        ),
      ).toBe("model_limit_invalid")
    }
    expect(
      code(
        await runtime.runPromiseExit(
          Providers.use((p) => p.setModel(account.id, "mock-fast", { contextSize: 10_000_000 })),
        ),
      ),
    ).toBe("ok")
  })

  test("a model of an OpenAI account is not custom, but a model ID that the user types is", async () => {
    listed = [{ id: "gpt-5" }]
    const { runtime, account, models } = await connect("openai")
    expect(
      code(
        await runtime.runPromiseExit(
          Providers.use((p) => p.setModel(account.id, "gpt-5", { outputLimit: 100 })),
        ),
      ),
    ).toBe("invalid_input")
    await runtime.runPromise(Providers.use((p) => p.addModel(account.id, "  my-model  ")))
    await runtime.runPromise(
      Providers.use((p) => p.setModel(account.id, "my-model", { contextSize: 8_000 })),
    )
    const mine = (await models()).find((m) => m.id === "my-model")
    expect(mine).toMatchObject({
      custom: true,
      added: true,
      contextWindow: 8_000,
      label: "my-model",
    })
    expect((await models()).find((m) => m.id === "gpt-5")?.custom).toBeUndefined()
    // Taken off again, the ID leaves the list and its fields go.
    await runtime.runPromise(Providers.use((p) => p.removeModel(account.id, "my-model")))
    expect((await models()).map((m) => m.id)).toEqual(["gpt-5"])
  })

  test("a typed ID has 1 to 200 characters", async () => {
    listed = []
    const { runtime, account } = await connect("custom")
    for (const bad of ["", "   ", "x".repeat(201)])
      expect(
        code(await runtime.runPromiseExit(Providers.use((p) => p.addModel(account.id, bad)))),
      ).toBe("model_id_invalid")
  })
})
