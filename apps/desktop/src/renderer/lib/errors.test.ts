import { describe, expect, test } from "bun:test"
import { describeError } from "./errors.ts"
import { RpcFailure } from "./rpc.ts"

// The renderer picks an `error.*` key by the code of the failure (spec 007, "New worktree").
describe("worktree errors", () => {
  for (const code of ["worktree_not_git", "worktree_failed", "worktree_unavailable"] as const) {
    test(`${code} reads its own key, not the unknown error`, () => {
      expect(describeError(new RpcFailure({ code, message: "detail" })).key).toBe(`error.${code}`)
    })
  }
})
