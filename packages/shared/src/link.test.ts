import { describe, expect, test } from "bun:test"
import {
  ACCESS_EVENT,
  CHANGE_METHODS,
  CLIENT_METHODS,
  formatAddress,
  formatLink,
  groupCode,
  isChangeMethod,
  isClientMethod,
  isPairCode,
  numberedNames,
  PUSHED_EVENTS,
  parseAddress,
  parseLink,
} from "./link.ts"

describe("addresses", () => {
  test("reads host, port and IPv6 forms", () => {
    expect(parseAddress("192.168.1.4:5000")).toEqual({ host: "192.168.1.4", port: 5000 })
    expect(parseAddress("192.168.1.4")).toEqual({ host: "192.168.1.4", port: 47800 })
    expect(parseAddress("macbook.local:9")).toEqual({ host: "macbook.local", port: 9 })
    expect(parseAddress("[fd7a::1]:4000")).toEqual({ host: "fd7a::1", port: 4000 })
    expect(parseAddress("fd7a::1")).toEqual({ host: "fd7a::1", port: 47800 })
  })

  test("refuses text that is not an address", () => {
    for (const bad of [
      "",
      "  ",
      "a b",
      "host:",
      "host:99999",
      "host:0",
      "host:x",
      "-a.com",
      "a..b",
    ]) {
      expect(parseAddress(bad)).toBeNull()
    }
  })

  test("formats an address so it reads back", () => {
    for (const a of [
      { host: "10.0.0.2", port: 47800 },
      { host: "fd7a::1", port: 1 },
    ]) {
      expect(parseAddress(formatAddress(a))).toEqual(a)
    }
  })
})

describe("link text", () => {
  test("holds the code, the name and every address, and reads back", () => {
    const invite = {
      code: "042517",
      name: "MacBook 2",
      addresses: ["192.168.1.4:47800", "100.64.0.9:47800", "[fd7a::9]:47800"],
    }
    expect(parseLink(formatLink(invite))).toEqual(invite)
  })

  test("refuses text that is not a link", () => {
    for (const bad of [
      "",
      "hello",
      "https://example.com/pair?code=123456&a=1.2.3.4",
      "robot://other?code=123456&a=1.2.3.4",
      "robot://pair?code=12345&a=1.2.3.4",
      "robot://pair?code=123456",
      "robot://pair?code=123456&a=not%20an%20address",
    ]) {
      expect(parseLink(bad)).toBeNull()
    }
  })

  test("a code is six digits", () => {
    expect(isPairCode("123456")).toBe(true)
    expect(isPairCode("12345")).toBe(false)
    expect(isPairCode("12345a")).toBe(false)
    expect(groupCode("123456")).toBe("123 456")
  })
})

describe("client requests", () => {
  test("a client cannot reach the settings of a server", () => {
    for (const method of [
      "agents.delete",
      "agents.restore",
      "agents.setFaceImage",
      "channels.delete",
      "providers.connect",
      "providers.list",
      "settings.update",
      "routines.list",
      "workflows.run",
      "usage.summary",
      "browser.control",
      "data.export",
      "data.restore",
      "tasks.retry",
      "devices.get",
    ]) {
      expect(isClientMethod(method)).toBe(false)
    }
    expect(CLIENT_METHODS).toContain("chat.send")
    expect(CLIENT_METHODS).toContain("tools.respond")
  })

  test("the requests that make and change agents are listed, and each needs the switch", () => {
    expect([...CHANGE_METHODS].sort() as string[]).toEqual(
      [
        "agents.archive",
        "agents.create",
        "agents.duplicate",
        "agents.update",
        "channels.create",
        "channels.update",
        "memory.add",
        "memory.delete",
        "memory.list",
        "memory.update",
        "models.available",
      ].sort(),
    )
    for (const method of CHANGE_METHODS) {
      expect(isClientMethod(method)).toBe(true)
      expect(isChangeMethod(method)).toBe(true)
    }
    // Reading and sending do not need the switch. Deleting is not offered at all.
    for (const method of ["chat.send", "agents.list", "agents.get", "tools.respond"]) {
      expect(isChangeMethod(method)).toBe(false)
    }
    expect(isChangeMethod("agents.delete")).toBe(false)
    // The event that tells one device about its switch goes to that device only.
    expect((PUSHED_EVENTS as readonly string[]).includes(ACCESS_EVENT)).toBe(false)
  })
})

describe("numbered names", () => {
  test("devices with one name get a number after it", () => {
    const names = numberedNames([
      { id: "a", name: "Mac" },
      { id: "b", name: "Mac" },
      { id: "c", name: "Phone" },
    ])
    expect(names.get("a")).toBe("Mac 1")
    expect(names.get("b")).toBe("Mac 2")
    expect(names.get("c")).toBe("Phone")
  })
})
