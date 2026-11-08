import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SavedLogins } from "./SavedLogins.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

/**
 * The keychain error of spec 020: when the keychain cannot be read, the vault shows "Cannot read
 * the vault." A request with a secret then fails with that reason until the keychain can be read
 * again. Other request failures keep their own reasons.
 */
describe("a keychain that cannot be read (spec 020)", () => {
  test("both vault lists fail with the keychain reason, and Test fails with it too", async () => {
    let locked = false
    const store = new Map<string, string>()
    const flaky = Layer.sync(Secrets, () =>
      Secrets.of({
        get: (key) => {
          if (locked) throw new Error("The keychain could not be read")
          return store.get(key) ?? null
        },
        set: (key, value) => {
          if (locked) throw new Error("The keychain could not be written")
          store.set(key, value)
        },
        remove: (key) => void store.delete(key),
        check: () => {
          if (locked) throw new Error("The keychain could not be read")
        },
      }),
    )
    const t = testRuntime({ secrets: flaky })
    const run = t.runtime.runPromise
    const server = await run(Servers.use((s) => s.local))
    const workflow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Ada" })))
    const secret = await run(
      SavedSecrets.use((s) =>
        Effect.sync(() =>
          s.save(
            workflow.id,
            { name: "Api", origin: "https://api.example.com", auth: { kind: "bearer" } },
            "tok-Zq81xVb27mW0-secret",
          ),
        ),
      ),
    )
    await run(
      SavedLogins.use((s) =>
        Effect.sync(() =>
          s.save(
            workflow.id,
            { name: "TestUser", origin: "https://id.example.com", user: "ada" },
            "tok-Zq81xVb27mW0-secret",
          ),
        ),
      ),
    )
    locked = true
    await expect(
      run(SavedSecrets.use((s) => Effect.sync(() => s.list(workflow.id)))),
    ).rejects.toMatchObject({ code: "secret_keychain_read" })
    await expect(
      run(SavedLogins.use((s) => Effect.sync(() => s.list(workflow.id)))),
    ).rejects.toMatchObject({ code: "secret_keychain_read" })
    // A request with the secret fails with the keychain reason, not a request reason.
    expect(
      await run(SavedSecrets.use((s) => Effect.promise(() => s.test(secret.id, false)))),
    ).toEqual({ ok: false, reason: "keychain" })
    // When the keychain can be read again, both lists answer.
    locked = false
    expect(await run(SavedSecrets.use((s) => Effect.sync(() => s.list(workflow.id))))).toHaveLength(
      1,
    )
    expect(await run(SavedLogins.use((s) => Effect.sync(() => s.list(workflow.id))))).toHaveLength(
      1,
    )
  })
})
