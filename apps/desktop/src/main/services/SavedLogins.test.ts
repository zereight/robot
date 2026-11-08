import { describe, expect, test } from "bun:test"
import { LOGINS_PER_WORKFLOW } from "@robot/shared"
import { Effect } from "effect"
import { Database } from "./Database.ts"
import { Rules } from "./Rules.ts"
import { SavedLogins, savedLoginPasswordKey, savedLoginUserKey } from "./SavedLogins.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

const USER = "ada"
const PASSWORD = "tok-Zq81xVb27mW0-secret"

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const server = await run(Servers.use((s) => s.local))
  const workflow = await run(Workflows.use((w) => w.create({ serverId: server.id, name: "Ada" })))
  const save = (
    name: string,
    origin = "https://id.example.com",
    user = USER,
    password = PASSWORD,
    id = workflow.id,
  ) => run(SavedLogins.use((s) => Effect.sync(() => s.save(id, { name, origin, user }, password))))
  return { ...t, run, server, workflow, save }
}

describe("saved logins of a workflow (spec 020)", () => {
  test("both values go to the keychain and the row holds neither", async () => {
    const t = await setup()
    const saved = await t.save("TestUser")
    const rows = await t.run(
      Database.use((db) =>
        Effect.sync(() => db.all<Record<string, unknown>>("SELECT * FROM saved_login")),
      ),
    )
    expect(JSON.stringify(rows)).not.toContain(USER)
    expect(JSON.stringify(rows)).not.toContain(PASSWORD)
    const found = await t.run(
      SavedLogins.use((s) => Effect.sync(() => s.find(t.workflow.id, "testuser"))),
    )
    expect(found?.id).toBe(saved.id)
    expect(found?.user).toBe(USER)
    expect(found?.userValue()).toBe(USER)
    expect(found?.passwordValue()).toBe(PASSWORD)
  })

  test("the same name keeps its id and takes the new values; another origin is refused", async () => {
    const t = await setup()
    const first = await t.save("TestUser")
    const second = await t.save(
      "TESTUSER",
      "https://id.example.com",
      "bo",
      "tok-bo-value-0123456789",
    )
    expect(second.id).toBe(first.id)
    const outcome = await t.run(
      SavedLogins.use((s) =>
        Effect.sync(() => s.match(t.workflow.id, "TestUser", "https://evil.example.com")),
      ),
    )
    expect(outcome.kind).toBe("conflict")
  })

  test("a login with no way to send holds only a name, an origin and a user name", async () => {
    const t = await setup()
    const saved = await t.save("TestUser")
    expect(saved).not.toHaveProperty("auth")
    expect(Object.keys(saved).sort()).toEqual(
      [
        "id",
        "lastUsedAt",
        "name",
        "origin",
        "savedAt",
        "user",
        "valueMissing",
        "workflowId",
      ].sort(),
    )
  })

  test("a workflow holds at most 50 logins", async () => {
    const t = await setup()
    expect(LOGINS_PER_WORKFLOW).toBe(50)
    for (let i = 0; i < LOGINS_PER_WORKFLOW; i++) await t.save(`User${i}`)
    const outcome = await t.run(
      SavedLogins.use((s) =>
        Effect.sync(() => s.match(t.workflow.id, "User51", "https://id.example.com")),
      ),
    )
    expect(outcome.kind).toBe("full")
    await expect(t.save("User51")).rejects.toMatchObject({ code: "login_full" })
  })

  test("a login of a workflow that does not exist is refused", async () => {
    const t = await setup()
    await expect(
      t.save("TestUser", "https://id.example.com", USER, PASSWORD, "nope"),
    ).rejects.toMatchObject({
      code: "workflow_not_found",
    })
  })

  test("a bad name, user or password is refused", async () => {
    const t = await setup()
    await expect(
      t.save("has space", "https://id.example.com", USER, PASSWORD),
    ).rejects.toMatchObject({ code: "login_name_invalid" })
    await expect(t.save("Ok", "https://id.example.com", "", PASSWORD)).rejects.toMatchObject({
      code: "login_value_invalid",
    })
  })

  test("a vault shows only the logins of the open workflow", async () => {
    const t = await setup()
    const other = await t.run(Workflows.use((w) => w.create({ serverId: t.server.id, name: "Bo" })))
    await t.save("TestUser")
    await t.save("TestUser", "https://id.example.com", "bo", "tok-bo-value-0123456789", other.id)
    const mine = await t.run(SavedLogins.use((s) => Effect.sync(() => s.list(t.workflow.id))))
    expect(mine.map((s) => s.name)).toEqual(["TestUser"])
    // A login of another workflow is unknown here.
    expect(
      await t.run(SavedLogins.use((s) => Effect.sync(() => s.find(t.workflow.id, "Missing")))),
    ).toBeUndefined()
  })

  test("replacing the values changes what the next fill reads", async () => {
    const t = await setup()
    const saved = await t.save("TestUser")
    const next = await t.run(
      SavedLogins.use((s) =>
        Effect.sync(() => s.replace(saved.id, USER, "tok-new-value-0123456789")),
      ),
    )
    expect(next.id).toBe(saved.id)
    const found = await t.run(
      SavedLogins.use((s) => Effect.sync(() => s.find(t.workflow.id, "TestUser"))),
    )
    expect(found?.passwordValue()).toBe("tok-new-value-0123456789")
    expect(found?.userValue()).toBe(USER)
  })

  test("a delete of the workflow removes its logins and their values from the keychain", async () => {
    const t = await setup()
    const keep = await t.run(Workflows.use((w) => w.create({ serverId: t.server.id, name: "Bo" })))
    const saved = await t.save("TestUser")
    await t.save("TestUser", "https://id.example.com", "bo", "tok-bo-value-0123456789", keep.id)
    const key = await t.run(
      Database.use((db) =>
        Effect.sync(
          () =>
            db.get<{ value_ref: string }>(
              "SELECT value_ref FROM saved_login WHERE id = ?",
              saved.id,
            )?.value_ref,
        ),
      ),
    )
    const secrets = await t.run(Secrets)
    expect(secrets.get(savedLoginUserKey(key as string))).toBe(USER)
    expect(secrets.get(savedLoginPasswordKey(key as string))).toBe(PASSWORD)
    await t.run(Workflows.use((w) => w.remove(t.workflow.id)))
    expect(secrets.get(savedLoginUserKey(key as string))).toBeNull()
    expect(secrets.get(savedLoginPasswordKey(key as string))).toBeNull()
    const left = await t.run(SavedLogins.use((s) => Effect.sync(() => s.list())))
    expect(left.map((s) => s.name)).toEqual(["TestUser"])
  })

  test("add refuses a taken name and a local origin without the switch; logins have no way to send", async () => {
    const t = await setup()
    const add = (name: string, origin: string, allowLocal = false) =>
      t.run(
        SavedLogins.use((s) =>
          Effect.sync(() =>
            s.add(t.workflow.id, { name, origin, user: USER }, PASSWORD, allowLocal),
          ),
        ),
      )
    await add("TestUser", "https://id.example.com")
    await expect(add("testuser", "https://id.example.com")).rejects.toMatchObject({
      code: "login_name_taken",
    })
    await expect(add("Local", "https://127.0.0.1:4001")).rejects.toMatchObject({
      code: "secret_origin_local",
    })
    const local = await add("Local", "https://127.0.0.1:4001", true)
    // No way to send: the row holds no auth kind.
    expect(local).not.toHaveProperty("auth")
  })

  test("rename moves the rules to the new name", async () => {
    const t = await setup()
    const saved = await t.save("TestUser")
    await t.save("Other")
    await t.run(
      Rules.use((r) =>
        r.add({ workflowId: t.workflow.id, kind: "secret", text: "TestUser", decision: "deny" }),
      ),
    )
    const verdict = (name: string) =>
      t.run(
        Rules.use((r) =>
          Effect.sync(() => r.verdict(t.workflow.id, { kind: "secret", name, method: "GET" }).kind),
        ),
      )
    const renamed = await t.run(
      SavedLogins.use((s) => Effect.sync(() => s.rename(saved.id, "Renamed"))),
    )
    expect(renamed.name).toBe("Renamed")
    expect(await verdict("Renamed")).toBe("deny")
    expect(await verdict("TestUser")).toBe("none")
    await expect(
      t.run(SavedLogins.use((s) => Effect.sync(() => s.rename(saved.id, "Other")))),
    ).rejects.toMatchObject({ code: "login_name_taken" })
  })
})
