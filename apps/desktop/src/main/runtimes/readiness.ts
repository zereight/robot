import type { RepairReason, RuntimeState } from "@robot/shared"
import { ProviderFailure } from "../providers/client.ts"
import type { Finished } from "./proc.ts"
import type { Login } from "./types.ts"

/** What the first question to a program, its version, came to. */
export type VersionProbe = { readonly version: string } | { readonly fail: RepairReason }

/**
 * Reads the end of a program that was asked for its version. `version` is what the driver found
 * in the output, or null. A program that could not start, or that ended with an error, does not
 * start; one that did not end in time does not answer; one that ended well with no version in its
 * output gave an answer that the app cannot read.
 */
export const versionProbe = (done: Finished, version: string | null): VersionProbe => {
  if (done.failure === "timeout") return { fail: "answer" }
  if (done.failure !== undefined || done.code !== 0) return { fail: "start" }
  return version ? { version } : { fail: "unreadable" }
}

/**
 * Reads the end of a program that was asked for the sign-in state. A timeout is no answer, and a
 * program that could not start does not start. Other ends say something the driver can read.
 */
export const loginFailure = (done: Finished): RepairReason | null =>
  done.failure === "timeout" ? "answer" : done.failure !== undefined ? "start" : null

export interface Readiness {
  readonly state: RuntimeState
  readonly reason: RepairReason | null
}

/** What a check found. */
export interface CheckFacts {
  /** The program is at a place now. */
  readonly located: boolean
  /** The app knew a place for the program before: its copy, a path it kept, or a path that was set. */
  readonly knownBefore: boolean
  /** The answer to the version question. Absent when the program was not located. */
  readonly probe?: VersionProbe
  /** The answer to the sign-in question. Absent when the version question failed. */
  readonly login?: Login
}

/**
 * The state of a program after a check (spec 006). "Found" is not "Ready": the program has to
 * start and answer. No place and no memory of one is "Not installed"; a place that is gone, or a
 * program that fails, is "Needs repair".
 */
export const readiness = (facts: CheckFacts): Readiness => {
  if (!facts.located)
    return facts.knownBefore
      ? { state: "needs_repair", reason: "gone" }
      : { state: "not_installed", reason: null }
  if (!facts.probe || "fail" in facts.probe)
    return { state: "needs_repair", reason: facts.probe?.fail ?? "answer" }
  const login = facts.login
  if (!login) return { state: "needs_repair", reason: "answer" }
  if (login.fail) return { state: "needs_repair", reason: login.fail }
  // A program signed in with a key, not a subscription, cannot serve an account: it needs the
  // user to sign in again.
  return login.signedIn && login.method === "subscription"
    ? { state: "ready", reason: null }
    : { state: "needs_sign_in", reason: null }
}

/**
 * The failure of a turn whose program could not start: the system could not run the file, or the
 * shell said that it could not run it or find it (codes 126 and 127). The detail is the reason
 * that the row of the program shows. Null when the program did start.
 */
export const startFailure = (
  error: Error | undefined,
  code: number | null,
): ProviderFailure | null => {
  if (error)
    return new ProviderFailure(
      "runtime_start",
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "start",
    )
  return code === 126 || code === 127 ? new ProviderFailure("runtime_start", "start") : null
}
