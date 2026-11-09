import { execFile, execFileSync } from "node:child_process"
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
 * The git variables that always go, even when git cannot be asked (git is missing or too old
 * for `rev-parse --local-env-vars`). `GIT_NAMESPACE` and `GIT_CEILING_DIRECTORIES` are not local
 * to one repository, so git never prints them.
 */
const GIT_ENV_FALLBACK = [
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
] as const

/** The names that one query of git returned, asked once and kept. */
let scrubNames: readonly string[] | null = null

const scrubbedNames = (): readonly string[] => {
  if (scrubNames) return scrubNames
  const fallback = { ...process.env }
  for (const name of GIT_ENV_FALLBACK) delete fallback[name]
  try {
    const printed = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf8",
      timeout: 30_000,
      env: fallback,
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    scrubNames =
      printed.length > 0 ? [...new Set([...printed, ...GIT_ENV_FALLBACK])] : [...GIT_ENV_FALLBACK]
  } catch {
    scrubNames = [...GIT_ENV_FALLBACK]
  }
  return scrubNames
}

/**
 * The environment for a git call: without the variables that pin git to another repository.
 * A git hook runs with `GIT_DIR` set, and it would win over `-C`, so every spawn scrubs them.
 */
export const gitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const name of scrubbedNames()) delete env[name]
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

/** The root of the repository that holds the folder. It throws the reason from git. */
export const repoRoot = async (folder: string): Promise<string> => {
  try {
    const { stdout } = await runFile("git", ["-C", folder, "rev-parse", "--show-toplevel"], {
      timeout: 30_000,
      env: gitEnv(),
    })
    return stdout.trim()
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
