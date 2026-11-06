import { describe, expect, test } from "bun:test"
import { MemoryStorage } from "@robot/phone"
import { defaultPrefs, readPrefs, writePrefs } from "./prefs.ts"

describe("the settings of the phone", () => {
  test("a missing or bad file gives the defaults", async () => {
    const storage = new MemoryStorage()
    expect(await readPrefs(storage)).toEqual(defaultPrefs)
    await storage.write("prefs.json", "{not json")
    expect(await readPrefs(storage)).toEqual(defaultPrefs)
    await storage.write("prefs.json", JSON.stringify({ language: "fr", theme: 3 }))
    expect(await readPrefs(storage)).toEqual(defaultPrefs)
  })

  test("settings are saved and read back", async () => {
    const storage = new MemoryStorage()
    const prefs = { ...defaultPrefs, language: "ko" as const, theme: "light" as const }
    await writePrefs(storage, prefs)
    expect(await readPrefs(storage)).toEqual(prefs)
  })
})
