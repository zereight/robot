import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { BROWSER_PROFILE_NAME_MAX, BROWSER_PROFILES_MAX } from "@robot/shared"
import { Effect, Exit, ManagedRuntime } from "effect"
import { appLayer } from "../layers.ts"
import { BrowserProfiles } from "./BrowserProfiles.ts"
import { Database } from "./Database.ts"
import { Platform } from "./Platform.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testPlatform, testRuntime } from "./testing.ts"
import { Workflows } from "./Workflows.ts"

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const exit = t.runtime.runPromiseExit
  const server = await run(Servers.use((s) => s.local))
  const workflow = (name: string) =>
    run(Workflows.use((w) => w.create({ serverId: server.id, name })))
  const profile = (name: string) => run(BrowserProfiles.use((b) => b.create(name)))
  const list = () => run(BrowserProfiles.use((b) => b.list))
  const assign = (workflowId: string, profileId: string | null) =>
    run(BrowserProfiles.use((b) => b.assign(workflowId, profileId)))
  return { ...t, run, exit, server, workflow, profile, list, assign }
}

const failCode = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

describe("make, rename and list browser profiles", () => {
  test("a new profile has the trimmed name and no workflows; the list is by name", async () => {
    const t = await setup()
    expect(await t.list()).toEqual([])
    const work = await t.profile("  Work ")
    await t.profile("Home")
    expect(work.name).toBe("Work")
    expect(work.workflowIds).toEqual([])
    expect((await t.list()).map((p) => p.name)).toEqual(["Home", "Work"])
    await t.runtime.dispose()
  })

  test("a name has 1 to 40 characters and is unique when case is ignored", async () => {
    const t = await setup()
    for (const bad of ["", "   ", "a".repeat(BROWSER_PROFILE_NAME_MAX + 1)])
      expect(failCode(await t.exit(BrowserProfiles.use((b) => b.create(bad))))).toBe(
        "browser_profile_name_invalid",
      )
    await t.profile("Work")
    expect(failCode(await t.exit(BrowserProfiles.use((b) => b.create(" WORK "))))).toBe(
      "browser_profile_name_taken",
    )
    await t.runtime.dispose()
  })

  test("a computer holds at most 20 profiles", async () => {
    const t = await setup()
    for (let i = 0; i < BROWSER_PROFILES_MAX; i++) await t.profile(`Profile ${i}`)
    expect(failCode(await t.exit(BrowserProfiles.use((b) => b.create("One more"))))).toBe(
      "browser_profile_limit",
    )
    await t.runtime.dispose()
  })

  test("rename keeps the workflows, may keep the same name in other case, and refuses a taken name", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    const work = await t.profile("Work")
    const home = await t.profile("Home")
    await t.assign(ada.id, work.id)
    const renamed = await t.run(BrowserProfiles.use((b) => b.rename(work.id, "work")))
    expect(renamed.name).toBe("work")
    expect(renamed.workflowIds).toEqual([ada.id])
    expect(failCode(await t.exit(BrowserProfiles.use((b) => b.rename(home.id, "WORK"))))).toBe(
      "browser_profile_name_taken",
    )
    expect(failCode(await t.exit(BrowserProfiles.use((b) => b.rename("nope", "X"))))).toBe(
      "browser_profile_not_found",
    )
    await t.runtime.dispose()
  })

  test("each change tells the screens", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    const before = t.events.filter((e) => e.event === "browserProfiles.changed").length
    const work = await t.profile("Work")
    await t.assign(ada.id, work.id)
    await t.run(BrowserProfiles.use((b) => b.rename(work.id, "Job")))
    await t.run(BrowserProfiles.use((b) => b.remove(work.id)))
    expect(t.events.filter((e) => e.event === "browserProfiles.changed").length - before).toBe(4)
    await t.runtime.dispose()
  })
})

describe("give a profile to a workflow", () => {
  test("a workflow uses the profile that it got; two workflows may share one", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    const bo = await t.workflow("Bo")
    const work = await t.profile("Work")
    await t.assign(ada.id, work.id)
    await t.assign(bo.id, work.id)
    expect((await t.list())[0]?.workflowIds.slice().sort()).toEqual([ada.id, bo.id].sort())
    expect(t.browserProfiles.get(ada.id)).toBe(work.id)
    expect(t.browserProfiles.get(bo.id)).toBe(work.id)
    await t.runtime.dispose()
  })

  test("a workflow has one profile at a time; null gives it its own data again", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    const work = await t.profile("Work")
    const home = await t.profile("Home")
    await t.assign(ada.id, work.id)
    await t.assign(ada.id, home.id)
    expect((await t.list()).map((p) => [p.name, p.workflowIds.length])).toEqual([
      ["Home", 1],
      ["Work", 0],
    ])
    expect(t.browserProfiles.get(ada.id)).toBe(home.id)
    await t.assign(ada.id, null)
    expect((await t.list()).every((p) => p.workflowIds.length === 0)).toBe(true)
    expect(t.browserProfiles.has(ada.id)).toBe(false)
    await t.runtime.dispose()
  })

  test("an unknown workflow or profile is refused", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    expect(failCode(await t.exit(BrowserProfiles.use((b) => b.assign("nope", null))))).toBe(
      "workflow_not_found",
    )
    expect(failCode(await t.exit(BrowserProfiles.use((b) => b.assign(ada.id, "nope"))))).toBe(
      "browser_profile_not_found",
    )
    await t.runtime.dispose()
  })

  test("a page that is open closes when the data it uses changes, and not otherwise", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    const work = await t.profile("Work")
    const page = await t.run(Platform.use((p) => Effect.succeed(p.browser(ada.id))))
    await page.open("https://example.com")
    // The same choice again changes nothing.
    await t.assign(ada.id, null)
    expect(page.isOpen()).toBe(true)
    await t.assign(ada.id, work.id)
    expect(page.isOpen()).toBe(false)
    expect(t.browserLog).toContain(`${ada.id}:close`)
    await t.runtime.dispose()
  })

  test("when a workflow is deleted, its choice goes", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    const work = await t.profile("Work")
    await t.assign(ada.id, work.id)
    await t.run(
      Database.use((db) => Effect.sync(() => db.run("DELETE FROM workflow WHERE id = ?", ada.id))),
    )
    expect((await t.list())[0]?.workflowIds).toEqual([])
    await t.runtime.dispose()
  })
})

describe("delete a profile", () => {
  test("the workflows go back to their own data, their pages close and the saved data goes", async () => {
    const t = await setup()
    const ada = await t.workflow("Ada")
    const bo = await t.workflow("Bo")
    const work = await t.profile("Work")
    const home = await t.profile("Home")
    await t.assign(ada.id, work.id)
    await t.assign(bo.id, home.id)
    const page = await t.run(Platform.use((p) => Effect.succeed(p.browser(ada.id))))
    await page.open("https://example.com")
    await t.run(BrowserProfiles.use((b) => b.remove(work.id)))
    expect((await t.list()).map((p) => p.name)).toEqual(["Home"])
    expect(page.isOpen()).toBe(false)
    expect(t.browserProfiles.has(ada.id)).toBe(false)
    // Another profile and its workflows are not touched.
    expect(t.browserProfiles.get(bo.id)).toBe(home.id)
    expect(t.clearedProfiles).toEqual([work.id])
    await t.runtime.dispose()
  })

  test("an unknown profile is refused", async () => {
    const t = await setup()
    expect(failCode(await t.exit(BrowserProfiles.use((b) => b.remove("nope"))))).toBe(
      "browser_profile_not_found",
    )
    await t.runtime.dispose()
  })
})

describe("after a restart", () => {
  test("each workflow gets its profile again before any page opens", async () => {
    const t = testPlatform()
    const start = () =>
      ManagedRuntime.make(
        appLayer({
          platform: t.platform,
          databaseFile: join(t.dataDir, "robot.db"),
          localServerName: "Test computer",
          emit: () => {},
          secrets: Secrets.memory,
        }),
      )
    const first = start()
    const server = await first.runPromise(Servers.use((s) => s.local))
    const ada = await first.runPromise(
      Workflows.use((w) => w.create({ serverId: server.id, name: "Ada" })),
    )
    const bo = await first.runPromise(
      Workflows.use((w) => w.create({ serverId: server.id, name: "Bo" })),
    )
    const work = await first.runPromise(BrowserProfiles.use((b) => b.create("Work")))
    await first.runPromise(BrowserProfiles.use((b) => b.assign(ada.id, work.id)))
    await first.dispose()

    // The program starts again: the fake platform forgets, the database stays.
    t.browserProfiles.clear()
    const second = start()
    await second.runPromise(BrowserProfiles.use((b) => b.list))
    expect(t.browserProfiles.get(ada.id)).toBe(work.id)
    expect(t.browserProfiles.has(bo.id)).toBe(false)
    await second.dispose()
  })
})
