import { describe, expect, test } from "bun:test"
import { MemoryStorage } from "@robot/phone"
import {
  defaultPrefs,
  forgetServer,
  notifyKindOf,
  readPrefs,
  shouldNotify,
  toggleSection,
  writePrefs,
} from "./prefs.ts"

describe("the settings of the phone", () => {
  test("a missing or bad file gives the defaults", async () => {
    const storage = new MemoryStorage()
    expect(await readPrefs(storage)).toEqual(defaultPrefs)
    await storage.write("prefs.json", "{not json")
    expect(await readPrefs(storage)).toEqual(defaultPrefs)
    await storage.write(
      "prefs.json",
      JSON.stringify({
        language: "fr",
        theme: 3,
        notify: { reply: "no" },
        closed: { a: [1, "x"] },
      }),
    )
    expect(await readPrefs(storage)).toEqual({ ...defaultPrefs, closed: { a: ["x"] } })
  })

  test("tool steps show at first, and an old file without the switch still reads", async () => {
    expect(defaultPrefs.showToolSteps).toBe(true)
    const storage = new MemoryStorage()
    await storage.write("prefs.json", JSON.stringify({ language: "ko" }))
    expect(await readPrefs(storage)).toEqual({ ...defaultPrefs, language: "ko" })
    await storage.write("prefs.json", JSON.stringify({ showToolSteps: false }))
    expect((await readPrefs(storage)).showToolSteps).toBe(false)
  })

  test("settings are saved and read back", async () => {
    const storage = new MemoryStorage()
    const prefs = {
      ...defaultPrefs,
      language: "ko" as const,
      theme: "light" as const,
      notify: { ...defaultPrefs.notify, reply: false },
    }
    await writePrefs(storage, prefs)
    expect(await readPrefs(storage)).toEqual(prefs)
  })

  test("each kind of notification can be turned off", () => {
    const off = { ...defaultPrefs, notify: { ...defaultPrefs.notify, approval: false } }
    expect(shouldNotify(defaultPrefs, { kind: "question" })).toBe(true)
    expect(shouldNotify(off, { kind: "approval" })).toBe(false)
    expect(shouldNotify(off, { kind: "question" })).toBe(false)
    expect(shouldNotify(off, { kind: "reply" })).toBe(true)
    // Kinds of screens that Phone 1 does not have show no notification.
    expect(notifyKindOf({ kind: "workflow_notice" })).toBeNull()
    expect(shouldNotify(defaultPrefs, { kind: "part_review" })).toBe(false)
    // A mention and a part review come from a channel. Channels are gone (spec 015).
    expect(shouldNotify(defaultPrefs, { kind: "mention" })).toBe(false)
  })

  test("open and closed sections are kept per server, and forgotten on unpair", () => {
    let prefs = toggleSection(defaultPrefs, "L1", "agents")
    prefs = toggleSection(prefs, "L2", "user:s1")
    expect(prefs.closed).toEqual({ L1: ["agents"], L2: ["user:s1"] })
    prefs = toggleSection(prefs, "L1", "agents")
    expect(prefs.closed.L1).toEqual([])
    expect(forgetServer(prefs, "L2").closed).toEqual({ L1: [] })
  })
})
