import { describe, expect, test } from "bun:test"
import { SECRETS_PER_AGENT, type SecretAuth } from "@robot/shared"
import { Effect } from "effect"
import { Database } from "./Database.ts"
import { SavedSecrets, savedSecretKey } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

const VALUE = "tok-Zq81xVb27mW0-secret"
const bearer: SecretAuth = { kind: "bearer" }

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const workflow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Ada" })))
  const save = (name: string, value = VALUE, id = workflow.id) =>
    run(
      SavedSecrets.use((s) =>
        Effect.sync(() =>
          s.save(id, { name, origin: "https://api.example.com", auth: bearer }, value),
        ),
      ),
    )
  return { ...t, run, server, workflow, save }
}

describe("saved secrets of a workflow (spec 020)", () => {
  test("the value goes to the keychain and the row holds no value", async () => {
    const t = await setup()
    const saved = await t.save("Stripe")
    const rows = await t.run(
      Database.use((db) =>
        Effect.sync(() => db.all<Record<string, unknown>>("SELECT * FROM saved_secret")),
      ),
    )
    expect(JSON.stringify(rows)).not.toContain(VALUE)
    const found = await t.run(
      SavedSecrets.use((s) => Effect.sync(() => s.find(t.workflow.id, "stripe"))),
    )
    expect(found?.id).toBe(saved.id)
    expect(found?.value()).toBe(VALUE)
  })

  test("the same name keeps its id and takes the new value; another origin is a conflict", async () => {
    const t = await setup()
    const first = await t.save("Stripe")
    const second = await t.save("STRIPE", "tok-other-value-123456")
    expect(second.id).toBe(first.id)
    const outcome = await t.run(
      SavedSecrets.use((s) =>
        Effect.sync(() => s.match(t.workflow.id, "Stripe", "https://evil.example.com", bearer)),
      ),
    )
    expect(outcome.kind).toBe("conflict")
  })

  test("a workflow holds at most the limit of secrets", async () => {
    const t = await setup()
    for (let i = 0; i < SECRETS_PER_AGENT; i++) await t.save(`Key${i}`)
    const outcome = await t.run(
      SavedSecrets.use((s) =>
        Effect.sync(() => s.match(t.workflow.id, "More", "https://api.example.com", bearer)),
      ),
    )
    expect(outcome.kind).toBe("full")
  })

  test("a secret of a workflow that does not exist is refused", async () => {
    const t = await setup()
    await expect(t.save("Stripe", VALUE, "nope")).rejects.toMatchObject({
      code: "workflow_not_found",
    })
  })

  test("a delete of the workflow removes its secrets and their values from the keychain", async () => {
    const t = await setup()
    const keep = await t.run(Workflows.use((w) => w.create({ serverId: t.server.id, name: "Bo" })))
    const saved = await t.save("Stripe")
    await t.save("Other", "tok-bo-value-0123456789", keep.id)
    const key = await t.run(
      Database.use((db) =>
        Effect.sync(
          () =>
            db.get<{ value_ref: string }>(
              "SELECT value_ref FROM saved_secret WHERE id = ?",
              saved.id,
            )?.value_ref,
        ),
      ),
    )
    const secrets = await t.run(Secrets)
    expect(secrets.get(savedSecretKey(key as string))).toBe(VALUE)
    await t.run(Workflows.use((w) => w.remove(t.workflow.id)))
    expect(secrets.get(savedSecretKey(key as string))).toBeNull()
    const left = await t.run(SavedSecrets.use((s) => Effect.sync(() => s.list())))
    expect(left.map((s) => s.name)).toEqual(["Other"])
  })
})
