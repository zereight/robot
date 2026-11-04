import { expect, test } from "bun:test"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "../test-temp.ts"
import { hostStore } from "./Secrets.ts"

/**
 * A stand-in for `robot-host secrets …` with the same exit codes: it keeps each value in a file,
 * writes each call to a log, and fails every call for the key "broken". It is a shell script, not a
 * program of Bun. Each call of the store starts the program again, and when many test files start
 * Bun programs at once, some of them do not start for seconds, or never: the test waits for its
 * time limit. A shell script starts at once.
 */
const fakeHost = () => {
  const dir = tempDir("robot-secrets-unit-")
  const log = join(dir, "calls.log")
  const command = join(dir, "robot-host")
  writeFileSync(
    command,
    `#!/bin/sh
op="$2"; key="$3"
echo "$op $key" >> "${log}"
if [ "$key" = broken ]; then echo "keychain error -1" >&2; exit 1; fi
file="${dir}/value_$(printf %s "$key" | tr -c 'A-Za-z0-9' _)"
case "$op" in
  get) [ -e "$file" ] || exit 3; cat "$file" ;;
  set) cat > "$file" ;;
  remove) rm -f "$file" ;;
esac
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
