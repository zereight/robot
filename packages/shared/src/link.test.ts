import { describe, expect, test } from "bun:test"
import {
  ACCESS_EVENT,
  CHANGE_METHODS,
  CLIENT_METHODS,
  defaultCanChange,
  formatAddress,
  formatLink,
  groupCode,
  isChangeMethod,
  isClientMethod,
  isPairCode,
  isRoutedMethod,
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
      // Keeping the computer awake is a setting of that computer (spec 013).
      "keepAwake.state",
      "routines.list",
      // A client does not move a workflow of another computer here (spec 012, "Workflows").
      "workflows.runHere",
      "usage.summary",
      // A linked device sees the line "Holds a sensitive read" and cannot clear it (spec 007, 012).
      "placeMarks.clear",
      // A linked device cannot add, change or delete a permission rule, and the rules stay on the
      // computer (spec 007, 012, 019).
      "rules.list",
      "rules.add",
      "rules.update",
      "rules.delete",
      // Connections are added and edited on the computer only, and they never sync (spec 018, 019).
      "connections.list",
      "connections.save",
      "connections.test",
      "connections.setEnabled",
      "connections.setTool",
      "connections.setTrust",
      "connections.delete",
      "actionLog.list",
      "browser.control",
      "data.export",
      "data.restore",
      "tasks.retry",
      // The user decides on the review of a part on the computer that owns the task (spec 005, 012).
      "tasks.accept",
      "tasks.requestChanges",
      "tasks.endRequest",
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
        "agents.useMain",
        "channels.create",
        "channels.update",
        "handbook.restore",
        "handbook.save",
        "memory.add",
        "memory.delete",
        "memory.list",
        "memory.update",
        "models.available",
        "workflows.create",
        "workflows.update",
        "workflows.delete",
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
    // Reading, running and stopping a workflow need only the link (spec 012, "Workflows").
    for (const method of [
      "workflows.list",
      "workflows.runs",
      "workflows.runDetail",
      "workflows.run",
      "workflows.stop",
      "workflows.approve",
    ]) {
      expect(isClientMethod(method)).toBe(true)
      expect(isChangeMethod(method)).toBe(false)
    }
    // A client reads the handbook and its history with the link only; it changes the handbook with
    // the switch (spec 002, 012).
    for (const method of ["handbook.get", "handbook.history"]) {
      expect(isClientMethod(method)).toBe(true)
      expect(isChangeMethod(method)).toBe(false)
    }
    for (const method of ["handbook.save", "handbook.restore"]) {
      expect(isChangeMethod(method)).toBe(true)
    }
    // A client hears about workflows and runs.
    expect(PUSHED_EVENTS).toContain("workflows.changed")
    expect(PUSHED_EVENTS).toContain("workflows.run")
    // The event that tells one device about its switch goes to that device only.
    expect((PUSHED_EVENTS as readonly string[]).includes(ACCESS_EVENT)).toBe(false)
  })
})

describe("what a client cannot reach: sections, knowledge and files (spec 001, 012, 016)", () => {
  /** The requests of the window that belong to this computer: a linked server never answers them. */
  const refused = [
    "sections.create",
    "sections.rename",
    "sections.move",
    "sections.delete",
    "browserProfiles.list",
    "browserProfiles.create",
    "browserProfiles.rename",
    "browserProfiles.delete",
    "browserProfiles.assign",
    // The Teams link belongs to this computer: no linked device sees or changes it (spec 028).
    "teams.get",
    "teams.setup",
    "teams.update",
    "teams.setEnabled",
    "teams.showPage",
    "teams.hidePage",
    "teams.place",
    "teams.useChat",
    "teams.readSenders",
    "teams.signOut",
    "teams.remove",
    "places.move",
    "knowledge.list",
    "knowledge.get",
    "knowledge.save",
    "knowledge.delete",
    "knowledge.deleteSource",
    "knowledge.openSource",
    "knowledge.openFolder",
    "knowledge.changes",
    "knowledge.change",
    "knowledge.undo",
    "knowledge.findings",
    "agentFile.export",
    "agentFile.open",
    "agentFile.apply",
    "workflowFile.export",
    "workflowFile.open",
    "workflowFile.apply",
  ]

  test("no method of sections, knowledge or files is on the list of a client", () => {
    for (const method of refused) {
      expect(isClientMethod(method)).toBe(false)
      expect(isChangeMethod(method)).toBe(false)
    }
    // Nothing that starts like them is on the list either.
    for (const method of CLIENT_METHODS) {
      expect(method).not.toMatch(
        /^(sections|browserProfiles|teams|knowledge|agentFile|workflowFile)\./,
      )
    }
  })

  test("the window sends none of them to a linked server", () => {
    for (const method of refused) expect(isRoutedMethod(method)).toBe(false)
    // The list of places carries the sections and the section of each place, read only.
    expect(isClientMethod("places.list")).toBe(true)
    expect(isRoutedMethod("places.list")).toBe(true)
  })
})

describe("the switch in Allow <name>? (spec 012, 011)", () => {
  test("is on at first for a computer and off for a phone", () => {
    expect(defaultCanChange("computer")).toBe(true)
    expect(defaultCanChange("phone")).toBe(false)
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
