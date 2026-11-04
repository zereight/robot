import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Temp folders of unit tests. A test that needs a folder in the temp folder of the system asks
 * for it here, with `tempDir`. The preload of the test runner (test-preload.ts) calls
 * `cleanUpTemp` after each test file (after the last file, in a run with no `--parallel`). It
 * first closes what the tests left open (see `afterTemp`), then removes the folders. A test needs
 * no clean-up code of its own.
 *
 * Why not remove at the end of the process: under `bun test --parallel` a worker process does not
 * run `exit` handlers, so a folder would stay. A folder of a test that keeps no clean-up code is a
 * leak in the temp folder of the user, and a temp folder with a million entries makes a program
 * that starts in it slow (a read of it takes seconds).
 *
 * The list is kept on `globalThis`, so the preload and the test file share it even when the test
 * runner loads the two as separate modules. Each process removes only the folders that it made,
 * so test files that run in parallel in other processes are not touched.
 */
type Entry = { dirs: string[]; closers: (() => unknown)[] }

const KEY = Symbol.for("robot.test-temp")
const entry = (): Entry => {
  const g = globalThis as { [KEY]?: Entry }
  g[KEY] ??= { dirs: [], closers: [] }
  return g[KEY]
}

/** The time that `cleanUpTemp` waits for the things that a test left open. */
const CLOSE_LIMIT_MS = 10_000

/** Makes a folder in the temp folder of the system. It goes after the last test of the file. */
export const tempDir = (prefix: string): string => trackTemp(mkdtempSync(join(tmpdir(), prefix)))

/** Removes a folder that a helper made, after the last test of the file. Returns the folder. */
export const trackTemp = (dir: string): string => {
  entry().dirs.push(dir)
  return dir
}

/**
 * Runs `close` after the last test of the file and before the folders go: a database must be
 * closed before its folder is removed. All closers start together, so they must not depend on one
 * another.
 */
export const afterTemp = (close: () => unknown): void => {
  entry().closers.push(close)
}

/**
 * Closes what was registered with `afterTemp`, then removes the folders of `tempDir`. A close or a
 * removal that fails does not fail the test, and it is not silent: a line on standard error names
 * the folder, and the folder stays so that the leak can be counted. Returns the folders that
 * stayed.
 */
export const cleanUpTemp = async (): Promise<string[]> => {
  const { dirs, closers } = entry()
  const closing = closers.splice(0)
  const stuck: string[] = []
  if (closing.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), CLOSE_LIMIT_MS)
    })
    const done = Promise.allSettled(closing.map((close) => Promise.resolve().then(close))).then(
      (results) => results.filter((r) => r.status === "rejected").length,
    )
    const outcome = await Promise.race([done, limit])
    clearTimeout(timer)
    if (outcome === "late")
      console.error(
        `test-temp: ${closing.length} close step(s) did not end in ${CLOSE_LIMIT_MS} ms`,
      )
    else if (outcome > 0) console.error(`test-temp: ${outcome} close step(s) failed`)
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch (error) {
      stuck.push(dir)
      console.error(`test-temp: could not remove ${dir}: ${(error as Error).message}`)
    }
  }
  return stuck
}
