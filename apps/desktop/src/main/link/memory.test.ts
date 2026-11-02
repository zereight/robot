import { describe, expect, test } from "bun:test"
import { CLIENT_METHODS, isChangeMethod, isClientMethod, isRoutedMethod } from "@robot/shared"
import { handlers, runRequest } from "../rpc.ts"
import { linkHandlers } from "./handlers.ts"

// A client cannot see memory proposals, the history of memory, or the choice of how an agent
// saves (spec 012, 008). Those requests are on no list of a linked device.

/** A runtime that fails when anything uses it: a refused request must not reach a service. */
const untouched = new Proxy(
  {},
  {
    get: () => {
      throw new Error("the request reached the runtime")
    },
  },
) as never

const device = { id: "dev-1", name: "Phone" }

const controlMethods = [
  "memory.mode",
  "memory.setMode",
  "memory.proposals",
  "memory.proposal.accept",
  "memory.proposal.dismiss",
  "memory.history",
  "memory.history.get",
  "memory.undo",
]

describe("a linked device and the control of memory", () => {
  test("the new requests exist in the window of this computer", () => {
    for (const method of controlMethods) expect(Object.keys(handlers)).toContain(method)
  })

  test("none of them is on the list of a client, on the list of the window for a server, or a link handler", () => {
    for (const method of controlMethods) {
      expect(isClientMethod(method)).toBe(false)
      expect(isRoutedMethod(method)).toBe(false)
      expect(isChangeMethod(method)).toBe(false)
      expect(linkHandlers[method]).toBeUndefined()
    }
    for (const method of CLIENT_METHODS) {
      expect(method).not.toMatch(/^memory\.(mode|setMode|proposal|history|undo)/)
    }
  })

  test("a client that calls any of them is refused, and nothing runs", async () => {
    for (const method of controlMethods) {
      const result = await runRequest(
        untouched,
        method,
        { agentId: "a", id: "x", mode: "ask" },
        device,
      )
      expect(result).toEqual({
        ok: false,
        error: { code: "not_allowed", message: "Not allowed" },
      })
    }
  })
})
