import { execFile, spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
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
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_SHALLOW_FILE",
] as const

/** The names that the one query of git returned, asked once and kept. */
let scrubNames: readonly string[] | null = null
let scrubFill: Promise<void> | null = null

/**
 * Asks git once for its local variables, without blocking: the fixed fallback scrubs until the
 * answer lands, so the first call never holds the main process.
 */
const fillScrubNames = (): Promise<void> =>
  (scrubFill ??= (async () => {
    const fallback = { ...process.env }
    for (const name of GIT_ENV_FALLBACK) delete fallback[name]
    try {
      const { stdout } = await runFile("git", ["rev-parse", "--local-env-vars"], {
        timeout: 30_000,
        env: fallback,
      })
      const printed = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
      scrubNames =
        printed.length > 0 ? [...new Set([...printed, ...GIT_ENV_FALLBACK])] : [...GIT_ENV_FALLBACK]
    } catch {
      scrubNames = [...GIT_ENV_FALLBACK]
    }
  })())

const scrubbedNames = (): readonly string[] => {
  void fillScrubNames()
  return scrubNames ?? GIT_ENV_FALLBACK
}

/**
 * The environment without the variables that pin git to another repository. A git hook runs with
 * `GIT_DIR` set, and it would win over `-C`, so every spawn scrubs them. Shell commands and vendor
 * programs use it too, so a `git` they run cannot reach another repository.
 */
export const scrubGitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out = { ...env }
  for (const name of scrubbedNames()) delete out[name]
  return out
}

/** The environment for a git call: the process environment with the git variables scrubbed. */
export const gitEnv = (): NodeJS.ProcessEnv => scrubGitEnv(process.env)

/** Waits for the one query of git behind the scrub. Tests await it; the app never blocks on it. */
export const gitScrubReady = (): Promise<void> => fillScrubNames()

/** The longest reason that a failure carries. Git can write pages; the run view shows one line. */
const REASON_MAX = 500

const capReason = (text: string): string =>
  text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text

const gitReason = (error: unknown): string => {
  const stderr =
    error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : ""
  const text = stderr !== "" ? stderr : error instanceof Error ? error.message : String(error)
  return capReason(text)
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
 * An aborted `signal` ends the whole process group and fails only after git has ended, so the
 * caller can remove the half-made folder without git still writing into it. The timeout counts
 * from the spawn of git, or from `armAfter` when given: a test arms it after its hook marker
 * exists, so a slow machine cannot fire it before git runs.
 */
export const createWorktree = async (
  repo: string,
  path: string,
  branch: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  armAfter?: Promise<unknown>,
): Promise<void> => {
  signal?.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "worktree", "add", "-b", branch, path, "HEAD"], {
      env: gitEnv(),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      // Its own process group: an abort or a timeout ends a slow hook with git, not only git.
      detached: true,
    })
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < REASON_MAX * 4) stderr += chunk.toString()
    })
    let finished = false
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {
          // The process is gone already.
        }
      }
    }
    const onAbort = () => {
      if (finished) return
      killGroup()
      // Nothing waits on the pipes then: the rejection lands on the exit of git.
      child.stderr?.destroy()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (finished || timer !== undefined) return
      timer = setTimeout(() => {
        if (finished) return
        killGroup()
        child.stderr?.destroy()
      }, timeoutMs)
    }
    if (armAfter !== undefined) void armAfter.then(arm, arm)
    else arm()
    const done = (work: () => void) => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      work()
    }
    const abortError = () =>
      signal?.reason instanceof Error ? signal.reason : new Error("The operation was aborted")
    // The end is decided by the exit of git, not by the close of the pipes: a hook child that
    // outlives git keeps the pipes open. A git that exited 0 is a success even when the abort
    // came late; the caller ends the stopped run with its made worktree.
    child.on("exit", (code) => {
      if (code === 0) return done(resolve)
      if (signal?.aborted) return done(() => reject(abortError()))
      if (code === null) {
        const text = stderr.trim()
        return done(() =>
          reject(new Error(text !== "" ? capReason(text) : "git did not answer in time")),
        )
      }
      // A failure carries the reason from git: the last of it may still be in flight, so wait
      // for the pipes, briefly, before the rejection. The bound is for a hook child that holds
      // a pipe after a failed git.
      const fail = () => {
        clearTimeout(pipeTimer)
        if (signal?.aborted) return done(() => reject(abortError()))
        const text = stderr.trim()
        done(() =>
          reject(new Error(text !== "" ? capReason(text) : `git exited with code ${code}`)),
        )
      }
      const pipeTimer = setTimeout(() => {
        child.stderr?.destroy()
        fail()
      }, 2000)
      if (child.stderr === null || child.stderr.readableEnded) return fail()
      child.stderr.once("end", fail)
      child.stderr.once("close", fail)
    })
    child.on("error", (e) => {
      const text = stderr.trim()
      done(() => reject(new Error(text !== "" ? capReason(text) : e.message)))
    })
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
  })
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

/**
 * Removes one half-made worktree: its folder and its own git entry, nothing else. The caller
 * has checked that the folder is this attempt's (it did not exist before it). A `git worktree
 * prune` would drop every stale entry, including the worktrees of the user (spec 007), so the
 * cleanup removes only the entry of this path. Best effort: it never throws, so the cleanup
 * cannot mask the failure that caused it.
 */
export const removeAttemptWorktree = async (repo: string, path: string): Promise<void> => {
  try {
    await runFile("git", ["-C", repo, "worktree", "remove", "--force", path], {
      timeout: 120_000,
      env: gitEnv(),
    })
    return
  } catch {
    // Not registered, or the folder is already gone: remove what is left below.
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Gone or unreadable: the entry below may still need to go.
  }
  await removeOwnWorktreeEntry(repo, path)
}

/** The path with links in its parent resolved, so two spellings of one folder compare equal. */
const keyOfWorktreePath = (path: string): string => {
  try {
    return join(realpathSync(dirname(path)), basename(path))
  } catch {
    return path
  }
}

/**
 * Deletes only the admin entry of `path` under `<git-common-dir>/worktrees/`: the entry whose
 * `gitdir` file points at `<path>/.git`. Every other entry stays, stale or not. Best effort:
 * it never throws.
 */
const removeOwnWorktreeEntry = async (repo: string, path: string): Promise<void> => {
  try {
    const { stdout } = await runFile("git", ["-C", repo, "rev-parse", "--git-common-dir"], {
      timeout: 30_000,
      env: gitEnv(),
    })
    const printed = stdout.trim()
    const dir = join(isAbsolute(printed) ? printed : join(repo, printed), "worktrees")
    const want = keyOfWorktreePath(path)
    for (const entry of readdirSync(dir)) {
      let content: string
      try {
        content = readFileSync(join(dir, entry, "gitdir"), "utf8").trim()
      } catch {
        continue
      }
      if (!isAbsolute(content) || basename(content) !== ".git") continue
      if (keyOfWorktreePath(dirname(content)) !== want) continue
      try {
        rmSync(join(dir, entry), { recursive: true, force: true })
      } catch {
        // Another cleanup won the entry, or it cannot be read: nothing else may go.
      }
    }
  } catch {
    // The common dir cannot be read: no entry is touched.
  }
}

/**
 * Deletes the planned branch of one attempt, only when (i) it did not exist before the attempt,
 * (ii) its tip still equals the commit the attempt created it from, and (iii) no worktree has
 * it checked out. A branch that cannot be verified stays. Best effort: it never throws.
 */
export const deleteAttemptBranch = async (
  repo: string,
  branch: string,
  existedBefore: boolean,
  baseCommit: string | null,
): Promise<void> => {
  try {
    if (existedBefore || baseCommit === null) return
    const { stdout: tipOut } = await runFile(
      "git",
      ["-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`],
      { timeout: 30_000, env: gitEnv() },
    )
    if (tipOut.trim() !== baseCommit) return
    const { stdout: listed } = await runFile(
      "git",
      ["-C", repo, "worktree", "list", "--porcelain"],
      {
        timeout: 30_000,
        env: gitEnv(),
      },
    )
    if (listed.split("\n").some((line) => line.trim() === `branch refs/heads/${branch}`)) return
    await runFile("git", ["-C", repo, "branch", "-D", branch], {
      timeout: 30_000,
      env: gitEnv(),
    })
  } catch {
    // Unverifiable or already gone: the branch stays.
  }
}

/** The commit that HEAD names, or null when git cannot tell (then no branch is deleted). */
export const headCommit = async (repo: string): Promise<string | null> => {
  try {
    const { stdout } = await runFile("git", ["-C", repo, "rev-parse", "HEAD"], {
      timeout: 30_000,
      env: gitEnv(),
    })
    const sha = stdout.trim()
    return sha !== "" ? sha : null
  } catch {
    return null
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

/**
 * True when git lists `path` as a worktree of its own repository. The main checkout counts.
 * False when git cannot tell, for example for a half-made worktree. The removal of a worktree
 * deletes the folder itself when the path is not registered, and keeps the failure otherwise.
 */
export const isWorktreeRegistered = async (path: string): Promise<boolean> => {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return false
  }
  try {
    const { stdout } = await runFile("git", ["-C", path, "worktree", "list", "--porcelain"], {
      timeout: 30_000,
      env: gitEnv(),
    })
    return stdout.split("\n").some((line) => {
      const listed = line.startsWith("worktree ") ? line.slice("worktree ".length).trim() : null
      if (!listed) return false
      try {
        return realpathSync(listed) === real
      } catch {
        return listed === path
      }
    })
  } catch {
    return false
  }
}

/**
 * The state of a branch: "exists", "missing" (git says no with exit code 1), or "unknown"
 * when git cannot be asked at all.
 */
const branchState = async (
  repo: string,
  branch: string,
): Promise<"exists" | "missing" | "unknown"> => {
  try {
    await runFile("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      timeout: 30_000,
      env: gitEnv(),
    })
    return "exists"
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code: unknown }).code
        : undefined
    return code === 1 ? "missing" : "unknown"
  }
}

/**
 * True when the repository has a branch of this name, or when git cannot tell: a failure reads
 * as exists, so the cleanup never deletes a branch it cannot verify (spec 007).
 */
export const branchExists = async (repo: string, branch: string): Promise<boolean> =>
  (await branchState(repo, branch)) !== "missing"

/**
 * The branch name with `-2` and up while the repository already holds the name: a leftover
 * branch from an aborted creation must not fail the next run (spec 007, "New worktree").
 */
export const uniqueBranch = async (repo: string, branch: string): Promise<string> => {
  let out = branch
  for (;;) {
    // Unknown (git cannot be asked) counts as free: the creation fails next with the reason
    // from git, instead of this loop spinning forever.
    if ((await branchState(repo, out)) !== "exists") return out
    // The counter `-2` and up sits after the stamp; the stamp itself is not a counter.
    const counter = /-\d{8}-\d{6}-(\d+)$/.exec(out)
    out =
      counter?.[1] !== undefined
        ? `${out.slice(0, -counter[1].length)}${Number(counter[1]) + 1}`
        : `${out}-2`
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
