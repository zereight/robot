import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

/**
 * The git work behind the switch "Work in a new worktree" (spec 007, "New worktree"). Every call
 * spawns `git` with an argument array, never a shell string, so a folder or branch name cannot
 * smuggle in another command. A failure throws an `Error` whose message is the reason from git.
 */

const runFile = promisify(execFile)

/**
 * The environment for a git call: without the variables that pin git to another repository.
 * A git hook runs with `GIT_DIR` set, and it would win over `-C`, so every spawn scrubs them.
 */
export const gitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_CEILING_DIRECTORIES
  delete env.GIT_COMMON_DIR
  return env
}

/** The longest reason that a failure carries. Git can write pages; the run view shows one line. */
const REASON_MAX = 500

const gitReason = (error: unknown): string => {
  const stderr =
    error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : ""
  const text = stderr !== "" ? stderr : error instanceof Error ? error.message : String(error)
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text
}

/**
 * True when the folder or a folder above it holds a `.git` entry. It spawns nothing, so the list
 * of workflows can ask it for each workflow (the field `folderInGit`).
 */
export const folderHasGit = (folder: string): boolean => {
  let at = folder
  for (;;) {
    if (existsSync(join(at, ".git"))) return true
    const up = dirname(at)
    if (up === at) return false
    at = up
  }
}

/** True when the folder is inside the work tree of a Git repository. */
export const isInsideRepo = async (folder: string): Promise<boolean> => {
  try {
    const { stdout } = await runFile("git", ["-C", folder, "rev-parse", "--is-inside-work-tree"], {
      timeout: 30_000,
      env: gitEnv(),
    })
    return stdout.trim() === "true"
  } catch {
    return false
  }
}

/**
 * Makes a new linked worktree at `path` on a new `branch` from HEAD of the repository of `repo`.
 * Changes of the repository that are not committed are not in it. The path must not exist yet.
 */
export const createWorktree = async (repo: string, path: string, branch: string): Promise<void> => {
  try {
    await runFile("git", ["-C", repo, "worktree", "add", "-b", branch, path, "HEAD"], {
      timeout: 120_000,
      env: gitEnv(),
    })
  } catch (error) {
    throw new Error(gitReason(error))
  }
}

/** True when the worktree holds changes that are not committed, including new files. */
export const isWorktreeDirty = async (path: string): Promise<boolean> => {
  try {
    const { stdout } = await runFile("git", ["-C", path, "status", "--porcelain"], {
      timeout: 60_000,
      env: gitEnv(),
    })
    return stdout.trim() !== ""
  } catch (error) {
    throw new Error(gitReason(error))
  }
}

/**
 * Removes the folder of a worktree. The branch stays. The caller asks first when the worktree
 * holds changes that are not committed (spec 007), so `--force` only carries out that answer.
 */
export const removeWorktree = async (repo: string, path: string): Promise<void> => {
  try {
    await runFile("git", ["-C", repo, "worktree", "remove", "--force", path], {
      timeout: 120_000,
      env: gitEnv(),
    })
  } catch (error) {
    throw new Error(gitReason(error))
  }
}

/** True when the repository has a branch of this name. */
export const branchExists = async (repo: string, branch: string): Promise<boolean> => {
  try {
    await runFile("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      timeout: 30_000,
      env: gitEnv(),
    })
    return true
  } catch {
    return false
  }
}

/** A folder and branch name made from a workflow name: lower case, runs of other marks as one `-`. */
export const slugOfName = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)

/** The local time as `yyyyMMdd-HHmmss`, for the branch and the folder of a new worktree. */
export const worktreeStamp = (at: Date): string => {
  const two = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
}
