import { describe, expect, test } from "bun:test"
import { loginFailure, readiness, startFailure, versionProbe } from "./readiness.ts"
import type { Login } from "./types.ts"

const ended = (over: Partial<{ code: number | null; failure: string }> = {}) => ({
  code: 0 as number | null,
  stdout: "",
  stderr: "",
  ...over,
})
const signedIn: Login = { signedIn: true, method: "subscription", user: "a@b.c", plan: "max" }

describe("the answer to the version question", () => {
  test("a version in the answer is a program that works", () => {
    expect(versionProbe(ended(), "1.2.3")).toEqual({ version: "1.2.3" })
  })

  test("no answer in time is a program that does not answer", () => {
    expect(versionProbe(ended({ code: null, failure: "timeout" }), null)).toEqual({
      fail: "answer",
    })
  })

  test("a program that cannot run, or ends with an error, does not start", () => {
    expect(versionProbe(ended({ code: null, failure: "spawn" }), null)).toEqual({ fail: "start" })
    expect(versionProbe(ended({ code: 127 }), null)).toEqual({ fail: "start" })
    expect(versionProbe(ended({ code: 1 }), "1.2.3")).toEqual({ fail: "start" })
  })

  test("an answer that ends well and has no version is an answer that the app cannot read", () => {
    expect(versionProbe(ended(), null)).toEqual({ fail: "unreadable" })
  })
})

describe("the answer to the sign-in question", () => {
  test("a timeout and a program that cannot run are told apart; any other end is read by the driver", () => {
    expect(loginFailure(ended({ code: null, failure: "timeout" }))).toBe("answer")
    expect(loginFailure(ended({ code: null, failure: "spawn" }))).toBe("start")
    expect(loginFailure(ended({ code: 1 }))).toBeNull()
    expect(loginFailure(ended())).toBeNull()
  })
})

describe("the state after a check", () => {
  test("no place and no memory of one is Not installed", () => {
    expect(readiness({ located: false, knownBefore: false })).toEqual({
      state: "not_installed",
      reason: null,
    })
  })

  test("a place that was known and is gone is Needs repair, with the reason gone", () => {
    expect(readiness({ located: false, knownBefore: true })).toEqual({
      state: "needs_repair",
      reason: "gone",
    })
  })

  test("a program that is found but does not pass is Needs repair, with the reason of the probe", () => {
    for (const fail of ["start", "answer", "unreadable"] as const)
      expect(
        readiness({ located: true, knownBefore: true, probe: { fail }, login: signedIn }),
      ).toEqual({ state: "needs_repair", reason: fail })
  })

  test("a program that answers the version but not the sign-in question needs repair", () => {
    expect(
      readiness({
        located: true,
        knownBefore: true,
        probe: { version: "1.0.0" },
        login: { signedIn: false, method: null, user: null, plan: null, fail: "answer" },
      }),
    ).toEqual({ state: "needs_repair", reason: "answer" })
  })

  test("a program that works and is signed in with a subscription is Ready", () => {
    expect(
      readiness({ located: true, knownBefore: true, probe: { version: "1.0.0" }, login: signedIn }),
    ).toEqual({ state: "ready", reason: null })
  })

  test("a program that works and is signed out, or signed in with a key, Needs sign-in", () => {
    const base = { located: true, knownBefore: true, probe: { version: "1.0.0" } }
    expect(
      readiness({
        ...base,
        login: { signedIn: false, method: null, user: null, plan: null },
      }),
    ).toEqual({ state: "needs_sign_in", reason: null })
    expect(
      readiness({
        ...base,
        login: { signedIn: true, method: "api_key", user: null, plan: null },
      }),
    ).toEqual({ state: "needs_sign_in", reason: null })
  })
})

describe("a turn that cannot start the program", () => {
  test("a missing file and a file that cannot run are told apart", () => {
    const missing = Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" })
    const denied = Object.assign(new Error("spawn x EACCES"), { code: "EACCES" })
    expect(startFailure(missing, null)?.code).toBe("runtime_start")
    expect(startFailure(missing, null)?.message).toBe("gone")
    expect(startFailure(denied, null)?.message).toBe("start")
  })

  test("the codes 126 and 127 of a shell are a program that does not start", () => {
    expect(startFailure(undefined, 126)?.code).toBe("runtime_start")
    expect(startFailure(undefined, 127)?.code).toBe("runtime_start")
  })

  test("any other end is not a failure to start", () => {
    expect(startFailure(undefined, 0)).toBeNull()
    expect(startFailure(undefined, 1)).toBeNull()
    expect(startFailure(undefined, null)).toBeNull()
  })
})
