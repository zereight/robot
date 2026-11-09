import { describe, expect, test } from "bun:test"
import { worktreeSwitch } from "./worktreeSwitch.ts"

describe("the state of the switch Work in a new worktree", () => {
  const base = { newWorktree: false, folderInGit: true, running: false }

  test("a folder in Git can turn it on", () => {
    expect(worktreeSwitch(base)).toEqual({ disabled: false, showNotGit: false })
  })

  test("a folder outside Git cannot turn it on and shows the muted line", () => {
    expect(worktreeSwitch({ ...base, folderInGit: false })).toEqual({
      disabled: true,
      showNotGit: true,
    })
  })

  test("a switch that is on stays free to turn off when the folder left Git", () => {
    expect(worktreeSwitch({ newWorktree: true, folderInGit: false, running: false }).disabled).toBe(
      false,
    )
  })

  test("a run that works makes the switch read-only", () => {
    expect(worktreeSwitch({ ...base, running: true }).disabled).toBe(true)
  })
})
