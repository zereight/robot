import { describe, expect, test } from "bun:test"
import { createSendGate, filesAfterSend, textAfterSend } from "./sending.ts"

describe("createSendGate", () => {
  test("a second tap while the first send runs does not start another", () => {
    const gate = createSendGate()
    expect(gate.enter()).toBe(true)
    expect(gate.enter()).toBe(false)
    expect(gate.busy()).toBe(true)
  })

  test("after the send ends, the next send can start", () => {
    const gate = createSendGate()
    gate.enter()
    gate.leave()
    expect(gate.busy()).toBe(false)
    expect(gate.enter()).toBe(true)
  })

  test("a send that fails leaves the gate open when the caller leaves in a finally", async () => {
    const gate = createSendGate()
    const run = async () => {
      if (!gate.enter()) return "skipped"
      try {
        throw new Error("offline")
      } finally {
        gate.leave()
      }
    }
    await expect(run()).rejects.toThrow("offline")
    await expect(run()).rejects.toThrow("offline")
  })

  test("two taps in the same turn of the event loop send once", async () => {
    const gate = createSendGate()
    let sent = 0
    const tap = async () => {
      if (!gate.enter()) return
      try {
        await Promise.resolve()
        sent += 1
      } finally {
        gate.leave()
      }
    }
    await Promise.all([tap(), tap()])
    expect(sent).toBe(1)
  })
})

describe("textAfterSend", () => {
  test("the box is cleared when it holds what went out", () => {
    expect(textAfterSend("hello ", "hello ")).toBe("")
  })

  test("text that the user typed during the send stays", () => {
    expect(textAfterSend("hello and more", "hello")).toBe("hello and more")
  })

  test("an emptied box stays empty", () => {
    expect(textAfterSend("", "hello")).toBe("")
  })
})

describe("filesAfterSend", () => {
  const a = { uri: "a" }
  const b = { uri: "b" }
  const c = { uri: "c" }

  test("the files that went out leave the box", () => {
    expect(filesAfterSend([a, b], [a, b])).toEqual([])
  })

  test("a file that was added during the send stays", () => {
    expect(filesAfterSend([a, b, c], [a, b])).toEqual([c])
  })

  test("a file that the user removed during the send does not come back", () => {
    expect(filesAfterSend([b], [a, b])).toEqual([])
  })
})
