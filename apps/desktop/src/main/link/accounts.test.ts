import { describe, expect, test } from "bun:test"
import { CLIENT_METHODS, isClientMethod, isRoutedMethod } from "@robot/shared"
import { handlers, runRequest } from "../rpc.ts"
import { linkHandlers } from "./handlers.ts"

// A linked computer reaches only the requests that the link lists (spec 012). The accounts of a
// computer, their sign-ins and their keys are never on that list (spec 006).

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

const accountMethods = Object.keys(handlers).filter(
  (m) => m.startsWith("providers.") || m.startsWith("runtimes."),
)

describe("a linked device and the accounts of a computer", () => {
  test("the methods of accounts and sign-ins exist, including the new ones", () => {
    for (const method of [
      "providers.list",
      "providers.connect",
      "providers.check",
      "providers.disconnect",
      "providers.remove",
      "providers.models",
      "providers.setModel",
      "providers.setAllModels",
      "providers.addModel",
      "providers.removeModel",
      "providers.discardSignIn",
      "runtimes.status",
      "runtimes.install",
      "runtimes.signIn",
      "runtimes.cancel",
      "runtimes.repair",
      "runtimes.readOnly",
    ]) {
      expect(accountMethods).toContain(method)
    }
  })

  test("no account method is on the list of a client, on the list of the window for a server, or a link handler", () => {
    for (const method of accountMethods) {
      expect(isClientMethod(method)).toBe(false)
      expect(isRoutedMethod(method)).toBe(false)
      expect(linkHandlers[method]).toBeUndefined()
    }
    for (const method of CLIENT_METHODS) {
      expect(method).not.toMatch(/^(providers|runtimes)\./)
    }
  })

  test("a client that calls any account method is refused, and nothing runs", async () => {
    for (const method of accountMethods) {
      const result = await runRequest(
        untouched,
        method,
        { accountId: "a", kind: "claude_code", signIn: "abcdefgh-1234" },
        device,
      )
      expect(result).toEqual({
        ok: false,
        error: { code: "not_allowed", message: "Not allowed" },
      })
    }
  })
})
