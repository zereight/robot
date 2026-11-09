import { describe, expect, test } from "bun:test"
import { SECRETS_PER_AGENT, type SecretAuth } from "@robot/shared"
import { Effect } from "effect"
import { Database } from "./Database.ts"
import { Rules } from "./Rules.ts"
import { SavedLogins } from "./SavedLogins.ts"
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

  test("a vault shows only the secrets of the open workflow", async () => {
    const t = await setup()
    const other = await t.run(Workflows.use((w) => w.create({ serverId: t.server.id, name: "Bo" })))
    await t.save("Stripe")
    await t.save("Stripe", VALUE, other.id)
    const mine = await t.run(SavedSecrets.use((s) => Effect.sync(() => s.list(t.workflow.id))))
    expect(mine.map((s) => s.name)).toEqual(["Stripe"])
    expect(
      await t.run(SavedSecrets.use((s) => Effect.sync(() => s.find(t.workflow.id, "Missing")))),
    ).toBeUndefined()
  })

  test("add refuses a taken name, a bad origin, and a local origin without the switch", async () => {
    const t = await setup()
    const add = (name: string, origin: string, value = VALUE, allowLocal = false) =>
      t.run(
        SavedSecrets.use((s) =>
          Effect.sync(() =>
            s.add(t.workflow.id, { name, origin, auth: bearer }, value, allowLocal),
          ),
        ),
      )
    await add("HandApi", "https://api.example.com")
    await expect(add("handapi", "https://api.example.com")).rejects.toMatchObject({
      code: "secret_name_taken",
    })
    await expect(add("Bad name", "https://api.example.com")).rejects.toMatchObject({
      code: "secret_name_invalid",
    })
    await expect(add("Plain", "http://api.example.com")).rejects.toMatchObject({
      code: "secret_origin_invalid",
    })
    await expect(add("Path", "https://api.example.com/v1")).rejects.toMatchObject({
      code: "secret_origin_invalid",
    })
    await expect(add("Local", "https://127.0.0.1:4001")).rejects.toMatchObject({
      code: "secret_origin_local",
    })
    // A local origin may use http when the switch is on.
    await add("Local", "http://127.0.0.1:4001", VALUE, true)
    // A value of more than 16384 characters is refused with the reason.
    await expect(add("Long", "https://api.example.com", "x".repeat(16385))).rejects.toMatchObject({
      code: "secret_value_long",
    })
  })

  test("rename moves the rules to the new name and keeps none on the old name", async () => {
    const t = await setup()
    const saved = await t.save("Api")
    await t.save("Other")
    await t.run(
      Rules.use((r) =>
        r.add({
          workflowId: t.workflow.id,
          kind: "secret",
          text: "Api",
          detail: "POST",
          decision: "deny",
        }),
      ),
    )
    await t.run(
      Rules.use((r) =>
        r.add({ workflowId: t.workflow.id, kind: "secret", text: "Other", decision: "allow" }),
      ),
    )
    const verdict = (name: string, method: string) =>
      t.run(
        Rules.use((r) =>
          Effect.sync(() => r.verdict(t.workflow.id, { kind: "secret", name, method }).kind),
        ),
      )
    const renamed = await t.run(
      SavedSecrets.use((s) => Effect.sync(() => s.rename(saved.id, "Renamed"))),
    )
    expect(renamed.name).toBe("Renamed")
    // The Deny rule still stops the renamed row, under the new name.
    expect(await verdict("Renamed", "POST")).toBe("deny")
    expect(await verdict("renamed", "POST")).toBe("deny")
    // The old name keeps no rule, so a new secret with the old name runs with no question.
    expect(await verdict("Api", "POST")).toBe("none")
    await t.save("Api", "tok-new-value-0123456789")
    expect(await verdict("Api", "POST")).toBe("none")
    // The rules of another secret stay where they are.
    expect(await verdict("Other", "POST")).toBe("allow")
    // A taken or bad name is refused, and a missing secret is not found.
    await expect(
      t.run(SavedSecrets.use((s) => Effect.sync(() => s.rename(saved.id, "Other")))),
    ).rejects.toMatchObject({ code: "secret_name_taken" })
    await expect(
      t.run(SavedSecrets.use((s) => Effect.sync(() => s.rename(saved.id, "has space")))),
    ).rejects.toMatchObject({ code: "secret_name_invalid" })
    await expect(
      t.run(SavedSecrets.use((s) => Effect.sync(() => s.rename("nope", "Fresh")))),
    ).rejects.toMatchObject({ code: "secret_not_found" })
  })

  test("a name that a login of the vault holds is refused, ignoring case", async () => {
    const t = await setup()
    await t.save("Github")
    await t.run(
      SavedLogins.use((s) =>
        Effect.sync(() =>
          s.add(
            t.workflow.id,
            { name: "Other", origin: "https://id.example.com", user: "ada" },
            VALUE,
          ),
        ),
      ),
    )
    // Adding a login with the name of a secret is refused, and the reverse.
    await expect(
      t.run(
        SavedLogins.use((s) =>
          Effect.sync(() =>
            s.add(
              t.workflow.id,
              { name: "GITHUB", origin: "https://id.example.com", user: "ada" },
              VALUE,
            ),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "login_name_taken" })
    await expect(
      t.run(
        SavedSecrets.use((s) =>
          Effect.sync(() =>
            s.add(
              t.workflow.id,
              { name: "other", origin: "https://api.example.com", auth: bearer },
              VALUE,
            ),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "secret_name_taken" })
    // Renaming onto the name of the other list is refused, so no rule moves to another row.
    const login = await t.run(
      SavedLogins.use((s) => Effect.sync(() => s.find(t.workflow.id, "Other"))),
    )
    await expect(
      t.run(SavedLogins.use((s) => Effect.sync(() => s.rename(login?.id ?? "", "github")))),
    ).rejects.toMatchObject({ code: "login_name_taken" })
  })

  test("test shows the reason when the value is missing or the switch is off", async () => {
    const t = await setup()
    const saved = await t.save("Api")
    // A local origin saved with the switch on: Test with the switch off refuses it.
    const local = await t.run(
      SavedSecrets.use((s) =>
        Effect.sync(() =>
          s.add(
            t.workflow.id,
            { name: "Local", origin: "http://127.0.0.1:4001", auth: bearer },
            VALUE,
            true,
          ),
        ),
      ),
    )
    expect(
      await t.run(SavedSecrets.use((s) => Effect.promise(() => s.test(local.id, false)))),
    ).toEqual({ ok: false, reason: "local_off" })
    // The row stays, the last-used date does not change, and no request went out.
    const row = await t.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.get<{ last_used_at: number | null }>(
            "SELECT last_used_at FROM saved_secret WHERE id = ?",
            local.id,
          ),
        ),
      ),
    )
    expect(row?.last_used_at).toBeNull()
    // With no value in the keychain, Test fails with the missing-value reason.
    const ref = await t.run(
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
    await t.run(Secrets.use((s) => Effect.sync(() => s.remove(savedSecretKey(ref as string)))))
    expect(
      await t.run(SavedSecrets.use((s) => Effect.promise(() => s.test(saved.id, false)))),
    ).toEqual({ ok: false, reason: "value_missing" })
    expect(
      await t.run(SavedSecrets.use((s) => Effect.sync(() => s.find(t.workflow.id, "Api")))),
    )?.toMatchObject({ valueMissing: true })
  })
})
