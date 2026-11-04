import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { makeOwnedFolder, ownTempRoot, STALE_AFTER_MS, sweepStaleFolders } from "./stale-temp.ts"

const MINUTE = 60_000
const PREFIX = "robot-uploads-"

/** The number of a process that has ended: a short program prints its own number and ends. */
const deadPid = () => {
  const run = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" })
  const pid = Number(run.stdout.trim())
  expect(Number.isInteger(pid) && pid > 1).toBe(true)
  return pid
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "robot-stale-test-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A folder with a file in it, as old as `ageMs`. */
const folder = (name: string, ageMs: number, inside = root) => {
  const path = join(inside, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, "access.json"), "{}")
  const at = new Date(Date.now() - ageMs)
  utimesSync(path, at, at)
  return path
}

describe("the sweep of folders that a gone process left", () => {
  test("a folder of a process that runs stays, however old it is", () => {
    const mine = folder(`${PREFIX}${process.pid}-AbCdEf`, 5 * 60 * MINUTE)
    expect(sweepStaleFolders(PREFIX, { root })).toEqual([])
    expect(existsSync(mine)).toBe(true)
  })

  test("a process that the system will not let us look at runs: its folder stays", () => {
    // Process 1 belongs to the system. Looking at it is refused for a normal user (EPERM) and
    // allowed for the superuser: both mean that it runs.
    const system = folder(`${PREFIX}1-AbCdEf`, 5 * 60 * MINUTE)
    sweepStaleFolders(PREFIX, { root })
    expect(existsSync(system)).toBe(true)
  })

  test("a folder of a process that has ended and is old is removed with what is in it", () => {
    const gone = folder(`${PREFIX}${deadPid()}-AbCdEf`, 11 * MINUTE)
    expect(sweepStaleFolders(PREFIX, { root })).toEqual([gone])
    expect(existsSync(gone)).toBe(false)
  })

  test("a folder of a process that has ended but is young stays", () => {
    const young = folder(`${PREFIX}${deadPid()}-AbCdEf`, 2 * MINUTE)
    expect(sweepStaleFolders(PREFIX, { root })).toEqual([])
    expect(existsSync(young)).toBe(true)
  })

  test("the age limit is ten minutes, and a folder of exactly that age stays", () => {
    expect(STALE_AFTER_MS).toBe(10 * MINUTE)
    const now = Date.now()
    const edge = folder(`${PREFIX}${deadPid()}-AbCdEf`, 0)
    const at = new Date(now - STALE_AFTER_MS)
    utimesSync(edge, at, at)
    expect(sweepStaleFolders(PREFIX, { root, now })).toEqual([])
    expect(sweepStaleFolders(PREFIX, { root, now: now + 1000 })).toEqual([edge])
  })

  test("a folder of another prefix is never touched", () => {
    const pid = deadPid()
    const bridge = folder(`robot-bridge-${pid}-AbCdEf`, 60 * MINUTE)
    const uploads = folder(`${PREFIX}${pid}-AbCdEf`, 60 * MINUTE)
    expect(sweepStaleFolders(PREFIX, { root })).toEqual([uploads])
    expect(existsSync(bridge)).toBe(true)
    expect(sweepStaleFolders("robot-bridge-", { root })).toEqual([bridge])
  })

  test("a prefix that only starts like another one does not match it", () => {
    const pid = deadPid()
    const longer = folder(`robot-uploads-test-${pid}-AbCdEf`, 60 * MINUTE)
    expect(sweepStaleFolders(PREFIX, { root })).toEqual([])
    expect(existsSync(longer)).toBe(true)
  })

  test("a plain file and a link with a good name are never touched", () => {
    const pid = deadPid()
    const file = join(root, `${PREFIX}${pid}-AbCdEf`)
    writeFileSync(file, "x")
    const elsewhere = mkdtempSync(join(tmpdir(), "robot-stale-target-"))
    writeFileSync(join(elsewhere, "keep.txt"), "x")
    const link = join(root, `${PREFIX}${pid + 1}-AbCdEf`)
    symlinkSync(elsewhere, link)
    const old = new Date(Date.now() - 60 * MINUTE)
    utimesSync(file, old, old)
    try {
      expect(sweepStaleFolders(PREFIX, { root, alive: () => false })).toEqual([])
      expect(existsSync(file)).toBe(true)
      expect(existsSync(link)).toBe(true)
      expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test("a name that does not have the exact form is never touched", () => {
    const names = [
      `${PREFIX}abc-AbCdEf`,
      `${PREFIX}-AbCdEf`,
      `${PREFIX}123`,
      `${PREFIX}123-`,
      `${PREFIX}123-AbCdE`,
      `${PREFIX}123-AbCdEfG`,
      `${PREFIX}123-AbC.Ef`,
      `${PREFIX}123-AbCdEf.bak`,
      `${PREFIX}12 3-AbCdEf`,
      `${PREFIX}1e3-AbCdEf`,
      `${PREFIX}0-AbCdEf`,
      `${PREFIX}-5-AbCdEf`,
      `${PREFIX}99999999999-AbCdEf`,
      `${PREFIX}2147483648-AbCdEf`,
      `x${PREFIX}123-AbCdEf`,
      "robot-uploads",
      "other",
    ]
    const made = names.map((name) => folder(name, 60 * MINUTE))
    // Every one of them has an owner that is gone and is old, so only its name keeps it.
    expect(sweepStaleFolders(PREFIX, { root, alive: () => false })).toEqual([])
    for (const path of made) expect(existsSync(path)).toBe(true)
  })

  test("a folder that cannot be removed does not stop the sweep, and nothing throws", () => {
    const pid = deadPid()
    const stuck = folder(`${PREFIX}${pid}-AAAAAA`, 60 * MINUTE)
    const other = folder(`${PREFIX}${pid}-BBBBBB`, 60 * MINUTE)
    const tried: string[] = []
    const removed = sweepStaleFolders(PREFIX, {
      root,
      remove: (path) => {
        tried.push(path)
        if (path === stuck) throw new Error("EBUSY")
        rmSync(path, { recursive: true, force: true })
      },
    })
    expect(removed).toEqual([other])
    expect(tried.sort()).toEqual([stuck, other].sort())
    expect(existsSync(stuck)).toBe(true)
  })

  test("a folder to read that is not there gives nothing and does not throw", () => {
    expect(sweepStaleFolders(PREFIX, { root: join(root, "missing") })).toEqual([])
  })
})

describe("the folder of the app in the temporary folder", () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.TMPDIR
    process.env.TMPDIR = root
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  })

  test("it is made once, and only the user can enter it", () => {
    const made = ownTempRoot()
    expect(made).not.toBeNull()
    expect(dirname(made as string)).toBe(root)
    expect(ownTempRoot()).toBe(made)
    if (process.platform !== "win32") expect(statSync(made as string).mode & 0o777).toBe(0o700)
  })

  test.skipIf(process.platform === "win32")(
    "a link with that name is not used, and the folder is made in the temporary folder",
    () => {
      const uid = process.getuid?.()
      const elsewhere = mkdtempSync(join(tmpdir(), "robot-stale-target-"))
      symlinkSync(elsewhere, join(root, uid === undefined ? "robot-temp" : `robot-temp-${uid}`))
      try {
        expect(ownTempRoot()).toBeNull()
        const made = makeOwnedFolder("robot-fallback-link-")
        expect(dirname(made)).toBe(root)
        // Nothing went through the link.
        expect(existsSync(join(elsewhere, basename(made)))).toBe(false)
      } finally {
        rmSync(elsewhere, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(process.platform === "win32")(
    "a folder with that name that others can enter is not used",
    () => {
      const uid = process.getuid?.()
      const open = join(root, uid === undefined ? "robot-temp" : `robot-temp-${uid}`)
      mkdirSync(open)
      chmodSync(open, 0o755)
      expect(ownTempRoot()).toBeNull()
      expect(dirname(makeOwnedFolder("robot-fallback-open-"))).toBe(root)
    },
  )

  test("a folder that is made has the number of this process and a name that the sweep reads", () => {
    const made = makeOwnedFolder("robot-name-")
    expect(dirname(made)).toBe(ownTempRoot() as string)
    expect(basename(made)).toMatch(new RegExp(`^robot-name-${process.pid}-[A-Za-z0-9]{6}$`))
    if (process.platform !== "win32") expect(statSync(made).mode & 0o777).toBe(0o700)
    // If this process were gone and the folder old, the sweep would take it.
    const old = new Date(Date.now() - 60 * MINUTE)
    utimesSync(made, old, old)
    expect(
      sweepStaleFolders("robot-name-", { root: ownTempRoot() as string, alive: () => false }),
    ).toEqual([made])
  })

  test("the first folder of a prefix removes the old folders of a gone process, once", () => {
    const own = ownTempRoot() as string
    const first = folder(`robot-once-${deadPid()}-AAAAAA`, 60 * MINUTE, own)
    const live = folder(`robot-once-${process.pid}-AAAAAA`, 60 * MINUTE, own)
    const young = folder(`robot-once-${deadPid()}-BBBBBB`, MINUTE, own)
    const mine = makeOwnedFolder("robot-once-")
    expect(existsSync(first)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(mine)).toBe(true)
    // The sweep is a step of the start. A later folder does not read the folder again.
    const later = folder(`robot-once-${deadPid()}-CCCCCC`, 60 * MINUTE, own)
    makeOwnedFolder("robot-once-")
    expect(existsSync(later)).toBe(true)
  })
})
