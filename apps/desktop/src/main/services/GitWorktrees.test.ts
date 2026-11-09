import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  branchExists,
  createWorktree,
  gitEnv,
  isInsideRepo,
  isWorktreeDirty,
  removeWorktree,
  repoRoot,
  slugOfName,
  worktreeStamp,
} from "./GitWorktrees.ts"

// The git work behind the switch "Work in a new worktree" (spec 007). The tests run against real
// temporary git repositories.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv() })

const emptyRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "robot-git-"))
  git(dir, "-c", "init.defaultBranch=main", "init", "--quiet")
  git(dir, "config", "user.email", "test@robot.local")
  git(dir, "config", "user.name", "ROBot test")
  return dir
}

const repo = () => {
  const dir = emptyRepo()
  writeFileSync(join(dir, "notes.md"), "first\n")
  git(dir, "add", "notes.md")
  git(dir, "commit", "--quiet", "-m", "first")
  return dir
}

const reasonOf = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return "made"
}

describe("is-inside-repo (spec 007, New worktree)", () => {
  test("a repository and a folder inside it are in; a plain or missing folder is out", async () => {
    const dir = repo()
    mkdirSync(join(dir, "inner"))
    expect(await isInsideRepo(dir)).toBe(true)
    expect(await isInsideRepo(join(dir, "inner"))).toBe(true)
    expect(await isInsideRepo(mkdtempSync(join(tmpdir(), "robot-plain-")))).toBe(false)
    expect(await isInsideRepo(join(dir, "missing"))).toBe(false)
  })

  test("repoRoot names the root from the root and from a folder inside it", async () => {
    const dir = repo()
    mkdirSync(join(dir, "inner"))
    expect(await repoRoot(join(dir, "inner"))).toBe(await repoRoot(dir))
    expect(await reasonOf(repoRoot(mkdtempSync(join(tmpdir(), "robot-plain-"))))).not.toBe("made")
  })

  test("a GIT_DIR in the environment does not pin git to another repository", async () => {
    // A git hook runs with GIT_DIR set. It would win over -C without the scrub.
    const dir = repo()
    const before = process.env.GIT_DIR
    process.env.GIT_DIR = join(dir, "..", "missing.git")
    try {
      expect(await isInsideRepo(dir)).toBe(true)
      expect(await isInsideRepo(mkdtempSync(join(tmpdir(), "robot-plain-")))).toBe(false)
    } finally {
      if (before === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = before
    }
  })
})

describe("the scrub of git variables", () => {
  test("gitEnv removes every variable that git rev-parse --local-env-vars prints, and the fallback", () => {
    const printed = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
      env: gitEnv(),
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    const names = [
      ...new Set([
        ...printed,
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_PREFIX",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_CEILING_DIRECTORIES",
      ]),
    ]
    expect(names.length).toBeGreaterThan(4)
    const before = new Map(names.map((name) => [name, process.env[name]] as const))
    for (const name of names) process.env[name] = "pinned"
    try {
      const env = gitEnv()
      for (const name of names) expect(env[name]).toBeUndefined()
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("a GIT_INDEX_FILE in the environment does not move the index of the repository", async () => {
    const dir = repo()
    const stray = join(mkdtempSync(join(tmpdir(), "robot-idx-")), "stray-index")
    const before = process.env.GIT_INDEX_FILE
    process.env.GIT_INDEX_FILE = stray
    try {
      const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
      await createWorktree(dir, path, "robot/report-20261109-120000")
      expect(readFileSync(join(path, "notes.md"), "utf8")).toBe("first\n")
      expect(git(dir, "status", "--porcelain")).toBe("")
      expect(existsSync(stray)).toBe(false)
    } finally {
      if (before === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = before
    }
  })
})

describe("make worktree (spec 007, New worktree)", () => {
  test("it holds the files of the last commit on a new branch, without uncommitted changes", async () => {
    const dir = repo()
    writeFileSync(join(dir, "notes.md"), "changed but not committed\n")
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    await createWorktree(dir, path, "robot/report-20261109-120000")
    expect(readFileSync(join(path, "notes.md"), "utf8")).toBe("first\n")
    expect(git(dir, "rev-parse", "--verify", "robot/report-20261109-120000").trim()).toBe(
      git(dir, "rev-parse", "HEAD").trim(),
    )
    expect(git(dir, "worktree", "list", "--porcelain").trim()).toContain(path)
  })

  test("it fails with a reason when the repository has no commit", async () => {
    const dir = emptyRepo()
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    const reason = await reasonOf(createWorktree(dir, path, "robot/report-20261109-120000"))
    expect(reason).not.toBe("made")
    expect(reason.length).toBeGreaterThan(0)
    expect(existsSync(path)).toBe(false)
  })

  test("it fails with a reason when the branch or the path is taken", async () => {
    const dir = repo()
    const root = mkdtempSync(join(tmpdir(), "robot-wt-"))
    await createWorktree(dir, join(root, "first"), "robot/report-20261109-120000")
    expect(
      await reasonOf(createWorktree(dir, join(root, "second"), "robot/report-20261109-120000")),
    ).not.toBe("made")
    expect(
      await reasonOf(createWorktree(dir, join(root, "first"), "robot/other-20261109-120000")),
    ).not.toBe("made")
  })
})

describe("dirty and remove (spec 007, New worktree)", () => {
  test("a fresh worktree is clean; a changed or new file makes it dirty", async () => {
    const dir = repo()
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    await createWorktree(dir, path, "robot/report-20261109-120000")
    expect(await isWorktreeDirty(path)).toBe(false)
    writeFileSync(join(path, "notes.md"), "changed\n")
    expect(await isWorktreeDirty(path)).toBe(true)
    git(path, "checkout", "--", "notes.md")
    expect(await isWorktreeDirty(path)).toBe(false)
    writeFileSync(join(path, "new.md"), "new\n")
    expect(await isWorktreeDirty(path)).toBe(true)
  })

  test("remove deletes the folder only: the branch stays and the worktree leaves the list", async () => {
    const dir = repo()
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    await createWorktree(dir, path, "robot/report-20261109-120000")
    writeFileSync(join(path, "notes.md"), "changed\n")
    await removeWorktree(dir, path)
    expect(existsSync(path)).toBe(false)
    expect(await branchExists(dir, "robot/report-20261109-120000")).toBe(true)
    expect(git(dir, "worktree", "list", "--porcelain").trim()).not.toContain(path)
  })
})

describe("names (spec 007, New worktree)", () => {
  test("the slug is lower case without runs of other characters, at most 24", () => {
    expect(slugOfName("Weekly Report!")).toBe("weekly-report")
    expect(slugOfName("  -Ada- ")).toBe("ada")
    expect(slugOfName("한국어")).toBe("")
    expect(slugOfName("a".repeat(40)).length).toBe(24)
  })

  test("the stamp is the local time as yyyyMMdd-HHmmss", () => {
    expect(worktreeStamp(new Date(2026, 10, 9, 8, 5, 4))).toBe("20261109-080504")
  })
})
