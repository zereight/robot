import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostStore } from "./Secrets.ts"

const fakeHost = () => {
  const dir = mkdtempSync(join(tmpdir(), "robot-secrets-unit-"))
  const log = join(dir, "calls.log")
  const command = join(dir, "robot-host")
  writeFileSync(
    command,
    `#!/bin/sh
op="$2"; key="$3"
echo "$*" >> "${log}"
case "$*" in *broken*) echo "keychain error -1" >&2; exit 1;; esac
file="${dir}/value_$(printf %s "$key" | tr -c 'A-Za-z0-9' _)"
case "$op" in
  get) [ -e "$file" ] || exit 3; cat "$file" ;;
  set) cat > "$file" ;;
  remove) rm -f "$file" ;;
  check) [ -e "${dir}/check-broken" ] && exit 1; exit 0 ;;
esac
`,
  )
  chmodSync(command, 0o755)
  const calls = () => readFileSync(log, "utf8").trim().split("\n")
  const breakCheck = () => writeFileSync(join(dir, "check-broken"), "")
  return { command, calls, breakCheck }
}

const vault = { vault: { path: "/vault/secrets.vault", profile: "default" } }

test("a value is written, read and removed through the host", () => {
  const host = fakeHost()
  const store = hostStore(host.command, vault)
  expect(store.get("provider:a")).toBeNull()
  store.set("provider:a", "sk-1\nwith a line")
  expect(store.get("provider:a")).toBe("sk-1\nwith a line")
  store.remove("provider:a")
  expect(store.get("provider:a")).toBeNull()
})

test("a value that was read once comes from memory", () => {
  const host = fakeHost()
  const writer = hostStore(host.command, vault)
  writer.set("k", "v")
  const store = hostStore(host.command, vault)
  expect(store.get("k")).toBe("v")
  expect(store.get("k")).toBe("v")
  expect(store.get("none")).toBeNull()
  expect(store.get("none")).toBeNull()
  expect(host.calls()).toEqual([
    "secrets set k --vault /vault/secrets.vault --profile default",
    "secrets get k --vault /vault/secrets.vault --profile default",
    "secrets get none --vault /vault/secrets.vault --profile default",
  ])
})

test("a set drops every value that was read before", () => {
  const host = fakeHost()
  const store = hostStore(host.command, vault)
  store.set("provider:a", "old")
  expect(store.get("provider:a")).toBe("old")
  hostStore(host.command, vault).remove("provider:a")
  store.set("provider:b", "new")
  expect(store.get("provider:a")).toBeNull()
  expect(store.get("provider:b")).toBe("new")
})

test("a check that fails drops every value that was read before", () => {
  const host = fakeHost()
  const store = hostStore(host.command, vault)
  store.set("k", "v")
  expect(store.get("k")).toBe("v")
  hostStore(host.command, vault).remove("k")
  host.breakCheck()
  expect(() => store.check()).toThrow("The keychain could not be read")
  expect(store.get("k")).toBeNull()
})

test("a store that fails throws, and the message holds no value", () => {
  const host = fakeHost()
  const store = hostStore(host.command, vault)
  expect(() => store.get("broken")).toThrow("The keychain could not be read")
  expect(() => store.set("broken", "secret-value")).toThrow("The keychain could not be written")
  try {
    store.set("broken", "secret-value")
  } catch (error) {
    expect(String(error)).not.toContain("secret-value")
  }
  expect(() => store.remove("broken")).toThrow("The keychain could not be written")
})

test("check calls the check op of the host", () => {
  const host = fakeHost()
  const store = hostStore(host.command, vault)
  store.check()
  expect(host.calls()).toEqual(["secrets check --vault /vault/secrets.vault --profile default"])
  const broken = hostStore(host.command, {
    vault: { path: "/vault/secrets.vault", profile: "broken" },
  })
  expect(() => broken.check()).toThrow("The keychain could not be read")
})

test("a file source passes --file to the host", () => {
  const host = fakeHost()
  const writer = hostStore(host.command, { file: "/tmp/test-secrets.json" })
  writer.set("k", "v")
  const store = hostStore(host.command, { file: "/tmp/test-secrets.json" })
  expect(store.get("k")).toBe("v")
  expect(host.calls()).toEqual([
    "secrets set k --file /tmp/test-secrets.json",
    "secrets get k --file /tmp/test-secrets.json",
  ])
})
