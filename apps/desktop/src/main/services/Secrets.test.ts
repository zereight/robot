import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostStore } from "./Secrets.ts"

/**
 * A stand-in for `robot-host secrets …` with the same exit codes: it keeps the values in a JSON
 * file, writes each call to a log, and fails every call for the key "broken".
 */
const fakeHost = () => {
  const dir = mkdtempSync(join(tmpdir(), "robot-secrets-unit-"))
  const values = join(dir, "values.json")
  const log = join(dir, "calls.log")
  const command = join(dir, "robot-host")
  writeFileSync(
    command,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const [, , , op, key] = process.argv
appendFileSync(${JSON.stringify(log)}, op + " " + key + "\\n")
if (key === "broken") { console.error("keychain error -1"); process.exit(1) }
const all = existsSync(${JSON.stringify(values)}) ? JSON.parse(readFileSync(${JSON.stringify(values)}, "utf8")) : {}
if (op === "get") {
  if (!(key in all)) process.exit(3)
  process.stdout.write(all[key])
} else if (op === "set") {
  all[key] = readFileSync(0, "utf8")
  writeFileSync(${JSON.stringify(values)}, JSON.stringify(all))
} else if (op === "remove") {
  delete all[key]
  writeFileSync(${JSON.stringify(values)}, JSON.stringify(all))
}
`,
  )
  chmodSync(command, 0o755)
  const calls = () => readFileSync(log, "utf8").trim().split("\n")
  return { command, calls }
}

test("a value is written, read and removed through the host", () => {
  const host = fakeHost()
  const store = hostStore(host.command)
  expect(store.get("provider:a")).toBeNull()
  store.set("provider:a", "sk-1\nwith a line")
  expect(store.get("provider:a")).toBe("sk-1\nwith a line")
  store.remove("provider:a")
  expect(store.get("provider:a")).toBeNull()
})

test("a value that was read once comes from memory", () => {
  const host = fakeHost()
  const writer = hostStore(host.command)
  writer.set("k", "v")
  const store = hostStore(host.command)
  expect(store.get("k")).toBe("v")
  expect(store.get("k")).toBe("v")
  expect(store.get("none")).toBeNull()
  expect(store.get("none")).toBeNull()
  expect(host.calls()).toEqual(["set k", "get k", "get none"])
})

test("a store that fails throws, and the message holds no value", () => {
  const host = fakeHost()
  const store = hostStore(host.command)
  expect(() => store.get("broken")).toThrow("The keychain could not be read")
  expect(() => store.set("broken", "secret-value")).toThrow("The keychain could not be written")
  try {
    store.set("broken", "secret-value")
  } catch (error) {
    expect(String(error)).not.toContain("secret-value")
  }
  expect(() => store.remove("broken")).toThrow("The keychain could not be written")
})
