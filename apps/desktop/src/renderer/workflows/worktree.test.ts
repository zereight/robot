import { describe, expect, test } from "bun:test"
import { type MessageKey, translate } from "@robot/shared"

// Spec 007, "New worktree": the exact sentences of the switch and the run line.

const en = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("en", key, params)
const ko = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("ko", key, params)

describe("the new worktree switch", () => {
  test("the switch reads as the spec names it", () => {
    expect(en("workflow.newWorktree")).toBe("Work in a new worktree")
    expect(ko("workflow.newWorktree")).toBe("새 워크트리에서 작업")
  })

  test("a folder outside Git reads as the muted line of the spec", () => {
    expect(en("error.worktree_not_git")).toBe("The folder is not in a Git repository.")
    expect(ko("error.worktree_not_git")).toBe("이 폴더는 Git 리포지토리 안에 있지 않아요.")
  })
})

describe("the worktree line of a run", () => {
  test("a run with a worktree names its path and its branch", () => {
    expect(en("runs.worktree", { path: "/tmp/w", branch: "robot/a-1" })).toBe(
      "Worktree: /tmp/w, branch robot/a-1",
    )
    expect(ko("runs.worktree", { path: "/tmp/w", branch: "robot/a-1" })).toBe(
      "워크트리: /tmp/w, 브랜치 robot/a-1",
    )
  })

  test("a removed worktree names its branch and offers no buttons", () => {
    expect(en("runs.worktree.removed", { branch: "robot/a-1" })).toBe(
      "Worktree removed, branch robot/a-1",
    )
    expect(ko("runs.worktree.removed", { branch: "robot/a-1" })).toBe(
      "워크트리를 제거했어요, 브랜치 robot/a-1",
    )
  })

  test("the buttons read Open and Remove", () => {
    expect(en("runs.worktree.open")).toBe("Open")
    expect(ko("runs.worktree.open")).toBe("열기")
    expect(en("runs.worktree.remove")).toBe("Remove")
    expect(ko("runs.worktree.remove")).toBe("제거")
  })

  test("the remove question names the path and the uncommitted changes", () => {
    expect(en("runs.worktree.remove.ask", { path: "/tmp/w" })).toBe(
      "Remove the worktree at /tmp/w? It holds changes that are not committed.",
    )
    expect(ko("runs.worktree.remove.ask", { path: "/tmp/w" })).toBe(
      "워크트리 /tmp/w을(를) 제거할까요? 커밋하지 않은 변경 사항이 있어요.",
    )
  })
})

describe("the worktree errors", () => {
  test("a worktree that could not be made names the reason", () => {
    expect(en("error.worktree_failed", { detail: "the disk is full" })).toBe(
      "Could not make a new worktree: the disk is full",
    )
    expect(ko("error.worktree_failed", { detail: "the disk is full" })).toBe(
      "새 워크트리를 만들지 못했어요: the disk is full",
    )
  })

  test("an unavailable worktree says so", () => {
    expect(en("error.worktree_unavailable")).toBe("The new worktree is not available.")
    expect(ko("error.worktree_unavailable")).toBe("새 워크트리를 쓸 수 없어요.")
  })
})
