import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The variable that holds the folder of this run, for the teardown. The teardown runs in the same
 * process, so it reads the folder from here and removes nothing else.
 */
export const RUN_ROOT = "ROBOT_E2E_RUN_ROOT"

/** The prefix of the folder of one run. The teardown only removes a folder with this prefix. */
export const RUN_ROOT_PREFIX = "robot-e2e-run-"

/**
 * One temporary folder for the whole run of the end-to-end tests, as `test-preload.ts` makes one
 * for each process of the unit tests. Before, every test left its data folder (about 8 MB), its
 * secrets file, its folders of stand-in programs and its own folders in the temporary folder of the
 * computer, and nothing removed them. This run makes one folder, points the three variables that
 * name the temporary folder at it, and the teardown removes it.
 *
 * Playwright starts the workers after the global setup, and a worker passes its environment to the
 * copies of the app that it starts (`launch` in `harness.ts` copies `process.env`). So the tests,
 * the helpers and the main process of each copy of the app all make their temporary folders
 * inside this one. That also catches a folder that the app itself leaves behind.
 *
 * A run that is killed (a second Ctrl-C, or a kill of the process) may not reach the teardown. It
 * then leaves this ONE folder, not thousands. Remove it by hand: its name starts with
 * `robot-e2e-run-`.
 *
 * Two things stay outside this folder on purpose:
 * - The cache of the Playwright code transform (`playwright-transform-cache-<user>`). Playwright
 *   picks it before it reads this file. It is one folder that every run reuses, so it does not grow.
 * - The short folder of `s33-island.spec.ts` (see there).
 */
export default function globalSetup() {
  const root = mkdtempSync(join(tmpdir(), RUN_ROOT_PREFIX))
  process.env[RUN_ROOT] = root
  for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = root
}
