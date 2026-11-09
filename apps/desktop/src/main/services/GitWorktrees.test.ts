import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  branchExists,
  createWorktree,
  deleteAttemptBranch,
  gitEnv,
  gitScrubReady,
  headCommit,
  isInsideRepo,
  isWorktreeDirty,
  isWorktreeRegistered,
  removeAttemptWorktree,
  removeWorktree,
  repoRoot,
  scrubGitEnv,
  slugOfName,
  uniqueBranch,
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

const untilFile = async (file: string, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (existsSync(file)) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`missing file: ${file}`)
}

const until = async (ok: () => boolean | Promise<boolean>, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error("timeout")
}

const pgrep = (text: string): boolean => {
  try {
    execFileSync("pgrep", ["-f", text], { encoding: "utf8" })
    return true
  } catch {
    return false
  }
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
  test("gitEnv removes every variable that git rev-parse --local-env-vars prints, and the fallback", async () => {
    // The list from git fills in without blocking; the fallback scrubs until it lands.
    await gitScrubReady()
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
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
        "GIT_SHALLOW_FILE",
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

  test("scrubGitEnv removes the git variables from a given environment and keeps the rest", async () => {
    await gitScrubReady()
    const env = scrubGitEnv({
      GIT_DIR: "pinned",
      GIT_INDEX_FILE: "pinned",
      GIT_WORK_TREE: "pinned",
      HOME: "/home/a",
      KEEP: "yes",
    })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.HOME).toBe("/home/a")
    expect(env.KEEP).toBe("yes")
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

  test("it makes nothing when the signal is already aborted", async () => {
    const dir = repo()
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    const reason = await reasonOf(
      createWorktree(dir, path, "robot/report-20261109-120000", AbortSignal.abort()),
    )
    expect(reason).not.toBe("made")
    expect(existsSync(path)).toBe(false)
  })

  test("an abort mid-way ends the whole group and fails, with no leftover process", async () => {
    const dir = repo()
    const started = join(dir, "hook-started")
    const release = join(dir, "hook-release")
    const hook = join(dir, ".git", "hooks", "post-checkout")
    writeFileSync(
      hook,
      `#!/bin/sh\ntouch ${started}\nwhile [ ! -f ${release} ]; do sleep 0.05; done\n`,
    )
    chmodSync(hook, 0o755)
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    const controller = new AbortController()
    const made = createWorktree(dir, path, "robot/report-20261109-120000", controller.signal)
    try {
      await untilFile(started)
      controller.abort()
      expect(await reasonOf(made)).not.toBe("made")
      await until(() => !pgrep(hook))
    } finally {
      writeFileSync(release, "go\n")
    }
  })

  test("an abort after git exited 0 keeps the finished worktree, with no leftover process", async () => {
    const dir = repo()
    const started = join(dir, "hook-started")
    const held = join(dir, "hook-held")
    const release = join(dir, "hook-release")
    const hook = join(dir, ".git", "hooks", "post-checkout")
    // The hook exits at once, but a background child holds the stderr pipe until the release
    // file appears: the close of the pipes lands long after the exit of git.
    writeFileSync(
      hook,
      `#!/bin/sh\ntouch ${started}\n(touch ${held}; while [ ! -f ${release} ]; do sleep 0.05; done) &\n`,
    )
    chmodSync(hook, 0o755)
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    const controller = new AbortController()
    const made = createWorktree(dir, path, "robot/report-20261109-120000", controller.signal)
    try {
      await untilFile(started)
      await untilFile(held)
      // Git has exited; the pipes are still open. The abort comes late.
      await made
      controller.abort()
      writeFileSync(release, "go\n")
      expect(readFileSync(join(path, "notes.md"), "utf8")).toBe("first\n")
      expect(git(dir, "worktree", "list", "--porcelain")).toContain(path)
      await until(() => !pgrep(hook))
    } finally {
      writeFileSync(release, "go\n")
    }
  })

  test("a timeout ends the whole group, with no leftover child", async () => {
    const dir = repo()
    const started = join(dir, "hook-started")
    const release = join(dir, "hook-release")
    const hook = join(dir, ".git", "hooks", "post-checkout")
    writeFileSync(
      hook,
      `#!/bin/sh\ntouch ${started}\nn=0\nwhile [ ! -f ${release} ] && [ $n -lt 2400 ]; do sleep 0.05; n=$((n+1)); done\n`,
    )
    chmodSync(hook, 0o755)
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    let arm!: () => void
    const armed = new Promise<void>((resolve) => {
      arm = resolve
    })
    const made = createWorktree(dir, path, "robot/report-20261109-120000", undefined, 1500, armed)
    try {
      // The timeout starts counting only after the hook proves git is mid-flight, so a slow
      // machine cannot fire it before git runs. The hook waits for the release that only the
      // finally below writes, so the rejection must come from the timer.
      await untilFile(started)
      arm()
      expect(await reasonOf(made)).not.toBe("made")
      await until(() => !pgrep(hook))
    } finally {
      arm()
      writeFileSync(release, "go\n")
      await until(() => !pgrep(hook))
      expect(pgrep(hook)).toBe(false)
    }
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

  test("a worktree and the main checkout are registered; a plain or missing folder is not", async () => {
    const dir = repo()
    const path = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "copy")
    await createWorktree(dir, path, "robot/report-20261109-120000")
    expect(await isWorktreeRegistered(path)).toBe(true)
    expect(await isWorktreeRegistered(dir)).toBe(true)
    expect(await isWorktreeRegistered(mkdtempSync(join(tmpdir(), "robot-plain-")))).toBe(false)
    expect(await isWorktreeRegistered(join(dir, "missing"))).toBe(false)
  })
})

describe("remove one attempt (spec 007, New worktree)", () => {
  test("it removes a registered folder and its entry", async () => {
    const dir = repo()
    const mine = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "mine")
    await createWorktree(dir, mine, "robot/mine-20261109-120000")
    writeFileSync(join(mine, "half.md"), "half\n")
    await removeAttemptWorktree(dir, mine)
    expect(existsSync(mine)).toBe(false)
    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(mine)
  })

  test("it drops only its own stale entry and keeps another one", async () => {
    const dir = repo()
    const root = mkdtempSync(join(tmpdir(), "robot-wt-"))
    const mine = join(root, "mine")
    await createWorktree(dir, mine, "robot/mine-20261109-120000")
    const other = join(root, "other")
    git(dir, "worktree", "add", "--quiet", "-b", "robot/other-20261109-120000", other)
    // Both folders go away: both entries are stale. A prune would drop both.
    rmSync(mine, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
    await removeAttemptWorktree(dir, mine)
    const listed = git(dir, "worktree", "list", "--porcelain")
    expect(listed).not.toContain(mine)
    expect(listed).toContain(other)
  })

  test("it removes an unregistered half-made folder and touches no entry", async () => {
    const dir = repo()
    const half = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "half")
    mkdirSync(half, { recursive: true })
    writeFileSync(join(half, "half.md"), "half\n")
    const before = git(dir, "worktree", "list", "--porcelain")
    await removeAttemptWorktree(dir, half)
    expect(existsSync(half)).toBe(false)
    expect(git(dir, "worktree", "list", "--porcelain")).toBe(before)
  })

  test("it throws nothing for a missing folder with no entry", async () => {
    const dir = repo()
    await removeAttemptWorktree(dir, join(mkdtempSync(join(tmpdir(), "robot-wt-")), "missing"))
  })
})

describe("delete one attempt branch (spec 007, New worktree)", () => {
  const headOf = (dir: string) => git(dir, "rev-parse", "HEAD").trim()

  test("it deletes a branch the attempt made and left alone", async () => {
    const dir = repo()
    const base = headOf(dir)
    expect(await headCommit(dir)).toBe(base)
    git(dir, "branch", "robot/mine-20261109-120000")
    await deleteAttemptBranch(dir, "robot/mine-20261109-120000", false, base)
    expect(await branchExists(dir, "robot/mine-20261109-120000")).toBe(false)
  })

  test("it keeps a branch that existed before the attempt", async () => {
    const dir = repo()
    git(dir, "branch", "robot/old-20261109-120000")
    await deleteAttemptBranch(dir, "robot/old-20261109-120000", true, headOf(dir))
    expect(await branchExists(dir, "robot/old-20261109-120000")).toBe(true)
  })

  test("it keeps a branch whose tip moved past the base commit", async () => {
    const dir = repo()
    writeFileSync(join(dir, "second.md"), "second\n")
    git(dir, "add", "second.md")
    git(dir, "commit", "--quiet", "-m", "second")
    const first = git(dir, "rev-parse", "HEAD~1").trim()
    git(dir, "branch", "robot/mine-20261109-120000", first)
    await deleteAttemptBranch(dir, "robot/mine-20261109-120000", false, headOf(dir))
    expect(await branchExists(dir, "robot/mine-20261109-120000")).toBe(true)
    expect(git(dir, "rev-parse", "robot/mine-20261109-120000").trim()).toBe(first)
  })

  test("it keeps a branch that a worktree has checked out", async () => {
    const dir = repo()
    git(dir, "branch", "robot/mine-20261109-120000")
    const other = join(mkdtempSync(join(tmpdir(), "robot-wt-")), "other")
    git(dir, "worktree", "add", "--quiet", other, "robot/mine-20261109-120000")
    await deleteAttemptBranch(dir, "robot/mine-20261109-120000", false, headOf(dir))
    expect(await branchExists(dir, "robot/mine-20261109-120000")).toBe(true)
  })

  test("it keeps a branch when the base commit is unknown, and throws nothing when it is missing", async () => {
    const dir = repo()
    git(dir, "branch", "robot/mine-20261109-120000")
    await deleteAttemptBranch(dir, "robot/mine-20261109-120000", false, null)
    expect(await branchExists(dir, "robot/mine-20261109-120000")).toBe(true)
    expect(await headCommit(mkdtempSync(join(tmpdir(), "robot-plain-")))).toBeNull()
    await deleteAttemptBranch(dir, "robot/missing-20261109-120000", false, headOf(dir))
  })

  test("branchExists reads a failure as exists, so no failure deletes a branch", async () => {
    const dir = repo()
    expect(await branchExists(dir, "main")).toBe(true)
    expect(await branchExists(dir, "missing")).toBe(false)
    expect(await branchExists(mkdtempSync(join(tmpdir(), "robot-plain-")), "missing")).toBe(true)
  })

  test("uniqueBranch takes the name when git cannot be asked, instead of spinning", async () => {
    expect(await uniqueBranch(mkdtempSync(join(tmpdir(), "robot-plain-")), "robot/x")).toBe(
      "robot/x",
    )
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

  test("the branch takes -2 and up while the repository holds the name", async () => {
    const dir = repo()
    git(dir, "branch", "robot/report-20261109-120000")
    git(dir, "branch", "robot/report-20261109-120000-2")
    expect(await uniqueBranch(dir, "robot/report-20261109-120000")).toBe(
      "robot/report-20261109-120000-3",
    )
    expect(await uniqueBranch(dir, "robot/other-20261109-120000")).toBe(
      "robot/other-20261109-120000",
    )
  })
})
